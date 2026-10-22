use std::collections::HashMap;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use platform::{
    auth::{AuthUser, Viewer},
    ApiError, ApiResult,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::FromRow;

use crate::{password, AppState};

#[derive(FromRow)]
struct UserRow {
    id: i64,
    username: String,
    email: String,
    password_hash: String,
    bio: Option<String>,
    image: Option<String>,
}

#[derive(FromRow)]
struct ProfileRow {
    id: i64,
    username: String,
    bio: Option<String>,
    image: Option<String>,
    following: bool,
}

impl ProfileRow {
    fn json(&self) -> Value {
        json!({ "username": self.username, "bio": self.bio, "image": self.image, "following": self.following })
    }
}

fn user_json(state: &AppState, u: &UserRow) -> Json<Value> {
    Json(json!({ "user": {
        "email": u.email,
        "token": state.jwt.sign(u.id, &u.username),
        "username": u.username,
        "bio": u.bio,
        "image": u.image,
    }}))
}

fn required(field: &str, v: &Option<String>) -> ApiResult<String> {
    match v.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(ApiError::blank(field)),
    }
}

/// Política NIST 800-63B (a mesma da suíte de testes da spec): mínimo 8, aceita longas.
fn check_password(p: &str) -> ApiResult<()> {
    if p.is_empty() {
        return Err(ApiError::blank("password"));
    }
    if p.chars().count() < 8 {
        return Err(ApiError::unprocessable("password", "is too short (minimum is 8 characters)"));
    }
    Ok(())
}

/// Converte violação de unique index no erro 409 que a spec pede.
fn unique_violation(e: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(db) = &e {
        if db.code().as_deref() == Some("23505") {
            let c = db.constraint().unwrap_or_default();
            return ApiError::taken(if c.contains("email") { "email" } else { "username" });
        }
    }
    e.into()
}

#[derive(Deserialize)]
pub struct Envelope<T> {
    user: T,
}

#[derive(Deserialize)]
pub struct RegisterInput {
    username: Option<String>,
    email: Option<String>,
    password: Option<String>,
}

pub async fn register(
    State(st): State<AppState>,
    Json(Envelope { user }): Json<Envelope<RegisterInput>>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let username = required("username", &user.username)?;
    let email = required("email", &user.email)?.to_lowercase();
    let pw = user.password.unwrap_or_default();
    if pw.is_empty() {
        return Err(ApiError::blank("password"));
    }
    // Checagem prévia para devolver o campo certo; o unique index continua sendo a garantia.
    let taken: Option<(bool, bool)> = sqlx::query_as(
        "SELECT coalesce(bool_or(username = $1), false), coalesce(bool_or(lower(email) = $2), false) FROM users WHERE username = $1 OR lower(email) = $2",
    )
    .bind(&username)
    .bind(&email)
    .fetch_optional(&st.db)
    .await?;
    if let Some((u, e)) = taken {
        if u {
            return Err(ApiError::taken("username"));
        }
        if e {
            return Err(ApiError::taken("email"));
        }
    }
    let hash = password::hash(pw).await?;
    let row: UserRow = sqlx::query_as(
        "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)
         RETURNING id, username, email, password_hash, bio, image",
    )
    .bind(&username)
    .bind(&email)
    .bind(&hash)
    .fetch_one(&st.db)
    .await
    .map_err(unique_violation)?;
    Ok((StatusCode::CREATED, user_json(&st, &row)))
}

#[derive(Deserialize)]
pub struct LoginInput {
    email: Option<String>,
    password: Option<String>,
}

pub async fn login(
    State(st): State<AppState>,
    Json(Envelope { user }): Json<Envelope<LoginInput>>,
) -> ApiResult<Json<Value>> {
    let email = required("email", &user.email)?.to_lowercase();
    let pw = user.password.unwrap_or_default();
    if pw.is_empty() {
        return Err(ApiError::blank("password"));
    }
    let row: Option<UserRow> = sqlx::query_as(
        "SELECT id, username, email, password_hash, bio, image FROM users WHERE lower(email) = $1",
    )
    .bind(&email)
    .fetch_optional(&st.db)
    .await?;
    let invalid = || ApiError::new(StatusCode::UNAUTHORIZED, "credentials", "invalid");
    let row = row.ok_or_else(invalid)?;
    if !password::verify(pw, row.password_hash.clone()).await {
        return Err(invalid());
    }
    Ok(user_json(&st, &row))
}

