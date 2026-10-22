//! Ações da demo. Todas são chamadas comuns da API do Kubernetes: o mesmo que
//! `kubectl set image`, `kubectl scale`, `kubectl rollout restart`, `kubectl delete pod`
//! e `kubectl create job`.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::Ops;

type R = Result<Json<Value>, (StatusCode, String)>;

fn bad(e: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, e.to_string())
}

fn upstream(e: anyhow::Error) -> (StatusCode, String) {
    (StatusCode::BAD_GATEWAY, e.to_string())
}

async fn deployment(ops: &Ops, name: &str) -> Result<Value, (StatusCode, String)> {
    ops.kube.get(&format!("{}/{name}", ops.kube.apps("deployments"))).await.map_err(upstream)
}

#[derive(Deserialize)]
pub struct VersionInput {
    version: String,
}

/// Troca a tag da imagem → o Deployment cria um ReplicaSet novo e faz o rolling update
/// (maxSurge 1, maxUnavailable 0: sempre há pods prontos atendendo).
pub async fn set_version(State(ops): State<Ops>, Path(name): Path<String>, Json(input): Json<VersionInput>) -> R {
    let d = deployment(&ops, &name).await?;
    let allowed: Vec<&str> = d["metadata"]["annotations"]["socialclone/versions"]
        .as_str()
        .map(|s| s.split(',').collect())
        .unwrap_or_default();
    if !allowed.contains(&input.version.as_str()) {
        return Err(bad(format!("versão {} não disponível para {name} ({allowed:?})", input.version)));
    }
    let container = &d["spec"]["template"]["spec"]["containers"][0];
    let image = container["image"].as_str().unwrap_or_default();
    let repo = image.rsplit_once(':').map(|(r, _)| r).unwrap_or(image);
    let new_image = format!("{repo}:{}", input.version);
    let patch = json!({ "spec": { "template": { "spec": { "containers": [
        { "name": container["name"], "image": new_image }
    ]}}}});
    ops.kube
        .strategic_patch(&format!("{}/{name}", ops.kube.apps("deployments")), &patch)
        .await
        .map_err(upstream)?;
    tracing::info!(deployment = %name, image = %new_image, "versão alterada");
    Ok(Json(json!({ "ok": true, "image": new_image })))
}

#[derive(Deserialize)]
pub struct ScaleInput {
    replicas: i64,
}

/// Escala o Deployment. Se houver HPA, ajusta o mínimo dele (senão o HPA desfaria a mudança).
/// Para 0 o HPA fica de fora: com o Deployment em 0 ele para de agir sozinho ("ScalingDisabled")
/// e volta a escalar quando o Deployment volta a ter réplicas.
pub async fn scale(State(ops): State<Ops>, Path(name): Path<String>, Json(input): Json<ScaleInput>) -> R {
    if !(0..=8).contains(&input.replicas) {
        return Err(bad("réplicas entre 0 e 8"));
    }
    let hpa_path = format!("/apis/autoscaling/v2/namespaces/{}/horizontalpodautoscalers/{name}", ops.kube.ns);
    if let (true, Ok(hpa)) = (input.replicas > 0, ops.kube.get(&hpa_path).await) {
        let max = hpa["spec"]["maxReplicas"].as_i64().unwrap_or(1).max(input.replicas);
        ops.kube
            .merge_patch(&hpa_path, &json!({ "spec": { "minReplicas": input.replicas, "maxReplicas": max } }))
            .await
            .map_err(upstream)?;
    }
    ops.kube
        .merge_patch(&format!("{}/{name}/scale", ops.kube.apps("deployments")), &json!({ "spec": { "replicas": input.replicas } }))
        .await
        .map_err(upstream)?;
    tracing::info!(deployment = %name, replicas = input.replicas, "escalado");
    Ok(Json(json!({ "ok": true })))
}

