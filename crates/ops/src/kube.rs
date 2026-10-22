//! Cliente mínimo da API do Kubernetes (REST + JSON), sem SDK.
//!
//! Dentro do cluster usa o token e a CA do ServiceAccount montados no pod. Fora do cluster
//! (desenvolvimento) aponte `KUBE_API` para um `kubectl proxy` (`http://127.0.0.1:8001`).
//! As permissões vêm de um Role restrito ao namespace (ver `deploy/k8s/ops.yaml`).

use std::time::Duration;

use anyhow::{bail, Context};
use reqwest::{Method, StatusCode};
use serde_json::Value;

const SA_DIR: &str = "/var/run/secrets/kubernetes.io/serviceaccount";

#[derive(Clone)]
pub struct Kube {
    base: String,
    in_cluster: bool,
    client: reqwest::Client,
    pub ns: String,
}

impl Kube {
    pub fn from_env() -> anyhow::Result<Self> {
        let ns = std::env::var("NAMESPACE")
            .ok()
            .or_else(|| std::fs::read_to_string(format!("{SA_DIR}/namespace")).ok())
            .unwrap_or_else(|| "socialclone".into())
            .trim()
            .to_string();
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(10));
        let (base, in_cluster) = match (std::env::var("KUBE_API"), std::env::var("KUBERNETES_SERVICE_HOST")) {
            (Ok(api), _) => (api, false),
            (Err(_), Ok(host)) => {
                let port = std::env::var("KUBERNETES_SERVICE_PORT").unwrap_or_else(|_| "443".into());
                let ca = std::fs::read(format!("{SA_DIR}/ca.crt")).context("ca.crt do ServiceAccount")?;
                builder = builder.add_root_certificate(reqwest::Certificate::from_pem(&ca)?);
                (format!("https://{host}:{port}"), true)
            }
            _ => bail!("fora do cluster: defina KUBE_API (ex.: kubectl proxy → http://127.0.0.1:8001)"),
        };
        Ok(Self { base, in_cluster, client: builder.build()?, ns })
    }

    async fn request(&self, method: Method, path: &str, body: Option<(&str, &Value)>) -> anyhow::Result<Value> {
        let mut rb = self.client.request(method.clone(), format!("{}{}", self.base, path));
        if self.in_cluster {
            // O token projetado é renovado pelo kubelet: relê a cada chamada.
            let token = std::fs::read_to_string(format!("{SA_DIR}/token"))?;
            rb = rb.bearer_auth(token.trim());
        }
        if let Some((content_type, b)) = body {
            rb = rb.header("content-type", content_type).body(serde_json::to_vec(b)?);
        }
        let res = rb.send().await?;
        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            bail!("{method} {path} → {status}: {}", text.chars().take(300).collect::<String>());
        }
        if text.is_empty() || status == StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    pub async fn get(&self, path: &str) -> anyhow::Result<Value> {
        self.request(Method::GET, path, None).await
    }

    pub async fn get_text(&self, path: &str) -> anyhow::Result<String> {
        match self.get(path).await? {
            Value::String(s) => Ok(s),
            Value::Null => Ok(String::new()),
            other => Ok(other.to_string()),
        }
    }

    pub async fn merge_patch(&self, path: &str, body: &Value) -> anyhow::Result<Value> {
        self.request(Method::PATCH, path, Some(("application/merge-patch+json", body))).await
    }

    pub async fn strategic_patch(&self, path: &str, body: &Value) -> anyhow::Result<Value> {
        self.request(Method::PATCH, path, Some(("application/strategic-merge-patch+json", body))).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> anyhow::Result<Value> {
        self.request(Method::POST, path, Some(("application/json", body))).await
    }

    pub async fn delete(&self, path: &str) -> anyhow::Result<Value> {
        self.request(Method::DELETE, path, None).await
    }

    // caminhos usados com frequência
    pub fn apps(&self, kind: &str) -> String {
        format!("/apis/apps/v1/namespaces/{}/{kind}", self.ns)
    }
    pub fn core(&self, kind: &str) -> String {
        format!("/api/v1/namespaces/{}/{kind}", self.ns)
    }
}