async fn load_user(st: &AppState, id: i64) -> ApiResult<UserRow> {
    sqlx::query_as("SELECT id, username, email, password_hash, bio, image FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(ApiError::token_invalid)
}

pub async fn current(State(st): State<AppState>, AuthUser(id): AuthUser) -> ApiResult<Json<Value>> {
    let u = load_user(&st, id).await?;
    Ok(user_json(&st, &u))
}

#[derive(Deserialize)]
pub struct UpdateInput {
    #[serde(default, deserialize_with = "platform::double_option")]
    email: Option<Option<String>>,
    #[serde(default, deserialize_with = "platform::double_option")]
    username: Option<Option<String>>,
    #[serde(default, deserialize_with = "platform::double_option")]
    password: Option<Option<String>>,
    #[serde(default, deserialize_with = "platform::double_option")]
    bio: Option<Option<String>>,
    #[serde(default, deserialize_with = "platform::double_option")]
    image: Option<Option<String>>,
}

pub async fn update(
    State(st): State<AppState>,
    AuthUser(id): AuthUser,
    Json(Envelope { user }): Json<Envelope<UpdateInput>>,
) -> ApiResult<Json<Value>> {
    let mut u = load_user(&st, id).await?;
    // email/username/password: se vierem, não podem ser vazios nem null.
    if let Some(v) = user.email {
        u.email = required("email", &v)?.to_lowercase();
    }
    if let Some(v) = user.username {
        u.username = required("username", &v)?;
    }
    if let Some(v) = user.password {
        let p = v.unwrap_or_default();
        check_password(&p)?;
        u.password_hash = password::hash(p).await?;
    }
    // bio/image aceitam null (limpa o campo); string vazia também vira null.
    if let Some(v) = user.bio {
        u.bio = v.filter(|s| !s.is_empty());
    }
    if let Some(v) = user.image {
        u.image = v.filter(|s| !s.is_empty());
    }
    let row: UserRow = sqlx::query_as(
        "UPDATE users SET email = $2, username = $3, password_hash = $4, bio = $5, image = $6, updated_at = now()
         WHERE id = $1 RETURNING id, username, email, password_hash, bio, image",
    )
    .bind(id)
    .bind(&u.email)
    .bind(&u.username)
    .bind(&u.password_hash)
    .bind(&u.bio)
    .bind(&u.image)
    .fetch_one(&st.db)
    .await
    .map_err(unique_violation)?;
    Ok(user_json(&st, &row))
}

const PROFILE_SQL: &str = "SELECT u.id, u.username, u.bio, u.image,
    EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followee_id = u.id) AS following
    FROM users u WHERE u.username = $1";

async fn load_profile(st: &AppState, username: &str, viewer: Option<i64>) -> ApiResult<ProfileRow> {
    sqlx::query_as(PROFILE_SQL)
        .bind(username)
        .bind(viewer.unwrap_or(0))
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| ApiError::not_found("profile"))
}

pub async fn profile(
    State(st): State<AppState>,
    Viewer(viewer): Viewer,
    Path(username): Path<String>,
) -> ApiResult<Json<Value>> {
    let p = load_profile(&st, &username, viewer).await?;
    Ok(Json(json!({ "profile": p.json() })))
}

pub async fn follow(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Path(username): Path<String>,
) -> ApiResult<Json<Value>> {
    let p = load_profile(&st, &username, Some(me)).await?;
    if p.id != me {
        sqlx::query("INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(me)
            .bind(p.id)
            .execute(&st.db)
            .await?;
    }
    let p = ProfileRow { following: p.id != me, ..p };
    Ok(Json(json!({ "profile": p.json() })))
}

pub async fn unfollow(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Path(username): Path<String>,
) -> ApiResult<Json<Value>> {
    let p = load_profile(&st, &username, Some(me)).await?;
    sqlx::query("DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2")
        .bind(me)
        .bind(p.id)
        .execute(&st.db)
        .await?;
    let p = ProfileRow { following: false, ..p };
    Ok(Json(json!({ "profile": p.json() })))
}

#[derive(Deserialize)]
pub struct BatchInput {
    ids: Vec<i64>,
}

/// Perfis de vários autores numa consulta só: o gateway usa para montar listas de
/// artigos e comentários sem fazer N chamadas.
pub async fn profiles_batch(
    State(st): State<AppState>,
    Viewer(viewer): Viewer,
    Json(input): Json<BatchInput>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<ProfileRow> = sqlx::query_as(
        "SELECT u.id, u.username, u.bio, u.image,
            EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followee_id = u.id) AS following
         FROM users u WHERE u.id = ANY($1)",
    )
    .bind(&input.ids)
    .bind(viewer.unwrap_or(0))
    .fetch_all(&st.db)
    .await?;
    let map: HashMap<String, Value> = rows.iter().map(|p| (p.id.to_string(), p.json())).collect();
    Ok(Json(json!({ "profiles": map })))
}

pub async fn following_ids(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    let ids: Vec<(i64,)> = sqlx::query_as("SELECT followee_id FROM follows WHERE follower_id = $1")
        .bind(me)
        .fetch_all(&st.db)
        .await?;
    Ok(Json(json!({ "ids": ids.into_iter().map(|r| r.0).collect::<Vec<_>>() })))
}

pub async fn id_by_username(State(st): State<AppState>, Path(username): Path<String>) -> ApiResult<Json<Value>> {
    let id: Option<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE username = $1")
        .bind(&username)
        .fetch_optional(&st.db)
        .await?;
    let id = id.ok_or_else(|| ApiError::not_found("profile"))?;
    Ok(Json(json!({ "id": id.0 })))
}