/// Devolve o HPA aos valores do manifesto (annotation `socialclone/default-min`): o mínimo
/// que os botões − / + mudaram volta ao original e o HPA decide o resto pela CPU.
pub async fn hpa_reset(State(ops): State<Ops>, Path(name): Path<String>) -> R {
    let hpa_path = format!("/apis/autoscaling/v2/namespaces/{}/horizontalpodautoscalers/{name}", ops.kube.ns);
    let hpa = ops.kube.get(&hpa_path).await.map_err(|_| bad(format!("{name} não tem HPA")))?;
    let min: i64 = hpa["metadata"]["annotations"]["socialclone/default-min"].as_str().and_then(|v| v.parse().ok()).unwrap_or(2);
    ops.kube.merge_patch(&hpa_path, &json!({ "spec": { "minReplicas": min } })).await.map_err(upstream)?;
    // se estava em 0, o HPA não age sozinho: volta o Deployment ao mínimo
    let dep = format!("{}/{name}", ops.kube.apps("deployments"));
    let current = ops.kube.get(&dep).await.map_err(upstream)?["spec"]["replicas"].as_i64().unwrap_or(0);
    if current < min {
        ops.kube.merge_patch(&format!("{dep}/scale"), &json!({ "spec": { "replicas": min } })).await.map_err(upstream)?;
    }
    tracing::info!(deployment = %name, min, "HPA devolvido ao padrão");
    Ok(Json(json!({ "ok": true, "min": min })))
}

/// Equivalente a `kubectl rollout restart`: muda uma annotation do template.
pub async fn restart(State(ops): State<Ops>, Path(name): Path<String>) -> R {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let patch = json!({ "spec": { "template": { "metadata": { "annotations": { "kubectl.kubernetes.io/restartedAt": now } } } } });
    ops.kube
        .strategic_patch(&format!("{}/{name}", ops.kube.apps("deployments")), &patch)
        .await
        .map_err(upstream)?;
    Ok(Json(json!({ "ok": true })))
}

/// Exclui todos os pods de um Deployment de uma vez (sem rolling). O ReplicaSet recria
/// na hora; durante alguns segundos o serviço fica sem pods prontos.
pub async fn kill_pods(State(ops): State<Ops>, Path(name): Path<String>) -> R {
    let pods = ops
        .kube
        .get(&format!("{}?labelSelector=app%3D{name}", ops.kube.core("pods")))
        .await
        .map_err(upstream)?;
    let mut killed = Vec::new();
    for p in pods["items"].as_array().into_iter().flatten() {
        if let Some(pn) = p["metadata"]["name"].as_str() {
            ops.kube.delete(&format!("{}/{pn}", ops.kube.core("pods"))).await.map_err(upstream)?;
            killed.push(pn.to_string());
        }
    }
    tracing::info!(deployment = %name, ?killed, "pods excluídos");
    Ok(Json(json!({ "ok": true, "killed": killed })))
}

pub async fn delete_pod(State(ops): State<Ops>, Path(name): Path<String>) -> R {
    ops.kube.delete(&format!("{}/{name}", ops.kube.core("pods"))).await.map_err(upstream)?;
    tracing::info!(pod = %name, "pod excluído");
    Ok(Json(json!({ "ok": true })))
}

// ---------------- k6 ----------------

#[derive(Deserialize)]
pub struct K6Input {
    vus: Option<u32>,
    duration: Option<String>,
    scenario: Option<String>,
}

const K6_LABEL: &str = "app%3Dk6";

