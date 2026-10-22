//! Coleta `/stats` de cada pod de backend a cada 2 s e calcula req/s, erros e p95 por pod
//! e por serviço. É o que mostra o balanceamento de carga no monitor.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::kube::Kube;

const HISTORY: usize = 90; // 3 minutos de pontos de 2 s
const SCALE_HISTORY: usize = 120; // 20 minutos de pontos de 10 s

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodTraffic {
    pub rps: f64,
    pub errors_per_sec: f64,
    pub p95_ms: Option<u64>,
    pub in_flight: u64,
    pub total: u64,
    /// Contadores da mensageria (outbox, publicados, consumidos), quando o serviço usa.
    pub bus: Option<Value>,
    /// Comentários ao vivo (só o gateway): WebSockets abertos e eventos repassados.
    pub live: Option<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub t: i64,
    pub rps: f64,
    pub errors_per_sec: f64,
    pub p95_ms: Option<u64>,
}

/// Réplicas de um Deployment com HPA num instante: é a linha do tempo do autoscaling.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScalePoint {
    pub t: i64,
    pub ready: i64,
    pub desired: i64,
    /// CPU média dos pods em % do request, como o HPA enxerga.
    pub cpu: Option<i64>,
}

struct Prev {
    at: Instant,
    requests: u64,
    errors: u64,
    buckets: Vec<u64>,
}

#[derive(Default)]
pub struct Traffic {
    prev: HashMap<String, Prev>,
    pub pods: HashMap<String, PodTraffic>,
    pub history: HashMap<String, VecDeque<Point>>,
    pub scale: HashMap<String, VecDeque<ScalePoint>>,
}

pub type Shared = Arc<Mutex<Traffic>>;

fn p95(deltas: &[u64], bounds: &[u64]) -> Option<u64> {
    let total: u64 = deltas.iter().sum();
    if total == 0 {
        return None;
    }
    let target = (total as f64 * 0.95).ceil() as u64;
    let mut acc = 0;
    for (i, d) in deltas.iter().enumerate() {
        acc += d;
        if acc >= target {
            return Some(*bounds.get(i).unwrap_or(&2000));
        }
    }
    None
}

