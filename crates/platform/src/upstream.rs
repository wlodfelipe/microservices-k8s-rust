//! Cliente HTTP para outro microserviço, com balanceamento **por requisição** no cliente.
//!
//! O Service (ClusterIP) do Kubernetes balanceia *conexões*. Como o cliente reaproveita
//! conexões (keep-alive), na prática um pod receberia quase tudo. Aqui o gateway resolve o
//! Service *headless* (`<svc>-headless`), que devolve o IP de cada pod pronto, e faz
//! round-robin entre eles mantendo um pool de conexões por pod.
//!
//! - Pod que fica pronto entra no DNS e passa a receber tráfego em poucos segundos.
//! - Pod que está saindo (rolling update) sai do DNS antes do SIGTERM (graças ao `preStop`).
//! - Zero pods (deployment escalado para 0): o DNS não devolve nada e a chamada falha na
//!   hora com `Unavailable`, sem esperar timeout. É isso que permite o gateway responder
//!   "comentários desativados" instantaneamente.
//! - Falha de conexão → tenta o próximo pod (a requisição nem chegou a ser enviada).

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::http::{Method, StatusCode};
use axum::body::Bytes;
use serde::de::DeserializeOwned;

use crate::auth::USER_ID_HEADER;


#[derive(Debug, thiserror::Error)]
pub enum UpstreamError {
    #[error("{0}: nenhum pod disponível")]
    Unavailable(&'static str),
    #[error("{0}: falha de transporte: {1}")]
    Transport(&'static str, String),
    #[error("{0}: resposta inválida: {1}")]
    Decode(&'static str, String),
}

pub struct UpstreamResponse {
    pub status: StatusCode,
    pub body: Bytes,
    pub served_by: Option<String>,
    pub version: Option<String>,
}

impl UpstreamResponse {
    pub fn json<T: DeserializeOwned>(&self, name: &'static str) -> Result<T, UpstreamError> {
        serde_json::from_slice(&self.body).map_err(|e| UpstreamError::Decode(name, e.to_string()))
    }
}

#[derive(Clone)]
pub struct Upstream {
    inner: Arc<Inner>,
}

struct Inner {
    name: &'static str,
    host: String,
    port: u16,
    client: reqwest::Client,
    endpoints: RwLock<Arc<Vec<SocketAddr>>>,
    next: AtomicUsize,
}

impl Upstream {
    /// `target` no formato `host:porta`. No cluster o host é o Service headless
    /// (`comments-headless.socialclone.svc.cluster.local`); localmente, `127.0.0.1`.
    pub fn new(name: &'static str, target: &str, timeout: Duration) -> Self {
        let (host, port) = target.rsplit_once(':').expect("UPSTREAM no formato host:porta");
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(500))
            .timeout(timeout)
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(64)
            .tcp_nodelay(true)
            .build()
            .expect("reqwest client");
        let up = Self {
            inner: Arc::new(Inner {
                name,
                host: host.to_string(),
                port: port.parse().expect("porta"),
                client,
                endpoints: RwLock::new(Arc::new(Vec::new())),
                next: AtomicUsize::new(0),
            }),
        };
        let refresher = up.clone();
        tokio::spawn(async move {
            loop {
                refresher.refresh().await;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        up
    }

    pub fn name(&self) -> &'static str {
        self.inner.name
    }

    pub fn endpoints(&self) -> Arc<Vec<SocketAddr>> {
        self.inner.endpoints.read().unwrap().clone()
    }

    async fn refresh(&self) {
        let found = match tokio::net::lookup_host((self.inner.host.as_str(), self.inner.port)).await {
            Ok(addrs) => {
                let mut v: Vec<SocketAddr> = addrs.filter(|a| a.is_ipv4()).collect();
                v.sort();
                v.dedup();
                v
            }
            Err(_) => Vec::new(),
        };
        let mut cur = self.inner.endpoints.write().unwrap();
        if **cur != found {
            tracing::info!(upstream = self.inner.name, endpoints = ?found, "endpoints atualizados");
            *cur = Arc::new(found);
        }
    }

    /// Faz a chamada repassando o usuário autenticado (se houver) no header interno.
    pub async fn call(
        &self,
        method: Method,
        path: &str,
        user: Option<i64>,
        body: Option<&serde_json::Value>,
    ) -> Result<UpstreamResponse, UpstreamError> {
        let mut eps = self.endpoints();
        if eps.is_empty() {
            // Pode ser só o primeiro refresh ainda não ter rodado.
            self.refresh().await;
            eps = self.endpoints();
            if eps.is_empty() {
                return Err(UpstreamError::Unavailable(self.inner.name));
            }
        }
        let idempotent = method == Method::GET || method == Method::HEAD;
        let attempts = eps.len().min(3);
        let start = self.inner.next.fetch_add(1, Ordering::Relaxed);
        let mut last_err = String::new();
        for i in 0..attempts {
            let ep = eps[(start + i) % eps.len()];
            let url = format!("http://{ep}{path}");
            let mut rb = self.inner.client.request(method.clone(), &url);
            if let Some(uid) = user {
                rb = rb.header(USER_ID_HEADER, uid.to_string());
            }
            if let Some(b) = body {
                rb = rb.json(b);
            }
            match rb.send().await {
                Ok(res) => {
                    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                    let hdr = |n: &str| res.headers().get(n).and_then(|v| v.to_str().ok()).map(String::from);
                    let served_by = hdr("x-served-by");
                    let version = hdr("x-service-version");
                    let body = res
                        .bytes()
                        .await
                        .map_err(|e| UpstreamError::Transport(self.inner.name, e.to_string()))?;
                    return Ok(UpstreamResponse { status, body, served_by, version });
                }
                Err(e) => {
                    last_err = e.to_string();
                    // Só repete em outro pod se a requisição comprovadamente não foi enviada
                    // (erro de conexão) ou se é idempotente.
                    if !(e.is_connect() || idempotent) {
                        break;
                    }
                    tracing::warn!(upstream = self.inner.name, endpoint = %ep, error = %e, "tentando outro pod");
                }
            }
        }
        Err(UpstreamError::Transport(self.inner.name, last_err))
    }
}
