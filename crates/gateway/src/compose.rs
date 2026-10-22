//! Utilitários de orquestração: chamar serviços, repassar erros e montar autores.

use std::collections::{BTreeSet, HashMap};

use axum::{
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use platform::{
    upstream::{Upstream, UpstreamError, UpstreamResponse},
    ApiError,
};
use serde_json::{json, Value};

use crate::Gw;

/// Erros já viram `Response`: tanto os do próprio gateway quanto os que vieram de um serviço.
pub type Res<T = Response> = Result<T, Response>;

fn upstream_error(e: UpstreamError) -> Response {
    tracing::warn!(error = %e, "falha ao chamar serviço");
    match e {
        UpstreamError::Unavailable(name) | UpstreamError::Transport(name, _) | UpstreamError::Decode(name, _) => {
            ApiError::unavailable(name).into_response()
        }
    }
}

pub async fn call(up: &Upstream, method: Method, path: &str, user: Option<i64>, body: Option<&Value>) -> Res<UpstreamResponse> {
    up.call(method, path, user, body).await.map_err(upstream_error)
}

/// Repassa status e corpo do serviço como estão (os serviços já falam o formato da spec).
pub fn forward(r: UpstreamResponse) -> Response {
    let mut res = (r.status, r.body).into_response();
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

/// Erro do serviço (4xx/5xx) é devolvido ao cliente sem alteração.
pub fn ok(r: UpstreamResponse) -> Res<UpstreamResponse> {
    if r.status.is_client_error() || r.status.is_server_error() {
        Err(forward(r))
    } else {
        Ok(r)
    }
}

pub fn decode(r: &UpstreamResponse, name: &'static str) -> Res<Value> {
    r.json::<Value>(name).map_err(upstream_error)
}

pub fn json_status(status: StatusCode, v: Value) -> Response {
    (status, Json(v)).into_response()
}

/// Perfis em lote: `{ "12": {username, bio, image, following}, ... }`.
pub async fn profiles(gw: &Gw, ids: BTreeSet<i64>, viewer: Option<i64>) -> Res<HashMap<String, Value>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let body = json!({ "ids": ids });
    let r = ok(call(&gw.users, Method::POST, "/internal/profiles", viewer, Some(&body)).await?)?;
    let mut v = decode(&r, "users")?;
    Ok(serde_json::from_value(v["profiles"].take()).unwrap_or_default())
}

/// Troca `authorId` pelo objeto `author` em cada item. Remove o `id` interno de artigos.
pub async fn with_authors(gw: &Gw, items: &mut [Value], viewer: Option<i64>, drop_id: bool) -> Res<()> {
    let ids: BTreeSet<i64> = items.iter().filter_map(|i| i["authorId"].as_i64()).collect();
    let map = profiles(gw, ids, viewer).await?;
    for item in items.iter_mut() {
        let Some(obj) = item.as_object_mut() else { continue };
        let author = obj
            .remove("authorId")
            .and_then(|id| map.get(&id.to_string()).cloned())
            .unwrap_or_else(|| json!({ "username": "desconhecido", "bio": null, "image": null, "following": false }));
        obj.insert("author".into(), author);
        if drop_id {
            obj.remove("id");
        }
    }
    Ok(())
}

/// Resposta de comentários quando o serviço está fora: 503 com motivo explícito, para o
/// front mostrar "Comentários desativados" em vez de erro genérico.
pub fn comments_disabled() -> Response {
    let mut res = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "comments", "disabled").into_response();
    res.headers_mut().insert("x-comments-disabled", HeaderValue::from_static("1"));
    res
}

pub async fn call_comments(gw: &Gw, method: Method, path: &str, user: Option<i64>, body: Option<&Value>) -> Res<UpstreamResponse> {
    match gw.comments.call(method, path, user, body).await {
        Ok(r) if r.status == StatusCode::SERVICE_UNAVAILABLE || r.status == StatusCode::BAD_GATEWAY => Err(comments_disabled()),
        Ok(r) => Ok(r),
        Err(e) => {
            tracing::warn!(error = %e, "comments indisponível: degradando");
            Err(comments_disabled())
        }
    }
}

pub fn enc(s: &str) -> String {
    // Slugs e usernames vão no path; escapa o mínimo necessário.
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
