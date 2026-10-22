//! Serviço `comments`. É o serviço "descartável" da demo: o monitor pode zerar as réplicas
//! dele e o resto da aplicação continua no ar, só a área de comentários fica desativada.
//!
//! Eventos (RabbitMQ, via `platform::bus`): publica `comment.created`/`comment.deleted`
//! (o `articles` mantém o contador) e consome `article.deleted` (apaga os comentários).
//! Se ficar desligado, os `article.deleted` esperam na fila e são processados quando ele
//! voltar.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get},
    Json, Router,
};
use platform::{auth::AuthUser, bus, iso, server::Runtime, ApiError, ApiResult};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use time::OffsetDateTime;

#[derive(FromRow)]
struct CommentRow {
    id: i64,
    author_id: i64,
    body: String,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}

impl CommentRow {
    fn json(&self) -> Value {
        json!({
            "id": self.id,
            "body": self.body,
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
            "authorId": self.author_id,
        })
    }
}

const COLS: &str = "id, author_id, body, created_at, updated_at";

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
        .route("/articles/{article_id}/comments", get(list).post(create))
        .route("/articles/{article_id}/comments/{id}", delete(delete_one))
        .with_state(db.clone());

    bus::spawn_relay(db.clone(), "comments");
    bus::spawn_consumer(db.clone(), "comments.article-events", &["article.deleted"], on_article_deleted);

    Runtime::new("comments")
        .with_ready_check(move || {
            let db = db.clone();
            async move { sqlx::query("SELECT 1").execute(&db).await.is_ok() }
        })
        .serve(app)
        .await
}

async fn list(State(db): State<PgPool>, Path(article_id): Path<i64>) -> ApiResult<Json<Value>> {
    let rows: Vec<CommentRow> =
        sqlx::query_as(&format!("SELECT {COLS} FROM comments WHERE article_id = $1 ORDER BY created_at DESC, id DESC"))
            .bind(article_id)
            .fetch_all(&db)
            .await?;
    Ok(Json(json!({ "comments": rows.iter().map(CommentRow::json).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
struct CreateInput {
    comment: CommentBody,
}

#[derive(Deserialize)]
struct CommentBody {
    body: Option<String>,
}

async fn create(
    State(db): State<PgPool>,
    AuthUser(me): AuthUser,
    Path(article_id): Path<i64>,
    Json(input): Json<CreateInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let body = match input.comment.body {
        Some(b) if !b.trim().is_empty() => b,
        _ => return Err(ApiError::blank("body")),
    };
    let mut tx = db.begin().await?;
    let row: CommentRow = sqlx::query_as(&format!(
        "INSERT INTO comments (article_id, author_id, body) VALUES ($1, $2, $3) RETURNING {COLS}"
    ))
    .bind(article_id)
    .bind(me)
    .bind(&body)
    .fetch_one(&mut *tx)
    .await?;
    // O comentário inteiro vai no evento: o gateway repassa aos leitores do artigo sem
    // precisar consultar este serviço de novo.
    bus::enqueue(&mut tx, "comment.created", json!({ "articleId": article_id, "commentId": row.id, "comment": row.json() }))
        .await?;
    tx.commit().await?;
    bus::wake();
    Ok((StatusCode::CREATED, Json(json!({ "comment": row.json() }))))
}

async fn delete_one(
    State(db): State<PgPool>,
    AuthUser(me): AuthUser,
    Path((article_id, id)): Path<(i64, i64)>,
) -> ApiResult<StatusCode> {
    let owner: Option<(i64,)> = sqlx::query_as("SELECT author_id FROM comments WHERE id = $1 AND article_id = $2")
        .bind(id)
        .bind(article_id)
        .fetch_optional(&db)
        .await?;
    match owner {
        None => Err(ApiError::not_found("comment")),
        Some((author,)) if author != me => Err(ApiError::forbidden("comment")),
        Some(_) => {
            let mut tx = db.begin().await?;
            sqlx::query("DELETE FROM comments WHERE id = $1").bind(id).execute(&mut *tx).await?;
            bus::enqueue(&mut tx, "comment.deleted", json!({ "articleId": article_id, "commentId": id })).await?;
            tx.commit().await?;
            bus::wake();
            Ok(StatusCode::NO_CONTENT)
        }
    }
}

/// Consumidor de `article.deleted`. Idempotente por natureza, e ainda passa pelo inbox.
async fn on_article_deleted(ev: bus::Event, mut tx: bus::Tx) -> anyhow::Result<bus::Tx> {
    let article = ev.payload["articleId"].as_i64().ok_or_else(|| anyhow::anyhow!("evento sem articleId"))?;
    let n = sqlx::query("DELETE FROM comments WHERE article_id = $1").bind(article).execute(&mut *tx).await?.rows_affected();
    tracing::info!(article, apagados = n, "comentários do artigo apagado removidos");
    Ok(tx)
}
