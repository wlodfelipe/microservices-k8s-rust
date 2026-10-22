//! `ops`: o plano de controle da demonstração (backend da aba Monitor).
//!
//! Lê o estado do namespace no Kubernetes (deployments, pods, eventos, HPA, métricas),
//! coleta o tráfego de cada pod e executa as ações da demo: trocar versão (rolling
//! update), escalar (inclusive para 0), excluir pods, reiniciar e disparar o k6.
//! Também mostra o RabbitMQ (filas e taxas) e a outbox de cada serviço.

mod actions;
mod broker;
mod kube;
mod overview;
mod traffic;

use std::sync::{Arc, Mutex};

use axum::{
    routing::{delete, get, post},
    Router,
};
use platform::server::Runtime;

#[derive(Clone)]
pub struct Ops {
    pub kube: kube::Kube,
    pub traffic: traffic::Shared,
}

// mimalloc no lugar do malloc da glibc: devolve memória ao SO em vez de reter por thread.
// Com a glibc, o users (argon2, 8 MiB por hash) chegava a ~120 MiB e era morto pelo
// limite de memória do container sob carga.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    platform::telemetry::init();
    let kube = kube::Kube::from_env()?;
    let traffic: traffic::Shared = Arc::new(Mutex::new(traffic::Traffic::default()));
    traffic::spawn(kube.clone(), traffic.clone());
    let ops = Ops { kube, traffic };

    let api = Router::new()
        .route("/overview", get(overview::overview))
        .route("/deployments/{name}/version", post(actions::set_version))
        .route("/deployments/{name}/scale", post(actions::scale))
        .route("/deployments/{name}/restart", post(actions::restart))
        .route("/deployments/{name}/hpa/reset", post(actions::hpa_reset))
        .route("/deployments/{name}/pods", delete(actions::kill_pods))
        .route("/pods/{name}", delete(actions::delete_pod))
        .route("/k6", get(actions::k6_status).post(actions::k6_run).delete(actions::k6_stop))
        .with_state(ops);

    Runtime::new("ops").serve(Router::new().nest("/ops", api)).await
}
