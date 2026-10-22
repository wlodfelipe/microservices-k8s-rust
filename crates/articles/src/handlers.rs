use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use platform::{
    auth::{AuthUser, Viewer},
    bus, iso, ApiError, ApiResult,
};
use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{FromRow, Postgres, QueryBuilder};
use time::OffsetDateTime;

use crate::AppState;

#[derive(FromRow)]
struct ArticleRow {
    id: i64,
    slug: String,
    title: String,
    description: String,
    body: String,
    tag_list: Vec<String>,
    author_id: i64,
    favorites_count: i32,
    comments_count: i32,
    favorited: bool,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}

impl ArticleRow {
    /// `authorId` no lugar de `author`: o gateway troca pelo perfil.
    fn json(&self, with_body: bool) -> Value {
        let mut v = json!({
            "id": self.id,
            "slug": self.slug,
            "title": self.title,
            "description": self.description,
            "tagList": self.tag_list,
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
            "favorited": self.favorited,
            "favoritesCount": self.favorites_count,
            // fora da spec: contador mantido por eventos do serviço comments
            "commentsCount": self.comments_count,
            "authorId": self.author_id,
        });
        if with_body {
            v["body"] = json!(self.body);
        }
        v
    }
}

const SELECT: &str = "SELECT a.id, a.slug, a.title, a.description, a.body, a.tag_list, a.author_id,
    a.favorites_count, a.comments_count, a.created_at, a.updated_at,
    EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = ";

#[derive(Deserialize)]
pub struct ListQuery {
    tag: Option<String>,
    author_id: Option<i64>,
    favorited_by: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
}

fn page(limit: Option<i64>, offset: Option<i64>) -> (i64, i64) {
    (limit.unwrap_or(20).clamp(0, 100), offset.unwrap_or(0).max(0))
}

/// Monta o filtro uma vez e usa para a página e para o total.
fn push_filters(qb: &mut QueryBuilder<'_, Postgres>, q: &ListQuery) {
    qb.push(" WHERE TRUE");
    if let Some(tag) = &q.tag {
        qb.push(" AND a.tag_list @> ARRAY[").push_bind(tag.clone()).push("]::text[]");
    }
    if let Some(author) = q.author_id {
        qb.push(" AND a.author_id = ").push_bind(author);
    }
    if let Some(user) = q.favorited_by {
        qb.push(" AND EXISTS (SELECT 1 FROM favorites fb WHERE fb.article_id = a.id AND fb.user_id = ")
            .push_bind(user)
            .push(")");
    }
}

pub async fn list(
    State(st): State<AppState>,
    Viewer(viewer): Viewer,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    let (limit, offset) = page(q.limit, q.offset);
    let mut qb = QueryBuilder::<Postgres>::new(SELECT);
    qb.push_bind(viewer.unwrap_or(0)).push(") AS favorited FROM articles a");
    push_filters(&mut qb, &q);
    qb.push(" ORDER BY a.created_at DESC, a.id DESC LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);
    let rows: Vec<ArticleRow> = qb.build_query_as().fetch_all(&st.db).await?;

    let mut cq = QueryBuilder::<Postgres>::new("SELECT count(*) FROM articles a");
    push_filters(&mut cq, &q);
    let (count,): (i64,) = cq.build_query_as().fetch_one(&st.db).await?;

    Ok(Json(json!({
        "articles": rows.iter().map(|a| a.json(false)).collect::<Vec<_>>(),
        "articlesCount": count,
    })))
}

#[derive(Deserialize)]
pub struct FeedInput {
    author_ids: Vec<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
}

/// Feed: artigos de quem o usuário segue. A lista de ids vem do gateway (que perguntou ao `users`).
pub async fn feed(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Json(input): Json<FeedInput>,
) -> ApiResult<Json<Value>> {
    let (limit, offset) = page(input.limit, input.offset);
    let sql = format!(
        "{SELECT}$1) AS favorited FROM articles a WHERE a.author_id = ANY($2)
         ORDER BY a.created_at DESC, a.id DESC LIMIT $3 OFFSET $4"
    );
    let rows: Vec<ArticleRow> = sqlx::query_as(&sql)
        .bind(me)
        .bind(&input.author_ids)
        .bind(limit)
        .bind(offset)
        .fetch_all(&st.db)
        .await?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM articles WHERE author_id = ANY($1)")
        .bind(&input.author_ids)
        .fetch_one(&st.db)
        .await?;
    Ok(Json(json!({
        "articles": rows.iter().map(|a| a.json(false)).collect::<Vec<_>>(),
        "articlesCount": count,
    })))
}

async fn load(st: &AppState, slug: &str, viewer: Option<i64>) -> ApiResult<ArticleRow> {
    let sql = format!("{SELECT}$2) AS favorited FROM articles a WHERE a.slug = $1");
    sqlx::query_as(&sql)
        .bind(slug)
        .bind(viewer.unwrap_or(0))
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| ApiError::not_found("article"))
}

