//! Comentários ao vivo: `GET /api/articles/{slug}/live` abre um WebSocket e o navegador
//! recebe os comentários novos (e apagados) daquele artigo sem recarregar a página.
//!
//! ```text
//! comments ─outbox→ RabbitMQ (comment.*) ─→ fila live.<pod> de CADA gateway ─→ salas
//!                                                                              └→ WebSockets
//! ```
//!
//! Cada pod do gateway recebe todos os eventos (fila própria, ver `platform::amqp`) e
//! guarda uma "sala" por artigo com os navegadores conectados *nele*. Um evento só custa
//! trabalho (compor o autor, serializar) se o pod tem alguém naquela sala.
//!
//! Em .NET seria um Hub do SignalR com grupos por artigo e backplane no RabbitMQ.

use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
};
use platform::stats::LIVE;
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch};

use crate::compose::{with_authors, Res};
use crate::routes::article_id;
use crate::Gw;

/// Mensagens que um navegador lento pode acumular antes de ser avisado para recarregar.
const ROOM_BUFFER: usize = 64;
/// Ping periódico: mantém a conexão viva no nginx e detecta navegador que sumiu.
const PING_EVERY: Duration = Duration::from_secs(25);

#[derive(Default)]
pub struct Hub {
    rooms: Mutex<HashMap<i64, broadcast::Sender<Arc<str>>>>,
}

impl Hub {
    fn join(&self, article: i64) -> broadcast::Receiver<Arc<str>> {
        let mut rooms = self.rooms.lock().unwrap();
        rooms.entry(article).or_insert_with(|| broadcast::channel(ROOM_BUFFER).0).subscribe()
    }

    /// Fecha a sala quando o último leitor sai (chamar depois de soltar o receiver).
    fn leave(&self, article: i64) {
        let mut rooms = self.rooms.lock().unwrap();
        if rooms.get(&article).is_some_and(|tx| tx.receiver_count() == 0) {
            rooms.remove(&article);
        }
    }

    fn has_readers(&self, article: i64) -> bool {
        self.rooms.lock().unwrap().get(&article).is_some_and(|tx| tx.receiver_count() > 0)
    }

    fn send(&self, article: i64, msg: Value) {
        let text: Arc<str> = msg.to_string().into();
        if let Some(tx) = self.rooms.lock().unwrap().get(&article) {
            let _ = tx.send(text);
        }
    }
}

/// Evento vindo do RabbitMQ → mensagem para a sala do artigo.
pub async fn on_event(gw: Gw, kind: String, payload: Value) {
    let Some(article) = payload["articleId"].as_i64() else { return };
    if !gw.hub.has_readers(article) {
        return;
    }
    let msg = match kind.as_str() {
        "comment.created" => {
            let mut comment = payload["comment"].clone();
            if comment.is_null() {
                return; // evento de uma versão antiga do comments, sem o comentário
            }
            // perfil do autor, como no GET de comentários (sem "following": é para todos)
            if with_authors(&gw, std::slice::from_mut(&mut comment), None, false).await.is_err() {
                return;
            }
            json!({ "type": "created", "comment": comment })
        }
        "comment.deleted" => json!({ "type": "deleted", "id": payload["commentId"] }),
        "article.deleted" => json!({ "type": "articleDeleted" }),
        _ => return,
    };
    gw.hub.send(article, msg);
}

pub async fn live(State(gw): State<Gw>, Path(slug): Path<String>, ws: WebSocketUpgrade) -> Res {
    let article = article_id(&gw, &slug).await?;
    let stopping = gw.rt.stopping();
    let pod = gw.rt.identity.pod.clone();
    Ok(ws.on_upgrade(move |socket| session(socket, gw, article, pod, stopping)))
}

/// Decrementa o contador de conectados mesmo se a tarefa terminar por erro.
struct Connected;

impl Connected {
    fn new() -> Self {
        LIVE.clients.fetch_add(1, Relaxed);
        Connected
    }
}

impl Drop for Connected {
    fn drop(&mut self) {
        LIVE.clients.fetch_sub(1, Relaxed);
    }
}

async fn session(mut socket: WebSocket, gw: Gw, article: i64, pod: String, mut stopping: watch::Receiver<bool>) {
    let _connected = Connected::new();
    let mut rx = gw.hub.join(article);
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;

    let hello = json!({ "type": "hello", "pod": pod, "broker": LIVE.connected.load(Relaxed) });
    if socket.send(Message::Text(hello.to_string().into())).await.is_ok() {
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    let text = match msg {
                        Ok(text) => text,
                        // ficou para trás: o navegador recarrega a lista inteira
                        Err(broadcast::error::RecvError::Lagged(_)) => Arc::from(r#"{"type":"resync"}"#),
                        Err(broadcast::error::RecvError::Closed) => break,
                    };
                    if socket.send(Message::Text(text.as_ref().into())).await.is_err() {
                        break;
                    }
                    LIVE.delivered.fetch_add(1, Relaxed);
                }
                _ = ping.tick() => {
                    if socket.send(Message::Ping(Default::default())).await.is_err() {
                        break;
                    }
                }
                incoming = socket.recv() => match incoming {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => {} // pong ou texto do cliente: ignorado
                },
                _ = stopping.changed() => {
                    // pod saindo (rolling update, HPA): 1012 = "service restart", o
                    // navegador reconecta e cai em outro pod
                    let frame = CloseFrame { code: 1012, reason: "pod encerrando".into() };
                    let _ = socket.send(Message::Close(Some(frame))).await;
                    break;
                }
            }
        }
    }
    drop(rx);
    gw.hub.leave(article);
}
