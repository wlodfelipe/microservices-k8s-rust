//! Mensageria com RabbitMQ: *outbox* na saída, *inbox* na entrada.
//!
//! Em .NET isso seria o MassTransit com `AddEntityFrameworkOutbox` + `UseInbox`. Aqui são
//! ~250 linhas explícitas:
//!
//! **Publicar** (`enqueue` + `spawn_relay`): o caso de uso grava o evento na tabela
//! `outbox` *na mesma transação* da mudança de estado (apagar o artigo, criar o
//! comentário). Ou as duas coisas acontecem, ou nenhuma. Um laço em segundo plano (o
//! *relay*) lê a outbox, publica no RabbitMQ com *publisher confirms* e só apaga a linha
//! depois que o broker confirmou que gravou a mensagem. Com o RabbitMQ fora do ar, a API
//! continua funcionando: os eventos acumulam na outbox e saem quando ele volta.
//!
//! **Consumir** (`spawn_consumer`): cada serviço tem sua fila durável, ligada ao exchange
//! `conduit.events` pelos tipos de evento que interessam. A entrega é *at-least-once*
//! (a mesma mensagem pode chegar duas vezes, ex.: o pod morre antes do ack). Por isso o
//! handler roda numa transação que também grava o `message_id` na tabela `inbox`: se o id
//! já existe, a mensagem é duplicada e é só confirmada. O ack vai depois do commit.
//!
//! Mensagem que não dá para processar (JSON inválido, erro de lógica repetido) vai para a
//! fila `conduit.dead` (dead-letter), em vez de travar a fila ou ser descartada em silêncio.
//! Erro de banco (indisponível) volta para a fila e é tentado de novo.

use std::future::Future;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Duration;

use futures::StreamExt;
use lapin::{
    options::{
        BasicAckOptions, BasicConsumeOptions, BasicNackOptions, BasicPublishOptions, BasicQosOptions,
        ConfirmSelectOptions, QueueBindOptions, QueueDeclareOptions,
    },
    types::{AMQPValue, FieldTable},
    BasicProperties, Channel,
};
use serde_json::Value;
use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use tokio::sync::Notify;

pub use crate::amqp::EXCHANGE;
use crate::amqp::{connect, declare_topology, forever, DEAD_EXCHANGE};
use crate::config;
use crate::stats::BUS;

/// Acorda o relay assim que uma transação com evento é confirmada (sem esperar o polling).
static WAKE: Notify = Notify::const_new();

pub type Tx = Transaction<'static, Postgres>;

/// Evento recebido da fila.
#[derive(Debug)]
pub struct Event {
    pub kind: String,
    pub message_id: String,
    pub payload: Value,
}

/// Grava um evento na outbox. Chame dentro da transação do caso de uso e, depois do
/// commit, chame [`wake`].
pub async fn enqueue(tx: &mut PgConnection, kind: &str, payload: Value) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO outbox (routing_key, payload) VALUES ($1, $2)")
        .bind(kind)
        .bind(payload)
        .execute(tx)
        .await?;
    Ok(())
}

pub fn wake() {
    WAKE.notify_one();
}

// ---------------------------------------------------------------- publicação