pub fn spawn(kube: Kube, shared: Shared) {
    let http = reqwest::Client::builder().timeout(Duration::from_millis(800)).build().unwrap();
    {
        let (kube, shared) = (kube.clone(), shared.clone());
        tokio::spawn(async move {
            loop {
                if let Err(e) = scale_tick(&kube, &shared).await {
                    tracing::warn!(error = %e, "coleta das réplicas falhou");
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
    }
    tokio::spawn(async move {
        loop {
            if let Err(e) = tick(&kube, &http, &shared).await {
                tracing::warn!(error = %e, "coleta de tráfego falhou");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

async fn scale_tick(kube: &Kube, shared: &Shared) -> anyhow::Result<()> {
    let (p_deps, p_hpas) = (kube.apps("deployments"), format!("/apis/autoscaling/v2/namespaces/{}/horizontalpodautoscalers", kube.ns));
    let (deps, hpas) = tokio::join!(kube.get(&p_deps), kube.get(&p_hpas));
    let (deps, hpas) = (deps?, hpas?);
    let ts = time::OffsetDateTime::now_utc().unix_timestamp();
    let mut t = shared.lock().unwrap();
    for h in hpas["items"].as_array().into_iter().flatten() {
        let Some(target) = h["spec"]["scaleTargetRef"]["name"].as_str() else { continue };
        let Some(d) = deps["items"].as_array().into_iter().flatten().find(|d| d["metadata"]["name"] == target) else { continue };
        let cpu = h["status"]["currentMetrics"].as_array().and_then(|m| m.iter().find_map(|x| x["resource"]["current"]["averageUtilization"].as_i64()));
        let pt = ScalePoint {
            t: ts,
            ready: d["status"]["readyReplicas"].as_i64().unwrap_or(0),
            desired: d["spec"]["replicas"].as_i64().unwrap_or(0),
            cpu,
        };
        let hist = t.scale.entry(target.to_string()).or_default();
        hist.push_back(pt);
        while hist.len() > SCALE_HISTORY {
            hist.pop_front();
        }
    }
    Ok(())
}

async fn tick(kube: &Kube, http: &reqwest::Client, shared: &Shared) -> anyhow::Result<()> {
    let pods = kube.get(&format!("{}?labelSelector=tier%3Dbackend", kube.core("pods"))).await?;
    let targets: Vec<(String, String, String)> = pods["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["status"]["phase"] == "Running")
        .filter_map(|p| {
            Some((
                p["metadata"]["name"].as_str()?.to_string(),
                p["metadata"]["labels"]["app"].as_str()?.to_string(),
                p["status"]["podIP"].as_str()?.to_string(),
            ))
        })
        .collect();

    let results = futures::future::join_all(targets.iter().map(|(name, app, ip)| {
        let http = http.clone();
        async move {
            let v: Option<Value> = async { http.get(format!("http://{ip}:8080/stats")).send().await.ok()?.json().await.ok() }.await;
            (name.clone(), app.clone(), v)
        }
    }))
    .await;

    let now = Instant::now();
    let mut t = shared.lock().unwrap();
    let mut per_app: HashMap<String, (f64, f64, Vec<u64>, Vec<u64>)> = HashMap::new();
    let mut seen = Vec::new();
    for (name, app, v) in results {
        let Some(v) = v else { continue };
        let s = &v["stats"];
        let requests = s["requests"].as_u64().unwrap_or(0);
        let errors = s["errors"].as_u64().unwrap_or(0);
        let buckets: Vec<u64> = s["buckets"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
        let bounds: Vec<u64> = s["buckets_ms"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
        let bus = Some(v["bus"].clone()).filter(|b| !b.is_null());
        let live = Some(v["live"].clone()).filter(|b| !b.is_null());
        let mut pt = PodTraffic { in_flight: s["in_flight"].as_u64().unwrap_or(0), total: requests, bus, live, ..Default::default() };
        if let Some(prev) = t.prev.get(&name) {
            let dt = now.duration_since(prev.at).as_secs_f64().max(0.001);
            if requests >= prev.requests {
                let d: Vec<u64> = buckets.iter().zip(prev.buckets.iter().chain(std::iter::repeat(&0))).map(|(a, b)| a.saturating_sub(*b)).collect();
                pt.rps = (requests - prev.requests) as f64 / dt;
                pt.errors_per_sec = errors.saturating_sub(prev.errors) as f64 / dt;
                pt.p95_ms = p95(&d, &bounds);
                let e = per_app.entry(app.clone()).or_insert((0.0, 0.0, vec![0; d.len()], bounds.clone()));
                e.0 += pt.rps;
                e.1 += pt.errors_per_sec;
                for (i, x) in d.iter().enumerate() {
                    if i < e.2.len() {
                        e.2[i] += x;
                    }
                }
            }
        }
        t.prev.insert(name.clone(), Prev { at: now, requests, errors, buckets });
        t.pods.insert(name.clone(), pt);
        seen.push(name);
    }
    t.prev.retain(|k, _| seen.contains(k));
    t.pods.retain(|k, _| seen.contains(k));
    let ts = time::OffsetDateTime::now_utc().unix_timestamp();
    for app in ["gateway", "users", "articles", "comments"] {
        let (rps, eps, d, bounds) = per_app.remove(app).unwrap_or((0.0, 0.0, vec![], vec![]));
        let h = t.history.entry(app.to_string()).or_default();
        h.push_back(Point { t: ts, rps, errors_per_sec: eps, p95_ms: p95(&d, &bounds) });
        while h.len() > HISTORY {
            h.pop_front();
        }
    }
    Ok(())
}
