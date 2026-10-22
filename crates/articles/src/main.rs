//! Serviço `articles`: artigos, tags e favoritos. Guarda só o `author_id`; quem monta o
//! perfil do autor na resposta é o gateway (consulta em lote no `users`).

mod handlers;

use axum::{
    routing::{get, post},
    Router,
};
use platform::server::Runtime;

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::PgPool,
}

// mimalloc no lugar do malloc da glibc: devolve memória ao SO em vez de reter por thread.
// Com a glibc, o users (argon2, 8 MiB por hash) chegava a ~120 MiB e era morto pelo
// limite de memória do container sob carga.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    platform::telemetry::init();
    // Migrations embutidas no binário. Com várias réplicas subindo juntas, o sqlx usa
    // advisory lock do Postgres: só uma aplica, as outras esperam.
    let db = platform::db::connect(&sqlx::migrate!()).await?;

    let app = Router::new()
        .route("/articles", get(handlers::list).post(handlers::create))
        .route("/internal/feed", post(handlers::feed))
        .route("/articles/{slug}", get(handlers::get).put(handlers::update).delete(handlers::delete))
        .route("/articles/{slug}/favorite", post(handlers::favorite).delete(handlers::unfavorite))
        .route("/tags", get(handlers::tags))
        .with_state(AppState { db: db.clone() });

    // Mensageria: publica a outbox (article.deleted) e consome os eventos de comentários.
    platform::bus::spawn_relay(db.clone(), "articles");
    platform::bus::spawn_consumer(db.clone(), "articles.comment-events", &["comment.*"], handlers::on_comment_event);

    Runtime::new("articles")
        .with_ready_check(move || {
            let db = db.clone();
            async move { sqlx::query("SELECT 1").execute(&db).await.is_ok() }
        })
        .serve(app)
        .await
}
