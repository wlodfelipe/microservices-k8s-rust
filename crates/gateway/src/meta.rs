//! Rotas de diagnóstico usadas pelo front e pelo monitor.
//!
//! - `/api/_meta/versions`: versão em que cada serviço está respondendo agora (rodapé do site).
//! - `/api/_meta/ping/{svc}`: uma chamada a `/info` do serviço; o monitor chama em loop e
//!   desenha uma faixa de quadradinhos (cor = versão, vermelho = erro). Durante um rolling
//!   update dá para ver v1 e v2 respondendo juntas, sem nenhum vermelho.

use axum::{
    extract::{Path, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use platform::upstream::Upstream;
use serde_json::{json, Value};

use crate::Gw;

async fn info(up: &Upstream) -> Value {
    match up.call(Method::GET, "/info", None, None).await {
        Ok(r) if r.status.is_success() => {
            let mut v: Value = r.json(up.name()).unwrap_or(json!({}));
            v["ok"] = json!(true);
            v["endpoints"] = json!(up.endpoints().len());
            v
        }
        Ok(r) => json!({ "service": up.name(), "ok": false, "status": r.status.as_u16() }),
        Err(e) => json!({ "service": up.name(), "ok": false, "error": e.to_string(), "endpoints": 0 }),
    }
}

fn me(gw: &Gw) -> Value {
    let id = &gw.rt.identity;
    json!({ "service": id.service, "version": id.version, "pod": id.pod, "node": id.node, "ok": true })
}

pub async fn versions(State(gw): State<Gw>) -> Json<Value> {
    let (u, a, c) = tokio::join!(info(&gw.users), info(&gw.articles), info(&gw.comments));
    Json(json!({ "gateway": me(&gw), "users": u, "articles": a, "comments": c }))
}

pub async fn ping(State(gw): State<Gw>, Path(service): Path<String>) -> Response {
    let v = match service.as_str() {
        "gateway" => me(&gw),
        "users" => info(&gw.users).await,
        "articles" => info(&gw.articles).await,
        "comments" => info(&gw.comments).await,
        _ => return (StatusCode::NOT_FOUND, Json(json!({ "error": "serviço desconhecido" }))).into_response(),
    };
    let mut v = v;
    v["via"] = json!(gw.rt.identity.pod);
    // Sempre 200: "serviço fora" é a resposta do diagnóstico, não um erro do gateway
    // (senão os pings do monitor apareceriam como erros 5xx do gateway).
    Json(v).into_response()
}
