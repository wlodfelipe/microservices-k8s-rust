//! Estado do RabbitMQ pela API HTTP de gestão (a mesma que a UI dele usa): filas,
//! mensagens prontas/em processamento, consumidores e taxas. Somado à outbox de cada
//! serviço (lida do `/stats` dos pods), mostra o caminho inteiro de um evento.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{json, Value};

static HTTP: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().timeout(Duration::from_millis(1500)).build().unwrap());

fn rate(v: &Value, key: &str) -> f64 {
    v["message_stats"][format!("{key}_details")]["rate"].as_f64().unwrap_or(0.0)
}

async fn get(path: &str) -> anyhow::Result<Value> {
    let base = platform::config::env_str("RABBITMQ_MGMT", "http://rabbitmq.socialclone.svc.cluster.local:15672");
    let user = platform::config::env_str("RABBITMQ_DEFAULT_USER", "guest");
    let pass = platform::config::env_str("RABBITMQ_DEFAULT_PASS", "guest");
    let res = HTTP.get(format!("{base}{path}")).basic_auth(user, Some(pass)).send().await?.error_for_status()?;
    Ok(res.json().await?)
}

/// `None` nos campos do broker quando ele está fora do ar (é uma das demos).
pub async fn snapshot() -> Value {
    let (overview, queues) = tokio::join!(get("/api/overview"), get("/api/queues/%2F"));
    let Ok(overview) = overview else {
        return json!({ "up": false });
    };
    let queues: Vec<Value> = queues
        .ok()
        .and_then(|q| q.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|q| {
            json!({
                "name": q["name"],
                "ready": q["messages_ready"].as_i64().unwrap_or(0),
                "unacked": q["messages_unacknowledged"].as_i64().unwrap_or(0),
                "consumers": q["consumers"].as_i64().unwrap_or(0),
                "publishRate": rate(q, "publish"),
                "deliverRate": rate(q, "deliver_get"),
                "ackRate": rate(q, "ack"),
            })
        })
        .collect();
    json!({
        "up": true,
        "version": overview["rabbitmq_version"],
        "publishRate": rate(&overview, "publish"),
        "deliverRate": rate(&overview, "deliver_get"),
        "connections": overview["object_totals"]["connections"],
        "queues": queues,
    })
}
