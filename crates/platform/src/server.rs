//! Bootstrap HTTP comum: rotas de saúde, identidade, métricas e graceful shutdown.
//!
//! Ciclo de vida de um pod durante um rolling update:
//! 1. pod novo sobe, roda migrations, `/readyz` passa → entra no Service (e no DNS headless);
//! 2. pod antigo recebe o `preStop` (sleep no manifesto): continua atendendo enquanto o
//!    Kubernetes o tira dos endpoints e os clientes atualizam o DNS;
//! 3. chega o SIGTERM: `/readyz` passa a devolver 503 e o axum para de aceitar conexões,
//!    espera as requisições em andamento terminarem e o processo sai. Conexões longas
//!    (WebSocket) ouvem [`Runtime::stopping`] e se fecham sozinhas, para o navegador
//!    reconectar em outro pod.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{Request, State},
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use tower_http::catch_panic::CatchPanicLayer;

use crate::config::{env_or, Identity};
use crate::stats::{Stats, LIVE};
use tokio::sync::watch;

pub type ReadyCheck = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct Runtime {
    pub identity: Arc<Identity>,
    pub stats: Arc<Stats>,
    draining: Arc<AtomicBool>,
    stopping: watch::Sender<bool>,
    started: Instant,
    ready_check: Option<ReadyCheck>,
    served_by: HeaderValue,
    version: HeaderValue,
}

impl Runtime {
    pub fn new(service: &str) -> Self {
        let identity = Identity::from_env(service);
        let served_by = HeaderValue::from_str(&identity.pod).unwrap_or(HeaderValue::from_static("?"));
        let version = HeaderValue::from_str(&identity.version).unwrap_or(HeaderValue::from_static("?"));
        Self {
            identity: Arc::new(identity),
            stats: Arc::new(Stats::default()),
            draining: Arc::new(AtomicBool::new(false)),
            stopping: watch::Sender::new(false),
            started: Instant::now(),
            ready_check: None,
            served_by,
            version,
        }
    }

    /// Checagem extra de prontidão (ex.: `SELECT 1` no banco).
    pub fn with_ready_check<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = bool> + Send + 'static,
    {
        self.ready_check = Some(Arc::new(move || Box::pin(f())));
        self
    }

    /// Vira `true` no SIGTERM. Para tarefas que seguram conexões abertas (WebSocket).
    pub fn stopping(&self) -> watch::Receiver<bool> {
        self.stopping.subscribe()
    }

    /// Envolve as rotas do serviço com o que é comum a todos e sobe o servidor.
    pub async fn serve(self, app: Router) -> anyhow::Result<()> {
        let port: u16 = env_or("PORT", 8080);
        let ops = Router::new()
            .route("/healthz", get(|| async { "ok" }))
            .route("/readyz", get(readyz))
            .route("/info", get(info))
            .route("/stats", get(stats))
            .with_state(self.clone());

        let app = app
            .layer(middleware::from_fn_with_state(self.clone(), track))
            .merge(ops)
            .layer(CatchPanicLayer::new());

        let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
        tracing::info!(
            service = %self.identity.service,
            version = %self.identity.version,
            pod = %self.identity.pod,
            port,
            "servidor no ar"
        );
        let draining = self.draining.clone();
        let stopping = self.stopping.clone();
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown_signal().await;
                draining.store(true, Ordering::SeqCst);
                stopping.send_replace(true);
                tracing::info!("SIGTERM recebido: drenando requisições em andamento");
            })
            .await?;
        // O graceful shutdown do axum não acompanha conexões que viraram WebSocket: dá até
        // 2 s para elas mandarem o "close" antes de o processo sair.
        for _ in 0..20 {
            if LIVE.clients.load(Ordering::Relaxed) <= 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        tracing::info!("encerrado");
        Ok(())
    }
}

/// Middleware: conta a requisição e carimba quem respondeu (pod e versão).
async fn track(State(rt): State<Runtime>, req: Request, next: Next) -> Response {
    rt.stats.start();
    let t0 = Instant::now();
    let mut res = next.run(req).await;
    rt.stats.finish(t0.elapsed(), res.status().is_server_error());
    let h = res.headers_mut();
    h.insert("x-served-by", rt.served_by.clone());
    h.insert("x-service-version", rt.version.clone());
    res
}

async fn readyz(State(rt): State<Runtime>) -> Response {
    if rt.identity.broken {
        return (StatusCode::SERVICE_UNAVAILABLE, "versão com defeito (APP_BROKEN)").into_response();
    }
    if rt.draining.load(Ordering::SeqCst) {
        return (StatusCode::SERVICE_UNAVAILABLE, "drenando").into_response();
    }
    if let Some(check) = &rt.ready_check {
        let ok = tokio::time::timeout(Duration::from_secs(2), check()).await.unwrap_or(false);
        if !ok {
            return (StatusCode::SERVICE_UNAVAILABLE, "dependência indisponível").into_response();
        }
    }
    "ready".into_response()
}

async fn info(State(rt): State<Runtime>) -> Response {
    let mut res = Json(json!({
        "service": rt.identity.service,
        "version": rt.identity.version,
        "pod": rt.identity.pod,
        "node": rt.identity.node,
        "uptimeSecs": rt.started.elapsed().as_secs(),
    }))
    .into_response();
    res.headers_mut().insert("x-served-by", rt.served_by.clone());
    res.headers_mut().insert("x-service-version", rt.version.clone());
    res
}

async fn stats(State(rt): State<Runtime>) -> Json<serde_json::Value> {
    Json(json!({
        "service": rt.identity.service,
        "version": rt.identity.version,
        "pod": rt.identity.pod,
        "uptimeSecs": rt.started.elapsed().as_secs(),
        "stats": rt.stats.snapshot(),
        "bus": crate::stats::BUS.snapshot(),
        "live": LIVE.snapshot(),
    }))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}
