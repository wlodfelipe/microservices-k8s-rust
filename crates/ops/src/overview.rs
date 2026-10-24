use std::collections::HashMap;

use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};

use crate::Ops;

/// "250m" → 250, "1" → 1000, "123456789n" → 123 (milicores).
pub fn cpu_milli(q: &str) -> f64 {
    let q = q.trim();
    if let Some(n) = q.strip_suffix('n') {
        n.parse::<f64>().unwrap_or(0.0) / 1e6
    } else if let Some(u) = q.strip_suffix('u') {
        u.parse::<f64>().unwrap_or(0.0) / 1e3
    } else if let Some(m) = q.strip_suffix('m') {
        m.parse().unwrap_or(0.0)
    } else {
        q.parse::<f64>().unwrap_or(0.0) * 1000.0
    }
}

/// "128Mi" / "1Gi" / "131072Ki" / "1000000" → MiB.
pub fn mem_mib(q: &str) -> f64 {
    let q = q.trim();
    let units = [("Ki", 1.0 / 1024.0), ("Mi", 1.0), ("Gi", 1024.0), ("k", 1e3 / 1048576.0), ("M", 1e6 / 1048576.0), ("G", 1e9 / 1048576.0)];
    for (suf, mul) in units {
        if let Some(n) = q.strip_suffix(suf) {
            return n.parse::<f64>().unwrap_or(0.0) * mul;
        }
    }
    q.parse::<f64>().unwrap_or(0.0) / 1048576.0
}

fn tag(image: &str) -> String {
    image.rsplit_once(':').map(|(_, t)| t.to_string()).unwrap_or_else(|| "latest".into())
}

fn age_secs(ts: &Value) -> Option<i64> {
    let t = time::OffsetDateTime::parse(ts.as_str()?, &time::format_description::well_known::Rfc3339).ok()?;
    Some((time::OffsetDateTime::now_utc() - t).whole_seconds())
}

fn requests_of(spec: &Value) -> (f64, f64, f64, f64) {
    let mut out = (0.0, 0.0, 0.0, 0.0);
    for c in spec["containers"].as_array().into_iter().flatten() {
        let r = &c["resources"];
        out.0 += r["requests"]["cpu"].as_str().map(cpu_milli).unwrap_or(0.0);
        out.1 += r["requests"]["memory"].as_str().map(mem_mib).unwrap_or(0.0);
        out.2 += r["limits"]["cpu"].as_str().map(cpu_milli).unwrap_or(0.0);
        out.3 += r["limits"]["memory"].as_str().map(mem_mib).unwrap_or(0.0);
    }
    out
}

