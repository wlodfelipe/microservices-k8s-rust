//! Serviço `users`: cadastro, login, perfil e "seguir". Dono das tabelas `users` e `follows`.
//! Não é exposto para fora do cluster: só o gateway chama.

mod handlers;
mod password;

use axum::{
    routing::{get, post},
    Router,
};
use platform::{auth::Jwt, config, server::Runtime};

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::PgPool,
    pub jwt: Jwt,
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

    let state = AppState { db: db.clone(), jwt: Jwt::new(&config::env_required("JWT_SECRET")?) };

    let app = Router::new()
        .route("/users", post(handlers::register))
        .route("/users/login", post(handlers::login))
        .route("/user", get(handlers::current).put(handlers::update))
        .route("/profiles/{username}", get(handlers::profile))
        .route("/profiles/{username}/follow", post(handlers::follow).delete(handlers::unfollow))
        .route("/internal/profiles", post(handlers::profiles_batch))
        .route("/internal/following", get(handlers::following_ids))
        .route("/internal/by-username/{username}", get(handlers::id_by_username))
        .with_state(state);

    Runtime::new("users")
        .with_ready_check(move || {
            let db = db.clone();
            async move { sqlx::query("SELECT 1").execute(&db).await.is_ok() }
        })
        .serve(app)
        .await
}
