use std::sync::LazyLock;

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use tokio::sync::Semaphore;

/// Argon2id com custo moderado (8 MiB, 2 passadas): ~10 ms por hash. É o endpoint mais
/// pesado em CPU da aplicação, bom para ver o HPA do `users` reagir no teste de carga.
fn hasher() -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(8 * 1024, 2, 1, None).unwrap())
}

/// Cada hash aloca 8 MiB. Sem limite, uma rajada de 60 logins simultâneos alocaria ~480 MiB
/// e o pod (limite de 128 MiB) seria morto por falta de memória — aconteceu no teste de
/// carga. O semáforo limita os hashes em paralelo (`HASH_CONCURRENCY`, padrão 2 ≈ 1 CPU);
/// o excesso espera na fila, e a memória fica limitada (~16 MiB).
static HASH_SLOTS: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(platform::config::env_or("HASH_CONCURRENCY", 2)));

/// Roda fora do executor async (`spawn_blocking`) para não travar as outras requisições.
pub async fn hash(password: String) -> anyhow::Result<String> {
    let _slot = HASH_SLOTS.acquire().await?;
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        hasher()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| anyhow::anyhow!("hash: {e}"))
    })
    .await?
}

pub async fn verify(password: String, stored: String) -> bool {
    let Ok(_slot) = HASH_SLOTS.acquire().await else { return false };
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&stored)
            .map(|h| hasher().verify_password(password.as_bytes(), &h).is_ok())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}
