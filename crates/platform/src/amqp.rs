//! Conexão com o RabbitMQ, comum à mensageria com banco ([`crate::bus`]) e aos
//! assinantes sem banco, como o gateway repassando eventos para os navegadores.
//!
//! [`spawn_subscriber`] é o modo *broadcast*: cada pod cria uma fila só dele (exclusiva,
//! apagada quando a conexão cai) e recebe **todas** as mensagens dos tipos assinados. É o
//! oposto das filas duráveis do `bus`, em que as réplicas dividem as mensagens entre si.
//! Em .NET, é o papel do *backplane* do SignalR (com RabbitMQ no lugar do Redis).

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::time::Duration;

use futures::StreamExt;
use lapin::{
    options::{BasicConsumeOptions, ExchangeDeclareOptions, QueueBindOptions, QueueDeclareOptions},
    types::{AMQPValue, FieldTable},
    Channel, Connection, ConnectionProperties, ExchangeKind,
};
use serde_json::Value;

use crate::config;
use crate::stats::LIVE;

/// Exchange do tipo *topic*: a routing key é o tipo do evento (`article.deleted`, ...).
pub const EXCHANGE: &str = "conduit.events";
pub(crate) const DEAD_EXCHANGE: &str = "conduit.dlx";
const DEAD_QUEUE: &str = "conduit.dead";

fn url() -> anyhow::Result<String> {
    config::env_required("AMQP_URL")
}

pub(crate) async fn connect() -> anyhow::Result<Connection> {
    let name = config::env_str("POD_NAME", "local");
    let props = ConnectionProperties::default().with_connection_name(name.into());
    Ok(Connection::connect(&url()?, props).await?)
}

/// Exchange de eventos, dead-letter e a fila de mortas. Declarar é idempotente: todos
/// os serviços declaram no boot e quem chegar primeiro cria.
pub(crate) async fn declare_topology(ch: &Channel) -> lapin::Result<()> {
    let durable = ExchangeDeclareOptions { durable: true, ..Default::default() };
    ch.exchange_declare(EXCHANGE.into(), ExchangeKind::Topic, durable, FieldTable::default()).await?;
    ch.exchange_declare(DEAD_EXCHANGE.into(), ExchangeKind::Fanout, durable, FieldTable::default()).await?;
    ch.queue_declare(DEAD_QUEUE.into(), QueueDeclareOptions { durable: true, ..Default::default() }, FieldTable::default())
        .await?;
    ch.queue_bind(DEAD_QUEUE.into(), DEAD_EXCHANGE.into(), "".into(), QueueBindOptions::default(), FieldTable::default())
        .await?;
    Ok(())
}

/// Reconecta para sempre, com backoff. `session` só retorna em caso de erro.
pub(crate) fn forever<F, Fut>(what: &'static str, connected: &'static AtomicBool, session: F)
where
    F: Fn() -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send,
{
    tokio::spawn(async move {
        let mut wait = Duration::from_millis(500);
        loop {
            let started = tokio::time::Instant::now();
            if let Err(e) = session().await {
                connected.store(false, Relaxed);
                tracing::warn!(error = %e, what, "RabbitMQ indisponível, reconectando");
            }
            if started.elapsed() > Duration::from_secs(30) {
                wait = Duration::from_millis(500);
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(5));
        }
    });
}

/// Assina os eventos de `bindings` (padrões de topic, ex.: `comment.*`) numa fila própria
/// deste pod, `live.<pod>`. Sem ack e sem inbox: é notificação ao vivo, não processamento.
/// Se o pod perde alguma (RabbitMQ fora, reconexão), quem está na tela recarrega a lista.
pub fn spawn_subscriber<F, Fut>(bindings: &'static [&'static str], handler: F)
where
    F: Fn(String, Value) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send,
{
    LIVE.enabled.store(true, Relaxed);
    forever("subscriber", &LIVE.connected, move || subscribe_session(bindings, handler.clone()));
}

async fn subscribe_session<F, Fut>(bindings: &'static [&'static str], handler: F) -> anyhow::Result<()>
where
    F: Fn(String, Value) -> Fut,
    Fut: Future<Output = ()>,
{
    let conn = connect().await?;
    let ch = conn.create_channel().await?;
    declare_topology(&ch).await?;
    let queue = format!("live.{}", config::env_str("POD_NAME", "local"));
    // Teto de 1000 mensagens: se o pod travar, as mais antigas são descartadas em vez de
    // a fila crescer sem limite.
    let mut args = FieldTable::default();
    args.insert("x-max-length".into(), AMQPValue::LongInt(1000));
    let opts = QueueDeclareOptions { exclusive: true, auto_delete: true, ..Default::default() };
    ch.queue_declare(queue.as_str().into(), opts, args).await?;
    for key in bindings {
        ch.queue_bind(queue.as_str().into(), EXCHANGE.into(), (*key).into(), QueueBindOptions::default(), FieldTable::default())
            .await?;
    }
    let consume = BasicConsumeOptions { no_ack: true, exclusive: true, ..Default::default() };
    let mut consumer = ch.basic_consume(queue.as_str().into(), queue.as_str().into(), consume, FieldTable::default()).await?;
    LIVE.connected.store(true, Relaxed);
    tracing::info!(queue, "assinando eventos ao vivo");

    while let Some(delivery) = consumer.next().await {
        let delivery = delivery?;
        LIVE.events.fetch_add(1, Relaxed);
        match serde_json::from_slice::<Value>(&delivery.data) {
            Ok(payload) => handler(delivery.routing_key.to_string(), payload).await,
            Err(e) => tracing::warn!(error = %e, "evento ao vivo com JSON inválido, ignorado"),
        }
    }
    anyhow::bail!("assinatura da fila {queue} foi cancelada")
}