pub async fn get(
    State(st): State<AppState>,
    Viewer(viewer): Viewer,
    Path(slug): Path<String>,
) -> ApiResult<Json<Value>> {
    let a = load(&st, &slug, viewer).await?;
    Ok(Json(json!({ "article": a.json(true) })))
}

#[derive(Deserialize)]
pub struct Envelope<T> {
    article: T,
}

#[derive(Deserialize)]
pub struct CreateInput {
    title: Option<String>,
    description: Option<String>,
    body: Option<String>,
    #[serde(rename = "tagList")]
    tag_list: Option<Vec<String>>,
}

fn required(field: &str, v: &Option<String>) -> ApiResult<String> {
    match v.as_deref() {
        Some(s) if !s.trim().is_empty() => Ok(s.to_string()),
        _ => Err(ApiError::blank(field)),
    }
}

/// Remove vazias e repetidas mantendo a ordem original.
fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// "Hello World!" → "hello-world-a1b2c3". O sufixo aleatório permite títulos repetidos.
fn slugify(title: &str) -> String {
    let mut s = String::new();
    for c in title.to_lowercase().chars() {
        if c.is_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s = s.trim_matches('-');
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(6)
        .map(|c| (c as char).to_ascii_lowercase())
        .collect();
    if s.is_empty() {
        suffix
    } else {
        format!("{}-{suffix}", s.chars().take(80).collect::<String>().trim_end_matches('-'))
    }
}

pub async fn create(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Json(Envelope { article }): Json<Envelope<CreateInput>>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let title = required("title", &article.title)?;
    let description = required("description", &article.description)?;
    let body = required("body", &article.body)?;
    let tags = clean_tags(article.tag_list.unwrap_or_default());
    let row: ArticleRow = sqlx::query_as(
        "INSERT INTO articles (slug, title, description, body, tag_list, author_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, slug, title, description, body, tag_list, author_id, favorites_count, comments_count,
                   created_at, updated_at, false AS favorited",
    )
    .bind(slugify(&title))
    .bind(&title)
    .bind(&description)
    .bind(&body)
    .bind(&tags)
    .bind(me)
    .fetch_one(&st.db)
    .await?;
    Ok((StatusCode::CREATED, Json(json!({ "article": row.json(true) }))))
}

#[derive(Deserialize)]
pub struct UpdateInput {
    #[serde(default, deserialize_with = "platform::double_option")]
    title: Option<Option<String>>,
    #[serde(default, deserialize_with = "platform::double_option")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "platform::double_option")]
    body: Option<Option<String>>,
    #[serde(rename = "tagList", default, deserialize_with = "platform::double_option")]
    tag_list: Option<Option<Vec<String>>>,
}

pub async fn update(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Path(slug): Path<String>,
    Json(Envelope { article }): Json<Envelope<UpdateInput>>,
) -> ApiResult<Json<Value>> {
    let mut a = load(&st, &slug, Some(me)).await?;
    if a.author_id != me {
        return Err(ApiError::forbidden("article"));
    }
    if let Some(v) = article.title {
        let t = required("title", &v)?;
        if t != a.title {
            a.slug = slugify(&t);
        }
        a.title = t;
    }
    if let Some(v) = article.description {
        a.description = required("description", &v)?;
    }
    if let Some(v) = article.body {
        a.body = required("body", &v)?;
    }
    match article.tag_list {
        Some(None) => return Err(ApiError::unprocessable("tagList", "can't be null")),
        Some(Some(t)) => a.tag_list = clean_tags(t),
        None => {}
    }
    let row: ArticleRow = sqlx::query_as(
        "UPDATE articles SET slug = $2, title = $3, description = $4, body = $5, tag_list = $6,
                updated_at = greatest(now(), updated_at + interval '1 millisecond')
         WHERE id = $1
         RETURNING id, slug, title, description, body, tag_list, author_id, favorites_count, comments_count,
                   created_at, updated_at, $7 AS favorited",
    )
    .bind(a.id)
    .bind(&a.slug)
    .bind(&a.title)
    .bind(&a.description)
    .bind(&a.body)
    .bind(&a.tag_list)
    .bind(a.favorited)
    .fetch_one(&st.db)
    .await?;
    Ok(Json(json!({ "article": row.json(true) })))
}

pub async fn delete(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Path(slug): Path<String>,
) -> ApiResult<Json<Value>> {
    let a = load(&st, &slug, Some(me)).await?;
    if a.author_id != me {
        return Err(ApiError::forbidden("article"));
    }
    // Apagar e avisar na mesma transação (outbox). O `comments` recebe `article.deleted`
    // pelo RabbitMQ e apaga os comentários, mesmo que esteja fora do ar agora.
    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM articles WHERE id = $1").bind(a.id).execute(&mut *tx).await?;
    bus::enqueue(&mut tx, "article.deleted", json!({ "articleId": a.id, "slug": a.slug })).await?;
    tx.commit().await?;
    bus::wake();
    Ok(Json(json!({ "deleted": { "id": a.id } })))
}

async fn set_favorite(st: &AppState, me: i64, slug: &str, on: bool) -> ApiResult<Json<Value>> {
    let a = load(st, slug, Some(me)).await?;
    let mut tx = st.db.begin().await?;
    let changed = if on {
        sqlx::query("INSERT INTO favorites (user_id, article_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
    } else {
        sqlx::query("DELETE FROM favorites WHERE user_id = $1 AND article_id = $2")
    }
    .bind(me)
    .bind(a.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed > 0 {
        sqlx::query("UPDATE articles SET favorites_count = favorites_count + $2 WHERE id = $1")
            .bind(a.id)
            .bind(if on { 1 } else { -1 })
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    let a = load(st, slug, Some(me)).await?;
    Ok(Json(json!({ "article": a.json(true) })))
}

pub async fn favorite(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Path(slug): Path<String>,
) -> ApiResult<Json<Value>> {
    set_favorite(&st, me, &slug, true).await
}

pub async fn unfavorite(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Path(slug): Path<String>,
) -> ApiResult<Json<Value>> {
    set_favorite(&st, me, &slug, false).await
}

/// Tags mais usadas (contagem mantida por trigger, ver migrations/0003_tag_counts.sql).
pub async fn tags(State(st): State<AppState>) -> ApiResult<Json<Value>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT tag FROM tag_counts WHERE n > 0 ORDER BY n DESC, tag LIMIT 100",
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(json!({ "tags": rows.into_iter().map(|r| r.0).collect::<Vec<_>>() })))
}

/// Consumidor de `comment.*`: mantém `comments_count`. Roda dentro da transação do inbox,
/// então cada evento conta uma vez só, mesmo se o RabbitMQ entregar de novo.
pub async fn on_comment_event(ev: bus::Event, mut tx: bus::Tx) -> anyhow::Result<bus::Tx> {
    let delta = match ev.kind.as_str() {
        "comment.created" => 1,
        "comment.deleted" => -1,
        other => anyhow::bail!("evento inesperado: {other}"),
    };
    let article = ev.payload["articleId"].as_i64().ok_or_else(|| anyhow::anyhow!("evento sem articleId"))?;
    // Artigo já apagado: 0 linhas, nada a fazer.
    sqlx::query("UPDATE articles SET comments_count = greatest(comments_count + $2, 0) WHERE id = $1")
        .bind(article)
        .bind(delta)
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
