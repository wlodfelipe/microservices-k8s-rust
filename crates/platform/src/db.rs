//! Conexão com o Postgres e migrations no boot, com retry.
//!
//! Quando vários pods sobem juntos (deploy, restart do banco), o Postgres pode demorar a
//! aceitar conexões. Em vez de cair e depender do CrashLoopBackOff, o serviço tenta de novo
//! com backoff; enquanto isso a readiness continua falhando e ele não recebe tráfego.

use std::time::Duration;

use sqlx::{migrate::Migrator, postgres::PgPoolOptions, PgPool};

use crate::config;

pub async fn connect(migrator: &Migrator) -> anyhow::Result<PgPool> {
    let url = config::env_required("DATABASE_URL")?;
    let pool = PgPoolOptions::new()
        .max_connections(config::env_or("DB_MAX_CONNECTIONS", 10))
        .acquire_timeout(Duration::from_secs(3))
        .connect_lazy(&url)?;
    let mut wait = Duration::from_millis(500);
    for attempt in 1..=20 {
        match migrator.run(&pool).await {
            Ok(()) => return Ok(pool),
            Err(e) => {
                tracing::warn!(attempt, error = %e, "banco indisponível, tentando de novo");
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_secs(5));
            }
        }
    }
    anyhow::bail!("não foi possível conectar e migrar o banco")
}
