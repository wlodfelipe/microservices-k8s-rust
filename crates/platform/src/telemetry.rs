use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Logs estruturados. `LOG_FORMAT=json` (padrão no cluster) ou `pretty` (local).
pub fn init() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn,sqlx=warn"));
    let json = std::env::var("LOG_FORMAT").map(|v| v != "pretty").unwrap_or(true);
    let registry = tracing_subscriber::registry().with(filter);
    if json {
        registry.with(fmt::layer().json().flatten_event(true).with_current_span(false)).init();
    } else {
        registry.with(fmt::layer().compact()).init();
    }
}
