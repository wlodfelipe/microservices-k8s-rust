use axum::{
    extract::{Path, Query, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{Auth, MaybeAuth};
use crate::compose::*;
use crate::Gw;

// ---------- usuários e perfis: repasse direto ----------

pub async fn register(State(gw): State<Gw>, Json(body): Json<Value>) -> Res {
    Ok(forward(call(&gw.users, Method::POST, "/users", None, Some(&body)).await?))
}

pub async fn login(State(gw): State<Gw>, Json(body): Json<Value>) -> Res {
    Ok(forward(call(&gw.users, Method::POST, "/users/login", None, Some(&body)).await?))
}

pub async fn current_user(State(gw): State<Gw>, auth: Auth) -> Res {
    Ok(forward(call(&gw.users, Method::GET, "/user", auth.id(), None).await?))
}

pub async fn update_user(State(gw): State<Gw>, auth: Auth, Json(body): Json<Value>) -> Res {
    Ok(forward(call(&gw.users, Method::PUT, "/user", auth.id(), Some(&body)).await?))
}

pub async fn profile(State(gw): State<Gw>, auth: MaybeAuth, Path(u): Path<String>) -> Res {
    Ok(forward(call(&gw.users, Method::GET, &format!("/profiles/{}", enc(&u)), auth.id(), None).await?))
}

pub async fn follow(State(gw): State<Gw>, auth: Auth, Path(u): Path<String>) -> Res {
    Ok(forward(call(&gw.users, Method::POST, &format!("/profiles/{}/follow", enc(&u)), auth.id(), None).await?))
}

pub async fn unfollow(State(gw): State<Gw>, auth: Auth, Path(u): Path<String>) -> Res {
    Ok(forward(call(&gw.users, Method::DELETE, &format!("/profiles/{}/follow", enc(&u)), auth.id(), None).await?))
}

// ---------- artigos ----------

#[derive(Deserialize)]
pub struct ListQuery {
    tag: Option<String>,
    author: Option<String>,
    favorited: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

/// username → id no `users`. `None` se não existe (a lista fica vazia, não é erro).
async fn user_id(gw: &Gw, username: &str) -> Res<Option<i64>> {
    let r = call(&gw.users, Method::GET, &format!("/internal/by-username/{}", enc(username)), None, None).await?;
    if r.status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    Ok(decode(&ok(r)?, "users")?["id"].as_i64())
}

fn empty_list() -> Response {
    Json(json!({ "articles": [], "articlesCount": 0 })).into_response()
}

async fn finish_list(gw: &Gw, r: platform::upstream::UpstreamResponse, viewer: Option<i64>) -> Res {
    let mut v = decode(&ok(r)?, "articles")?;
    if let Some(items) = v["articles"].as_array_mut() {
        with_authors(gw, items, viewer, true).await?;
    }
    Ok(Json(v).into_response())
}

pub async fn list_articles(State(gw): State<Gw>, auth: MaybeAuth, Query(q): Query<ListQuery>) -> Res {
    let mut params: Vec<String> = Vec::new();
    if let Some(t) = &q.tag {
        params.push(format!("tag={}", enc(t)));
    }
    // Resolve os filtros por username em paralelo.
    let (author, fav) = futures::join!(
        async { match &q.author { Some(a) => user_id(&gw, a).await.map(Some), None => Ok(None) } },
        async { match &q.favorited { Some(f) => user_id(&gw, f).await.map(Some), None => Ok(None) } },
    );
    match author? {
        Some(None) => return Ok(empty_list()),
        Some(Some(id)) => params.push(format!("author_id={id}")),
        None => {}
    }
    match fav? {
        Some(None) => return Ok(empty_list()),
        Some(Some(id)) => params.push(format!("favorited_by={id}")),
        None => {}
    }
    if let Some(l) = q.limit {
        params.push(format!("limit={l}"));
    }
    if let Some(o) = q.offset {
        params.push(format!("offset={o}"));
    }
    let path = format!("/articles?{}", params.join("&"));
    let r = call(&gw.articles, Method::GET, &path, auth.id(), None).await?;
    finish_list(&gw, r, auth.id()).await
}

pub async fn feed(State(gw): State<Gw>, auth: Auth, Query(q): Query<ListQuery>) -> Res {
    let r = ok(call(&gw.users, Method::GET, "/internal/following", auth.id(), None).await?)?;
    let ids = decode(&r, "users")?["ids"].clone();
    let body = json!({ "author_ids": ids, "limit": q.limit, "offset": q.offset });
    let r = call(&gw.articles, Method::POST, "/internal/feed", auth.id(), Some(&body)).await?;
    finish_list(&gw, r, auth.id()).await
}

async fn single_article(gw: &Gw, r: platform::upstream::UpstreamResponse, viewer: Option<i64>, status: StatusCode) -> Res {
    let mut v = decode(&ok(r)?, "articles")?;
    with_authors(gw, std::slice::from_mut(&mut v["article"]), viewer, true).await?;
    Ok(json_status(status, v))
}

pub async fn get_article(State(gw): State<Gw>, auth: MaybeAuth, Path(slug): Path<String>) -> Res {
    let r = call(&gw.articles, Method::GET, &format!("/articles/{}", enc(&slug)), auth.id(), None).await?;
    single_article(&gw, r, auth.id(), StatusCode::OK).await
}

pub async fn create_article(State(gw): State<Gw>, auth: Auth, Json(body): Json<Value>) -> Res {
    let r = call(&gw.articles, Method::POST, "/articles", auth.id(), Some(&body)).await?;
    single_article(&gw, r, auth.id(), StatusCode::CREATED).await
}

pub async fn update_article(State(gw): State<Gw>, auth: Auth, Path(slug): Path<String>, Json(body): Json<Value>) -> Res {
    let r = call(&gw.articles, Method::PUT, &format!("/articles/{}", enc(&slug)), auth.id(), Some(&body)).await?;
    single_article(&gw, r, auth.id(), StatusCode::OK).await
}

pub async fn delete_article(State(gw): State<Gw>, auth: Auth, Path(slug): Path<String>) -> Res {
    // Os comentários do artigo são apagados pelo `comments` quando ele recebe o evento
    // `article.deleted` (RabbitMQ). O gateway não precisa saber disso.
    ok(call(&gw.articles, Method::DELETE, &format!("/articles/{}", enc(&slug)), auth.id(), None).await?)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn favorite(State(gw): State<Gw>, auth: Auth, Path(slug): Path<String>) -> Res {
    let r = call(&gw.articles, Method::POST, &format!("/articles/{}/favorite", enc(&slug)), auth.id(), None).await?;
    single_article(&gw, r, auth.id(), StatusCode::OK).await
}

pub async fn unfavorite(State(gw): State<Gw>, auth: Auth, Path(slug): Path<String>) -> Res {
    let r = call(&gw.articles, Method::DELETE, &format!("/articles/{}/favorite", enc(&slug)), auth.id(), None).await?;
    single_article(&gw, r, auth.id(), StatusCode::OK).await
}

pub async fn tags(State(gw): State<Gw>) -> Res {
    Ok(forward(call(&gw.articles, Method::GET, "/tags", None, None).await?))
}

// ---------- comentários (degradam sem derrubar o resto) ----------

/// slug → id do artigo (e 404 da spec se não existe).
pub(crate) async fn article_id(gw: &Gw, slug: &str) -> Res<i64> {
    let r = ok(call(&gw.articles, Method::GET, &format!("/articles/{}", enc(slug)), None, None).await?)?;
    decode(&r, "articles")?["article"]["id"]
        .as_i64()
        .ok_or_else(|| platform::ApiError::internal().into_response())
}

pub async fn list_comments(State(gw): State<Gw>, auth: MaybeAuth, Path(slug): Path<String>) -> Res {
    let id = article_id(&gw, &slug).await?;
    let r = ok(call_comments(&gw, Method::GET, &format!("/articles/{id}/comments"), None, None).await?)?;
    let mut v = decode(&r, "comments")?;
    if let Some(items) = v["comments"].as_array_mut() {
        with_authors(&gw, items, auth.id(), false).await?;
    }
    Ok(Json(v).into_response())
}

pub async fn create_comment(State(gw): State<Gw>, auth: Auth, Path(slug): Path<String>, Json(body): Json<Value>) -> Res {
    let id = article_id(&gw, &slug).await?;
    let r = ok(call_comments(&gw, Method::POST, &format!("/articles/{id}/comments"), auth.id(), Some(&body)).await?)?;
    let mut v = decode(&r, "comments")?;
    with_authors(&gw, std::slice::from_mut(&mut v["comment"]), auth.id(), false).await?;
    Ok(json_status(StatusCode::CREATED, v))
}

pub async fn delete_comment(State(gw): State<Gw>, auth: Auth, Path((slug, cid)): Path<(String, String)>) -> Res {
    let id = article_id(&gw, &slug).await?;
    let Ok(cid) = cid.parse::<i64>() else {
        return Err(platform::ApiError::not_found("comment").into_response());
    };
    let r = call_comments(&gw, Method::DELETE, &format!("/articles/{id}/comments/{cid}"), auth.id(), None).await?;
    Ok(forward(r))
}
