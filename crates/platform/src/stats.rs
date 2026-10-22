//! Contadores em memória por pod. O `ops` lê `/stats` de cada pod e calcula req/s,
//! erros e latência para o monitor (é assim que se vê o balanceamento entre os pods).
//! Atômicos simples: sem lock no caminho da requisição.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::Relaxed};
use std::time::Duration;

/// Limites dos buckets do histograma de latência, em milissegundos.
pub const BUCKETS_MS: [u64; 10] = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

#[derive(Default)]
pub struct Stats {
    requests: AtomicU64,
    errors: AtomicU64,
    in_flight: AtomicU64,
    latency_us_total: AtomicU64,
    buckets: [AtomicU64; BUCKETS_MS.len() + 1],
}

#[derive(serde::Serialize)]
pub struct Snapshot {
    pub requests: u64,
    pub errors: u64,
    pub in_flight: u64,
    pub latency_us_total: u64,
    pub buckets_ms: &'static [u64],
    pub buckets: Vec<u64>,
}

impl Stats {
    pub fn start(&self) {
        self.in_flight.fetch_add(1, Relaxed);
    }

    pub fn finish(&self, elapsed: Duration, server_error: bool) {
        self.in_flight.fetch_sub(1, Relaxed);
        self.requests.fetch_add(1, Relaxed);
        if server_error {
            self.errors.fetch_add(1, Relaxed);
        }
        let us = elapsed.as_micros() as u64;
        self.latency_us_total.fetch_add(us, Relaxed);
        let ms = us / 1000;
        let idx = BUCKETS_MS.iter().position(|b| ms < *b).unwrap_or(BUCKETS_MS.len());
        self.buckets[idx].fetch_add(1, Relaxed);
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            requests: self.requests.load(Relaxed),
            errors: self.errors.load(Relaxed),
            in_flight: self.in_flight.load(Relaxed),
            latency_us_total: self.latency_us_total.load(Relaxed),
            buckets_ms: &BUCKETS_MS,
            buckets: self.buckets.iter().map(|b| b.load(Relaxed)).collect(),
        }
    }
}

/// Contadores da mensageria (só os serviços com `platform::bus` mexem neles).
/// Ficam aqui, fora da feature `bus`, para o `/stats` de qualquer serviço poder expor.
pub struct BusStats {
    pub enabled: AtomicBool,
    pub connected: AtomicBool,
    pub published: AtomicU64,
    pub consumed: AtomicU64,
    pub duplicates: AtomicU64,
    pub failed: AtomicU64,
    pub outbox_pending: AtomicI64,
}

pub static BUS: BusStats = BusStats {
    enabled: AtomicBool::new(false),
    connected: AtomicBool::new(false),
    published: AtomicU64::new(0),
    consumed: AtomicU64::new(0),
    duplicates: AtomicU64::new(0),
    failed: AtomicU64::new(0),
    outbox_pending: AtomicI64::new(0),
};

impl BusStats {
    pub fn snapshot(&self) -> Option<serde_json::Value> {
        self.enabled.load(Relaxed).then(|| {
            serde_json::json!({
                "connected": self.connected.load(Relaxed),
                "published": self.published.load(Relaxed),
                "consumed": self.consumed.load(Relaxed),
                "duplicates": self.duplicates.load(Relaxed),
                "failed": self.failed.load(Relaxed),
                "outboxPending": self.outbox_pending.load(Relaxed),
            })
        })
    }
}

/// Contadores dos eventos ao vivo (WebSocket): só o gateway mexe neles.
pub struct LiveStats {
    pub enabled: AtomicBool,
    /// assinatura do RabbitMQ ativa neste pod
    pub connected: AtomicBool,
    /// navegadores com WebSocket aberto neste pod
    pub clients: AtomicI64,
    /// eventos recebidos do RabbitMQ
    pub events: AtomicU64,
    /// mensagens enviadas aos navegadores (um evento vira N mensagens)
    pub delivered: AtomicU64,
}

pub static LIVE: LiveStats = LiveStats {
    enabled: AtomicBool::new(false),
    connected: AtomicBool::new(false),
    clients: AtomicI64::new(0),
    events: AtomicU64::new(0),
    delivered: AtomicU64::new(0),
};

impl LiveStats {
    pub fn snapshot(&self) -> Option<serde_json::Value> {
        self.enabled.load(Relaxed).then(|| {
            serde_json::json!({
                "connected": self.connected.load(Relaxed),
                "clients": self.clients.load(Relaxed),
                "events": self.events.load(Relaxed),
                "delivered": self.delivered.load(Relaxed),
            })
        })
    }
}
