//! Base comum de todos os microserviços.
//!
//! Em .NET isso seria um pacote com `AddPlatform()` + middlewares + MediatR behaviors.
//! Em Rust não há reflection nem container de DI: cada serviço monta o seu `Router`
//! explicitamente e passa um `State` tipado. O que é transversal (logs, métricas,
//! health, versão, graceful shutdown) entra como *layer* do tower, que é o equivalente
//! dos pipeline behaviors do MediatR, só que resolvido em tempo de compilação.

pub mod auth;
#[cfg(feature = "amqp")]
pub mod amqp;
#[cfg(feature = "bus")]
pub mod bus;
pub mod config;
#[cfg(feature = "db")]
pub mod db;
pub mod error;
pub mod server;
pub mod stats;
pub mod telemetry;
pub mod upstream;

pub use error::{ApiError, ApiResult};

/// Para PATCH/PUT: distingue campo ausente (`None`) de `null` explícito (`Some(None)`).
/// Use com `#[serde(default, deserialize_with = "platform::double_option")]`.
pub fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(d).map(Some)
}

/// Data no formato ISO 8601 que a spec espera (`2024-01-01T12:00:00.000Z`).
pub fn iso(t: time::OffsetDateTime) -> String {
    let t = t.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}
