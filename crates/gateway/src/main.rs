//! API Gateway / BFF: a única porta HTTP pública do backend (`/api/*`).
//!
//! - valida o JWT e repassa só o id do usuário para os serviços internos;
//! - compõe respostas: artigos e comentários guardam `authorId`, e o gateway troca pelo
//!   perfil do autor com uma consulta em lote ao `users`;
//! - comentários ao vivo: WebSocket por artigo, alimentado pelos eventos do RabbitMQ
//!   (ver `live.rs`);
//! - isola falhas: se o `comments` está fora, só a rota de comentários responde 503
//!   `{"errors":{"comments":["disabled"]}}`; o resto segue normal.
//!
//! Equivalente ao gateway "FrontApi" do tgclone, só que sem MediatR: cada rota é uma
//! função async que orquestra chamadas HTTP. O "pipeline" (auth, métricas, versão) são
//! extractors e layers do tower.

mod auth;
mod compose;
mod live;
mod meta;
mod routes;

use std::sync::Arc;
use std::time::Duration;

use axum::{
    routing::{get, post},
    Router,
};
use platform::{auth::Jwt, config, server::Runtime, upstream::Upstream};
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct Gw {
    pub users: Upstream,
    pub articles: Upstream,
    pub comments: Upstream,
    pub jwt: Jwt,
    pub rt: Runtime,
    pub hub: Arc<live::Hub>,
}

// mimalloc no lugar do malloc da glibc: devolve memória ao SO em vez de reter por thread.
// Com a glibc, o users (argon2, 8 MiB por hash) chegava a ~120 MiB e era morto pelo
// limite de memória do container sob carga.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    platform::telemetry::init();
    let timeout = Duration::from_millis(config::env_or("UPSTREAM_TIMEOUT_MS", 5000));
    let rt = Runtime::new("gateway");
    let gw = Gw {
        users: Upstream::new("users", &config::env_str("USERS_UPSTREAM", "127.0.0.1:8081"), timeout),
        articles: Upstream::new("articles", &config::env_str("ARTICLES_UPSTREAM", "127.0.0.1:8082"), timeout),
        comments: Upstream::new("comments", &config::env_str("COMMENTS_UPSTREAM", "127.0.0.1:8083"), timeout),
        jwt: Jwt::new(&config::env_required("JWT_SECRET")?),
        rt: rt.clone(),
        hub: Arc::default(),
    };

    // Sem AMQP_URL (dev sem RabbitMQ) o site funciona igual, só sem comentários ao vivo.
    if std::env::var("AMQP_URL").is_ok() {
        let gw = gw.clone();
        platform::amqp::spawn_subscriber(&["comment.*", "article.deleted"], move |kind, payload| {
            live::on_event(gw.clone(), kind, payload)
        });
    }

    use routes::*;
    let api = Router::new()
        .route("/users", post(register))
        .route("/users/login", post(login))
        .route("/user", get(current_user).put(update_user))
        .route("/profiles/{username}", get(profile))
        .route("/profiles/{username}/follow", post(follow).delete(unfollow))
        .route("/articles", get(list_articles).post(create_article))
        .route("/articles/feed", get(feed))
        .route("/articles/{slug}", get(get_article).put(update_article).delete(delete_article))
        .route("/articles/{slug}/favorite", post(favorite).delete(unfavorite))
        .route("/articles/{slug}/comments", get(list_comments).post(create_comment))
        .route("/articles/{slug}/comments/{id}", axum::routing::delete(delete_comment))
        .route("/articles/{slug}/live", get(live::live))
        .route("/tags", get(tags))
        .route("/_meta/versions", get(meta::versions))
        .route("/_meta/ping/{service}", get(meta::ping));

    let app = Router::new().nest("/api", api).layer(CorsLayer::permissive()).with_state(gw);
    rt.serve(app).await
}