/// Laço que esvazia a outbox. Pode rodar em todas as réplicas: `FOR UPDATE SKIP LOCKED`
/// faz cada linha ser publicada por uma só.
pub fn spawn_relay(db: PgPool, service: &'static str) {
    BUS.enabled.store(true, Relaxed);
    // Tamanho da outbox para o monitor, medido à parte: é justamente com o RabbitMQ fora
    // do ar (relay desconectado) que ela cresce.
    let gauge_db = db.clone();
    tokio::spawn(async move {
        loop {
            if let Ok((n,)) = sqlx::query_as::<_, (i64,)>("SELECT count(*) FROM outbox").fetch_one(&gauge_db).await {
                BUS.outbox_pending.store(n, Relaxed);
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    forever("relay", &BUS.connected, move || relay_session(db.clone(), service));
}

async fn relay_session(db: PgPool, service: &'static str) -> anyhow::Result<()> {
    let conn = connect().await?;
    let ch = conn.create_channel().await?;
    declare_topology(&ch).await?;
    ch.confirm_select(ConfirmSelectOptions::default()).await?;
    BUS.connected.store(true, Relaxed);
    tracing::info!("relay da outbox conectado ao RabbitMQ");
    loop {
        let sent = publish_batch(&db, &ch, service).await?;
        if sent == 0 {
            if !conn.status().connected() {
                anyhow::bail!("conexão com o RabbitMQ caiu");
            }
            tokio::select! {
                _ = WAKE.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
        }
    }
}

async fn publish_batch(db: &PgPool, ch: &Channel, service: &str) -> anyhow::Result<usize> {
    let mut tx = db.begin().await?;
    let rows: Vec<(i64, String, Value, OffsetDateTime)> = sqlx::query_as(
        "SELECT id, routing_key, payload, created_at FROM outbox ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED",
    )
    .fetch_all(&mut *tx)
    .await?;
    if rows.is_empty() {
        return Ok(0);
    }
    let mut confirms = Vec::with_capacity(rows.len());
    for (id, kind, payload, created) in &rows {
        // O id da outbox + o instante de criação identificam a mensagem de forma estável:
        // se ela for publicada de novo (o commit abaixo falhou), o inbox do consumidor
        // reconhece a duplicata.
        let message_id = format!("{service}-{id}-{}", created.unix_timestamp_nanos() / 1000);
        let props = BasicProperties::default()
            .with_delivery_mode(2) // persistente: sobrevive a restart do broker
            .with_content_type("application/json".into())
            .with_message_id(message_id.into())
            .with_app_id(service.into())
            .with_timestamp(created.unix_timestamp() as u64);
        let body = serde_json::to_vec(payload)?;
        let confirm = ch
            .basic_publish(EXCHANGE.into(), kind.as_str().into(), BasicPublishOptions::default(), &body, props)
            .await?;
        confirms.push(confirm);
    }
    for c in confirms {
        if !c.await?.is_ack() {
            anyhow::bail!("RabbitMQ recusou a mensagem (nack)");
        }
    }
    let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    sqlx::query("DELETE FROM outbox WHERE id = ANY($1)").bind(&ids).execute(&mut *tx).await?;
    tx.commit().await?;
    BUS.published.fetch_add(rows.len() as u64, Relaxed);
    Ok(rows.len())
}

// ---------------------------------------------------------------- consumo

/// Consome a fila `queue` (criada se não existe), ligada a `EXCHANGE` por `bindings`
/// (padrões de topic, ex.: `comment.*`). Várias réplicas na mesma fila = consumidores
/// concorrentes: o RabbitMQ distribui as mensagens entre elas.
///
/// O `handler` recebe a transação já com o `message_id` gravado no inbox e a devolve para
/// o commit.
pub fn spawn_consumer<F, Fut>(db: PgPool, queue: &'static str, bindings: &'static [&'static str], handler: F)
where
    F: Fn(Event, Tx) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<Tx>> + Send,
{
    BUS.enabled.store(true, Relaxed);
    forever("consumer", &BUS.connected, move || consume_session(db.clone(), queue, bindings, handler.clone()));
}

enum Outcome {
    Done,
    Duplicate,
    /// Problema passageiro (banco fora): devolve para a fila.
    Retry(anyhow::Error),
    /// Não adianta tentar de novo: dead-letter.
    Dead(anyhow::Error),
}

async fn consume_session<F, Fut>(db: PgPool, queue: &'static str, bindings: &'static [&'static str], handler: F) -> anyhow::Result<()>
where
    F: Fn(Event, Tx) -> Fut,
    Fut: Future<Output = anyhow::Result<Tx>>,
{
    let conn = connect().await?;
    let ch = conn.create_channel().await?;
    declare_topology(&ch).await?;
    let mut args = FieldTable::default();
    args.insert("x-dead-letter-exchange".into(), AMQPValue::LongString(DEAD_EXCHANGE.into()));
    ch.queue_declare(queue.into(), QueueDeclareOptions { durable: true, ..Default::default() }, args).await?;
    for key in bindings {
        ch.queue_bind(queue.into(), EXCHANGE.into(), (*key).into(), QueueBindOptions::default(), FieldTable::default())
            .await?;
    }
    // No máximo 32 mensagens "em voo" por consumidor: o resto fica na fila (e pode ir
    // para outra réplica).
    ch.basic_qos(32, BasicQosOptions::default()).await?;
    let tag = config::env_str("POD_NAME", "local");
    let mut consumer = ch.basic_consume(queue.into(), tag.into(), BasicConsumeOptions::default(), FieldTable::default()).await?;
    BUS.connected.store(true, Relaxed);
    tracing::info!(queue, "consumindo fila");

    // Limpeza do inbox: ids com mais de 7 dias não vão mais chegar duplicados.
    let _ = sqlx::query("DELETE FROM inbox WHERE received_at < now() - interval '7 days'").execute(&db).await;

    while let Some(delivery) = consumer.next().await {
        let delivery = delivery?;
        let kind = delivery.routing_key.to_string();
        let message_id = delivery
            .properties
            .message_id()
            .as_ref()
            .map(|m| m.to_string())
            .unwrap_or_else(|| format!("sem-id-{}", delivery.delivery_tag));

        let outcome = match serde_json::from_slice::<Value>(&delivery.data) {
            Err(e) => Outcome::Dead(e.into()),
            Ok(payload) => handle(&db, Event { kind: kind.clone(), message_id: message_id.clone(), payload }, &handler).await,
        };

        match outcome {
            Outcome::Done => {
                BUS.consumed.fetch_add(1, Relaxed);
                delivery.ack(BasicAckOptions::default()).await?;
            }
            Outcome::Duplicate => {
                BUS.duplicates.fetch_add(1, Relaxed);
                delivery.ack(BasicAckOptions::default()).await?;
            }
            Outcome::Retry(e) => {
                tracing::warn!(error = %e, kind, message_id, "falha passageira, devolvendo para a fila");
                tokio::time::sleep(Duration::from_secs(1)).await;
                delivery.nack(BasicNackOptions { requeue: true, ..Default::default() }).await?;
            }
            Outcome::Dead(e) => {
                BUS.failed.fetch_add(1, Relaxed);
                tracing::error!(error = %e, kind, message_id, "mensagem enviada para a dead-letter");
                delivery.nack(BasicNackOptions { requeue: false, ..Default::default() }).await?;
            }
        }
    }
    anyhow::bail!("consumidor da fila {queue} foi cancelado")
}

async fn handle<F, Fut>(db: &PgPool, ev: Event, handler: &F) -> Outcome
where
    F: Fn(Event, Tx) -> Fut,
    Fut: Future<Output = anyhow::Result<Tx>>,
{
    let mut tx = match db.begin().await {
        Ok(tx) => tx,
        Err(e) => return Outcome::Retry(e.into()),
    };
    let inserted = sqlx::query("INSERT INTO inbox (message_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(&ev.message_id)
        .bind(&ev.kind)
        .execute(&mut *tx)
        .await;
    match inserted {
        Err(e) => return Outcome::Retry(e.into()),
        Ok(r) if r.rows_affected() == 0 => return Outcome::Duplicate,
        Ok(_) => {}
    }
    match handler(ev, tx).await {
        Ok(tx) => match tx.commit().await {
            Ok(()) => Outcome::Done,
            Err(e) => Outcome::Retry(e.into()),
        },
        Err(e) if is_transient(&e) => Outcome::Retry(e),
        Err(e) => Outcome::Dead(e),
    }
}

fn is_transient(e: &anyhow::Error) -> bool {
    matches!(
        e.downcast_ref::<sqlx::Error>(),
        Some(sqlx::Error::Io(_) | sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed | sqlx::Error::WorkerCrashed)
    )
}