/// Cria um Job com a imagem do k6 e o script do ConfigMap `k6-script`. O alvo é o `web`
/// (nginx), então a carga passa pelo mesmo caminho do navegador.
pub async fn k6_run(State(ops): State<Ops>, Json(input): Json<K6Input>) -> R {
    let vus = input.vus.unwrap_or(20).clamp(1, 500);
    let duration = input.duration.unwrap_or_else(|| "60s".into());
    if !duration.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(bad("duração inválida"));
    }
    let scenario = input.scenario.unwrap_or_else(|| "mixed".into());
    if !["mixed", "read", "write", "login"].contains(&scenario.as_str()) {
        return Err(bad("cenário inválido"));
    }
    k6_cleanup(&ops).await;
    let stamp = time::OffsetDateTime::now_utc().unix_timestamp();
    let job = json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": { "name": format!("k6-{stamp}"), "labels": { "app": "k6" } },
        "spec": {
            "backoffLimit": 0,
            "ttlSecondsAfterFinished": 1800,
            "template": {
                "metadata": { "labels": { "app": "k6" } },
                "spec": {
                    "restartPolicy": "Never",
                    "containers": [{
                        "name": "k6",
                        "image": std::env::var("K6_IMAGE").unwrap_or_else(|_| "docker.io/grafana/k6:1.0.0".into()),
                        "imagePullPolicy": "IfNotPresent",
                        "args": ["run", "--quiet", "--no-color", "/scripts/load.js"],
                        "env": [
                            { "name": "BASE_URL", "value": std::env::var("K6_TARGET").unwrap_or_else(|_| "http://web".into()) },
                            { "name": "VUS", "value": vus.to_string() },
                            { "name": "DURATION", "value": duration },
                            { "name": "SCENARIO", "value": scenario },
                        ],
                        "resources": {
                            "requests": { "cpu": "100m", "memory": "64Mi" },
                            "limits": { "cpu": "1", "memory": "512Mi" }
                        },
                        "volumeMounts": [{ "name": "script", "mountPath": "/scripts" }]
                    }],
                    "volumes": [{ "name": "script", "configMap": { "name": "k6-script" } }]
                }
            }
        }
    });
    ops.kube
        .post(&format!("/apis/batch/v1/namespaces/{}/jobs", ops.kube.ns), &job)
        .await
        .map_err(upstream)?;
    Ok(Json(json!({ "ok": true, "job": format!("k6-{stamp}") })))
}

async fn k6_cleanup(ops: &Ops) {
    let path = format!("/apis/batch/v1/namespaces/{}/jobs?labelSelector={K6_LABEL}", ops.kube.ns);
    if let Ok(jobs) = ops.kube.get(&path).await {
        for j in jobs["items"].as_array().into_iter().flatten() {
            if let Some(n) = j["metadata"]["name"].as_str() {
                let _ = ops
                    .kube
                    .delete(&format!("/apis/batch/v1/namespaces/{}/jobs/{n}?propagationPolicy=Background", ops.kube.ns))
                    .await;
            }
        }
    }
}

pub async fn k6_stop(State(ops): State<Ops>) -> R {
    k6_cleanup(&ops).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn k6_status(State(ops): State<Ops>) -> R {
    let jobs = ops
        .kube
        .get(&format!("/apis/batch/v1/namespaces/{}/jobs?labelSelector={K6_LABEL}", ops.kube.ns))
        .await
        .map_err(upstream)?;
    let mut items = jobs["items"].as_array().cloned().unwrap_or_default();
    items.sort_by_key(|j| j["metadata"]["creationTimestamp"].as_str().unwrap_or_default().to_string());
    let Some(job) = items.last() else {
        return Ok(Json(json!({ "job": null })));
    };
    let name = job["metadata"]["name"].as_str().unwrap_or_default();
    let st = &job["status"];
    let state = if st["succeeded"].as_i64().unwrap_or(0) > 0 {
        "Concluído"
    } else if st["failed"].as_i64().unwrap_or(0) > 0 {
        "Falhou"
    } else if st["active"].as_i64().unwrap_or(0) > 0 {
        "Rodando"
    } else {
        "Pendente"
    };
    let pods = ops
        .kube
        .get(&format!("{}?labelSelector=job-name%3D{name}", ops.kube.core("pods")))
        .await
        .unwrap_or(Value::Null);
    let pod = pods["items"].as_array().and_then(|a| a.first()).and_then(|p| p["metadata"]["name"].as_str()).map(String::from);
    let log = match &pod {
        Some(p) => ops
            .kube
            .get_text(&format!("{}/{p}/log?tailLines=80", ops.kube.core("pods")))
            .await
            .unwrap_or_default(),
        None => String::new(),
    };
    let env: Vec<Value> = job["spec"]["template"]["spec"]["containers"][0]["env"].as_array().cloned().unwrap_or_default();
    let env_of = |k: &str| env.iter().find(|e| e["name"] == k).map(|e| e["value"].clone()).unwrap_or(Value::Null);
    Ok(Json(json!({
        "job": name,
        "state": state,
        "startTime": st["startTime"],
        "completionTime": st["completionTime"],
        "vus": env_of("VUS"), "duration": env_of("DURATION"), "scenario": env_of("SCENARIO"),
        "pod": pod,
        "log": log,
    })))
}
