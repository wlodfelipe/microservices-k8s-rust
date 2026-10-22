use std::str::FromStr;

/// Lê uma variável de ambiente ou devolve o padrão. Configuração vem de ConfigMap/Secret.
pub fn env_or<T: FromStr>(key: &str, default: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

pub fn env_str(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub fn env_required(key: &str) -> anyhow::Result<String> {
    std::env::var(key).map_err(|_| anyhow::anyhow!("variável de ambiente {key} é obrigatória"))
}

/// Identidade do processo: aparece em `/info`, nos headers `x-served-by` / `x-service-version`
/// e no monitor. `APP_VERSION` vem da imagem (cada tag v1, v2, v3 é uma imagem diferente),
/// `POD_NAME` / `NODE_NAME` vêm da Downward API do Kubernetes.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Identity {
    pub service: String,
    pub version: String,
    pub pod: String,
    pub node: String,
    /// v3 é uma versão "com defeito" de propósito: a readiness nunca passa.
    pub broken: bool,
}

impl Identity {
    pub fn from_env(service: &str) -> Self {
        // A variável de ambiente tem prioridade; senão vale o que a imagem gravou em
        // /app/build-info (ver deploy/docker/rust.Dockerfile).
        let info = std::fs::read_to_string("/app/build-info").unwrap_or_default();
        let from_info = |key: &str| {
            info.lines()
                .find_map(|l| l.strip_prefix(key)?.strip_prefix('=').map(|v| v.trim().to_string()))
        };
        let get = |key: &str, default: &str| {
            std::env::var(key).ok().or_else(|| from_info(key)).unwrap_or_else(|| default.to_string())
        };
        Self {
            service: service.to_string(),
            version: get("APP_VERSION", "dev"),
            pod: env_str("POD_NAME", &hostname()),
            node: env_str("NODE_NAME", "local"),
            broken: get("APP_BROKEN", "false") == "true",
        }
    }
}

fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "local".into())
}