pub async fn overview(State(ops): State<Ops>) -> Result<Json<Value>, (StatusCode, String)> {
    let k = &ops.kube;
    let err = |e: anyhow::Error| (StatusCode::BAD_GATEWAY, e.to_string());
    let metrics_pods = format!("/apis/metrics.k8s.io/v1beta1/namespaces/{}/pods", k.ns);
    let hpas_path = format!("/apis/autoscaling/v2/namespaces/{}/horizontalpodautoscalers", k.ns);
    let (p_deps, p_pods, p_events, p_quotas) = (k.apps("deployments"), k.core("pods"), k.core("events"), k.core("resourcequotas"));
    let (deps, pods, events, hpas, pod_metrics, nodes, node_metrics, quotas, broker) = tokio::join!(
        k.get(&p_deps),
        k.get(&p_pods),
        k.get(&p_events),
        k.get(&hpas_path),
        k.get(&metrics_pods),
        k.get("/api/v1/nodes"),
        k.get("/apis/metrics.k8s.io/v1beta1/nodes"),
        k.get(&p_quotas),
        crate::broker::snapshot(),
    );
    let deps = deps.map_err(err)?;
    let pods = pods.map_err(err)?;
    // métricas, HPA e nós são opcionais (metrics-server pode não estar pronto ainda)
    let pod_metrics = pod_metrics.unwrap_or(Value::Null);
    let hpas = hpas.unwrap_or(Value::Null);

    let mut usage: HashMap<String, (f64, f64)> = HashMap::new();
    for m in pod_metrics["items"].as_array().into_iter().flatten() {
        let name = m["metadata"]["name"].as_str().unwrap_or_default().to_string();
        let mut u = (0.0, 0.0);
        for c in m["containers"].as_array().into_iter().flatten() {
            u.0 += c["usage"]["cpu"].as_str().map(cpu_milli).unwrap_or(0.0);
            u.1 += c["usage"]["memory"].as_str().map(mem_mib).unwrap_or(0.0);
        }
        usage.insert(name, u);
    }

    let traffic = ops.traffic.lock().unwrap();

    // Mensageria por serviço: soma dos contadores dos pods (a outbox é a mesma tabela para
    // todas as réplicas, então ali vale o maior valor visto, não a soma).
    let mut bus: HashMap<String, Value> = HashMap::new();
    for p in pods["items"].as_array().into_iter().flatten() {
        let (Some(name), Some(app)) = (p["metadata"]["name"].as_str(), p["metadata"]["labels"]["app"].as_str()) else { continue };
        let Some(b) = traffic.pods.get(name).and_then(|t| t.bus.as_ref()) else { continue };
        let e = bus.entry(app.to_string()).or_insert_with(|| json!({
            "pods": 0, "connected": 0, "published": 0, "consumed": 0, "duplicates": 0, "failed": 0, "outboxPending": 0,
        }));
        let add = |e: &mut Value, k: &str, v: i64| e[k] = json!(e[k].as_i64().unwrap_or(0) + v);
        add(e, "pods", 1);
        add(e, "connected", (b["connected"] == true) as i64);
        for k in ["published", "consumed", "duplicates", "failed"] {
            add(e, k, b[k].as_i64().unwrap_or(0));
        }
        let pending = b["outboxPending"].as_i64().unwrap_or(0).max(e["outboxPending"].as_i64().unwrap_or(0));
        e["outboxPending"] = json!(pending);
    }

    // Comentários ao vivo: WebSockets abertos em cada pod do gateway (mostra como as
    // conexões longas se espalham, ou não, quando o HPA cria pods novos).
    let mut live_pods: Vec<Value> = pods["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let name = p["metadata"]["name"].as_str()?;
            let l = traffic.pods.get(name)?.live.as_ref()?;
            Some(json!({
                "pod": name, "connected": l["connected"], "clients": l["clients"],
                "events": l["events"], "delivered": l["delivered"],
            }))
        })
        .collect();
    live_pods.sort_by(|a, b| a["pod"].as_str().cmp(&b["pod"].as_str()));
    let live_total = |k: &str| live_pods.iter().map(|p| p[k].as_i64().unwrap_or(0)).sum::<i64>();
    let live = json!({
        "pods": live_pods,
        "clients": live_total("clients"),
        "events": live_total("events"),
        "delivered": live_total("delivered"),
    });
    let bus_history = traffic.bus_history.clone();

    let pod_list: Vec<Value> = pods["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            let name = p["metadata"]["name"].as_str().unwrap_or_default();
            let statuses = p["status"]["containerStatuses"].as_array().cloned().unwrap_or_default();
            let ready = !statuses.is_empty() && statuses.iter().all(|c| c["ready"] == true);
            let restarts: i64 = statuses.iter().filter_map(|c| c["restartCount"].as_i64()).sum();
            let waiting = statuses.iter().find_map(|c| c["state"]["waiting"]["reason"].as_str().map(String::from));
            let terminating = !p["metadata"]["deletionTimestamp"].is_null();
            let phase = if terminating {
                "Terminating".to_string()
            } else if let Some(w) = waiting {
                w
            } else {
                p["status"]["phase"].as_str().unwrap_or("?").to_string()
            };
            let image = p["spec"]["containers"][0]["image"].as_str().unwrap_or_default();
            let (cpu, mem) = usage.get(name).copied().unwrap_or((0.0, 0.0));
            let (rc, rm, lc, lm) = requests_of(&p["spec"]);
            json!({
                "name": name,
                "app": p["metadata"]["labels"]["app"],
                "version": tag(image),
                "phase": phase,
                "ready": ready,
                "restarts": restarts,
                "node": p["spec"]["nodeName"],
                "ip": p["status"]["podIP"],
                "ageSecs": age_secs(&p["metadata"]["creationTimestamp"]),
                "cpuMilli": cpu, "memMi": mem,
                "requests": { "cpuMilli": rc, "memMi": rm }, "limits": { "cpuMilli": lc, "memMi": lm },
                "traffic": traffic.pods.get(name),
            })
        })
        .collect();

    let hpa_for: HashMap<String, Value> = hpas["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|h| {
            let target = h["spec"]["scaleTargetRef"]["name"].as_str()?.to_string();
            let cpu = h["status"]["currentMetrics"].as_array().and_then(|m| {
                m.iter().find_map(|x| x["resource"]["current"]["averageUtilization"].as_i64())
            });
            let target_cpu = h["spec"]["metrics"].as_array().and_then(|m| {
                m.iter().find_map(|x| x["resource"]["target"]["averageUtilization"].as_i64())
            });
            let default_min = h["metadata"]["annotations"]["socialclone/default-min"].as_str().and_then(|v| v.parse::<i64>().ok());
            // "ScalingLimited" = travado no mínimo/máximo; "ScalingActive" falso = sem métrica ou Deployment em 0
            let cond = |ty: &str| h["status"]["conditions"].as_array().and_then(|c| c.iter().find(|x| x["type"] == ty).cloned());
            let limited = cond("ScalingLimited").filter(|c| c["status"] == "True").and_then(|c| c["reason"].as_str().map(String::from));
            let active = cond("ScalingActive").map(|c| c["status"] == "True");
            Some((target, json!({
                "name": h["metadata"]["name"],
                "min": h["spec"]["minReplicas"], "max": h["spec"]["maxReplicas"], "defaultMin": default_min,
                "current": h["status"]["currentReplicas"], "desired": h["status"]["desiredReplicas"],
                "cpu": cpu, "targetCpu": target_cpu,
                "limited": limited, "active": active,
                "lastScaleSecs": age_secs(&h["status"]["lastScaleTime"]),
            })))
        })
        .collect();

    let deployments: Vec<Value> = deps["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|d| {
            let name = d["metadata"]["name"].as_str().unwrap_or_default();
            let ann = &d["metadata"]["annotations"];
            let versions: Vec<&str> = ann["socialclone/versions"].as_str().map(|s| s.split(',').collect()).unwrap_or_default();
            let image = d["spec"]["template"]["spec"]["containers"][0]["image"].as_str().unwrap_or_default();
            let st = &d["status"];
            let desired = d["spec"]["replicas"].as_i64().unwrap_or(0);
            let updated = st["updatedReplicas"].as_i64().unwrap_or(0);
            let available = st["availableReplicas"].as_i64().unwrap_or(0);
            let total = st["replicas"].as_i64().unwrap_or(0);
            let conds = st["conditions"].as_array().cloned().unwrap_or_default();
            let progressing = conds.iter().find(|c| c["type"] == "Progressing");
            let stuck = progressing.map(|c| c["reason"] == "ProgressDeadlineExceeded").unwrap_or(false);
            let rolling = updated < desired || total > desired || available < desired
                || st["observedGeneration"].as_i64() < d["metadata"]["generation"].as_i64();
            // versões que estão realmente rodando agora (durante o rollout aparecem duas)
            let mut running: HashMap<String, i64> = HashMap::new();
            for p in &pod_list {
                if p["app"] == name && p["phase"] != "Terminating" {
                    *running.entry(p["version"].as_str().unwrap_or("?").to_string()).or_default() += 1;
                }
            }
            json!({
                "name": name,
                "tier": d["metadata"]["labels"]["tier"],
                "description": ann["socialclone/description"],
                "versions": versions,
                "version": tag(image),
                "image": image,
                "desired": desired,
                "ready": st["readyReplicas"].as_i64().unwrap_or(0),
                "updated": updated,
                "available": available,
                "total": total,
                "rolling": rolling && !stuck,
                "stuck": stuck,
                "message": progressing.and_then(|c| c["message"].as_str()),
                "strategy": d["spec"]["strategy"],
                "running": running,
                "hpa": hpa_for.get(name),
                "history": traffic.history.get(name),
                "scaleHistory": traffic.scale.get(name),
            })
        })
        .collect();
    drop(traffic);

    let mut evs: Vec<Value> = events
        .ok()
        .and_then(|e| e["items"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|e| {
            let ts = if !e["lastTimestamp"].is_null() { e["lastTimestamp"].clone() } else { e["eventTime"].clone() };
            json!({
                "time": ts,
                "ageSecs": age_secs(&ts),
                "type": e["type"],
                "reason": e["reason"],
                "object": format!("{}/{}", e["involvedObject"]["kind"].as_str().unwrap_or(""), e["involvedObject"]["name"].as_str().unwrap_or("")),
                "message": e["message"],
                "count": e["count"],
            })
        })
        .collect();
    evs.sort_by_key(|e| e["ageSecs"].as_i64().unwrap_or(i64::MAX));
    // decisões do HPA ("New size: 4; reason: cpu resource utilization above target") à parte,
    // para não sumirem no meio dos eventos de pods
    let scaling: Vec<Value> = evs.iter().filter(|e| e["reason"] == "SuccessfulRescale").take(20).cloned().collect();
    evs.truncate(40);

    let node_usage: HashMap<String, (f64, f64)> = node_metrics
        .ok()
        .and_then(|m| m["items"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|n| {
            Some((
                n["metadata"]["name"].as_str()?.to_string(),
                (n["usage"]["cpu"].as_str().map(cpu_milli)?, n["usage"]["memory"].as_str().map(mem_mib)?),
            ))
        })
        .collect();
    let node_list: Vec<Value> = nodes
        .ok()
        .and_then(|n| n["items"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|n| {
            let name = n["metadata"]["name"].as_str().unwrap_or_default();
            let (cpu, mem) = node_usage.get(name).copied().unwrap_or((0.0, 0.0));
            json!({
                "name": name,
                "cpuCapacityMilli": n["status"]["allocatable"]["cpu"].as_str().map(cpu_milli),
                "memCapacityMi": n["status"]["allocatable"]["memory"].as_str().map(mem_mib),
                "cpuMilli": cpu, "memMi": mem,
                "kubelet": n["status"]["nodeInfo"]["kubeletVersion"],
            })
        })
        .collect();

    let quota = quotas.ok().and_then(|q| q["items"].as_array().and_then(|a| a.first().cloned())).map(|q| {
        let get = |m: &str, k: &str| q["status"][m][k].as_str().map(String::from);
        json!({
            "name": q["metadata"]["name"],
            "cpuRequests": { "used": get("used", "requests.cpu").map(|v| cpu_milli(&v)), "hard": get("hard", "requests.cpu").map(|v| cpu_milli(&v)) },
            "memRequests": { "used": get("used", "requests.memory").map(|v| mem_mib(&v)), "hard": get("hard", "requests.memory").map(|v| mem_mib(&v)) },
            "cpuLimits": { "used": get("used", "limits.cpu").map(|v| cpu_milli(&v)), "hard": get("hard", "limits.cpu").map(|v| cpu_milli(&v)) },
            "memLimits": { "used": get("used", "limits.memory").map(|v| mem_mib(&v)), "hard": get("hard", "limits.memory").map(|v| mem_mib(&v)) },
            "pods": { "used": get("used", "pods"), "hard": get("hard", "pods") },
        })
    });

    Ok(Json(json!({
        "namespace": k.ns,
        "deployments": deployments,
        "pods": pod_list,
        "events": evs,
        "scaling": scaling,
        "nodes": node_list,
        "quota": quota,
        "metricsAvailable": !pod_metrics.is_null(),
        "messaging": { "broker": broker, "services": bus, "live": live, "history": bus_history },
    })))
}
