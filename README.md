# SocialClone

**A production-style microservices implementation of [RealWorld](https://github.com/realworld-apps/realworld) ("Conduit", a Medium clone) in Rust, running entirely on Kubernetes.**

![Rust](https://img.shields.io/badge/Rust-axum%200.8%20%C2%B7%20tokio%20%C2%B7%20sqlx-000000?logo=rust)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Kubernetes](https://img.shields.io/badge/Kubernetes-minikube-326CE5?logo=kubernetes&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![RabbitMQ](https://img.shields.io/badge/RabbitMQ-4.1-FF6600?logo=rabbitmq&logoColor=white)
![k6](https://img.shields.io/badge/load%20tested-k6-7D64FF?logo=k6&logoColor=white)
![RealWorld spec](https://img.shields.io/badge/RealWorld%20API%20spec-13%2F13%20passing-brightgreen)

Articles, comments, tags, favorites and followers, split into independent services with their
own databases, wired together through an API gateway and RabbitMQ events, and paired with a
live **operations dashboard** that lets you break things on purpose and watch the system
recover.

![Ops dashboard during a 2,000-user load test](docs/evidencias/08-autoscaling-2000-usuarios.png)

## Highlights

- **5 Rust services + React/nginx front-end**, each with its own Postgres database and
  credentials. No service ever reads another service's tables.
- **Zero-downtime rolling updates**: 0 errors across 135,060 requests (~1,900 req/s) while
  two services were upgraded at the same time.
- **Graceful degradation**: turn the comments service off (0 pods) and the site keeps working.
  Only the comments box changes to "comments disabled", and it recovers by itself.
- **Reliable messaging** with RabbitMQ using a **transactional outbox**, publisher confirms,
  an **idempotent inbox** and a dead-letter queue. Stop the broker and nothing breaks.
- **Real-time comments over WebSockets**, fanned out across gateway pods through per-pod
  RabbitMQ queues. Median delivery is 9 ms with 2,000 concurrent users.
- **Horizontal Pod Autoscaling** on every user-facing service: fast scale-up, gradual
  scale-down, with history charts in the dashboard.
- **Hard resource budget**: the whole app runs inside a fixed **4 CPU / 6 GiB** envelope,
  enforced at the node, namespace and container levels.
- **Load tested with k6**: **2,000 simulated users, 0 failures in 137,730 requests, p95 of 10 ms**.
- **Tiny footprint**: ~29 MB distroless images, millisecond startup, 5–15 MiB of RAM per pod
  at rest.
- Passes the **official RealWorld API conformance suite** (Hurl, 13/13), both locally and
  inside the cluster.

## Table of contents

- [Architecture](#architecture)
- [How it works](#how-it-works)
- [Ops dashboard](#ops-dashboard)
- [Performance](#performance)
- [Getting started](#getting-started)
- [Demo walkthrough](#demo-walkthrough)
- [Lessons learned](#lessons-learned)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)
- [Project structure](#project-structure)

## Architecture

```mermaid
flowchart TB
    browser([Browser])

    subgraph cluster["Kubernetes namespace: socialclone (4 CPU / 6 GiB budget)"]
        web["<b>web</b><br/>nginx + React SPA<br/>2–4 pods · NodePort 30080"]
        gateway["<b>gateway</b><br/>JWT · response composition<br/>WebSockets · 2–5 pods"]
        ops["<b>ops</b><br/>dashboard backend<br/>1 pod"]
        users["<b>users</b><br/>auth · profiles · follows<br/>2–4 pods"]
        articles["<b>articles</b><br/>articles · tags · favorites<br/>2–6 pods"]
        comments["<b>comments</b><br/>comments<br/>2–4 pods"]
        rabbit[("RabbitMQ<br/>conduit.events")]
        pg[("PostgreSQL<br/>users_db · articles_db · comments_db")]
        k8s{{Kubernetes API}}
    end

    browser -->|HTTP / WebSocket| web
    web -->|/api| gateway
    web -->|/ops| ops
    gateway --> users & articles & comments
    users & articles & comments --> pg
    articles <-->|outbox / inbox| rabbit
    comments <-->|outbox / inbox| rabbit
    rabbit -.->|"live.* queues (one per pod)"| gateway
    ops -->|ServiceAccount + RBAC| k8s
```

| Deployment | Image | Replicas | Role |
|---|---|---|---|
| `web` | nginx + React | 2–4 (HPA) | Serves the SPA and is the only entry point. Reverse proxy for `/api` and `/ops` |
| `gateway` | Rust | 2–5 (HPA) | Public API (BFF): JWT validation, response composition, fault isolation, WebSockets |
| `users` | Rust | 2–4 (HPA) | Registration, login (argon2 + JWT), profiles, follows |
| `articles` | Rust | 2–6 (HPA) | Articles, tags, favorites, feed |
| `comments` | Rust | 2–4 (HPA) | Comments (can be switched off at runtime) |
| `ops` | Rust | 1 | Backend for the ops dashboard, talks to the Kubernetes API |
| `postgres` | `postgres:17-alpine` | 1 (PVC) | One database and one role per service |
| `rabbitmq` | `rabbitmq:4.1-management-alpine` | 1 (PVC) | Event bus (topic exchange `conduit.events`) |

**Tech stack:** Rust (axum, tokio, sqlx, reqwest, lapin, tracing, mimalloc) · React 18 + Vite ·
nginx · PostgreSQL 17 · RabbitMQ 4.1 · Kubernetes (minikube) · k6 · Hurl · Playwright.

A request such as `GET /api/articles?limit=10` for a logged-in user flows like this:

```
nginx → gateway   validate the JWT
        → articles  GET  /articles?limit=10      (x-user-id: 7)  → articles with authorId
        → users     POST /internal/profiles {ids} (x-user-id: 7)  → profiles + "following"
        ← replace authorId with the author profile, respond in the RealWorld format
```

Internal services are never exposed outside the cluster. They only see the caller's id via
`x-user-id`, and authors are resolved with **one batched lookup** instead of N+1 calls.

## How it works

### Per-request load balancing

A ClusterIP Service balances *connections*, not requests. With keep-alive, one pod would end up
with almost all the traffic. Instead, the gateway resolves a **headless Service** (one IP per
ready pod) and does **per-request round-robin** over a connection pool per pod
([`crates/platform/src/upstream.rs`](crates/platform/src/upstream.rs)). nginx does the same for the
gateway (`server ... resolve`, nginx ≥ 1.27.3), so connections are reused at every hop and the load
is still spread evenly.

### Fault isolation

The article page loads its comments with a separate request. When `comments` is scaled to zero,
the headless DNS returns no addresses and the gateway answers **immediately**, with no timeout,
with `503 {"errors":{"comments":["disabled"]}}`. The UI shows "comments disabled" in that area
only, retries every 5 s, and recovers by itself when the service comes back.

### Zero-downtime deployments

Every version is an image tag (`v1`, `v2`, and a deliberately broken `v3`):

- `maxSurge: 1`, `maxUnavailable: 0` and `minReadySeconds: 5`: an old pod is only removed after
  its replacement is ready and stable.
- The readiness probe (`/readyz`) checks the database, so a pod that can't reach it gets no traffic.
- `preStop: sleep 8s` keeps a terminating pod serving while it is removed from endpoints and DNS.
  After SIGTERM the server fails readiness and **drains in-flight requests**
  ([`crates/platform/src/server.rs`](crates/platform/src/server.rs)).
- A version that never becomes ready (`v3`) stalls on its first pod while the old pods keep
  serving. After `progressDeadlineSeconds` the dashboard flags the rollout as stuck.

Front-end updates are visible too: `web` v2 changes the theme color, and open tabs get a
"new version published → reload" prompt.

### Reliable messaging: outbox + inbox

Side effects that don't need an immediate answer travel as events: deleting an article cascades
to its comments, and comment events keep the article's 💬 counter up to date.

```
articles  DELETE /articles/:slug
  BEGIN
    DELETE FROM articles ...
    INSERT INTO outbox ('article.deleted', {"articleId": 42})   ← same transaction
  COMMIT
        │  relay (background task in each articles pod): publish with
        │  publisher confirms, delete the outbox row only after the broker acks
        ▼
RabbitMQ  conduit.events (topic) ── article.deleted ──▶ comments.article-events (durable)
        ▼
comments  competing consumers (every replica reads the same queue)
  BEGIN
    INSERT INTO inbox (message_id)   ← already there? duplicate: just ack
    DELETE FROM comments WHERE article_id = 42
  COMMIT → ack
```

| Pattern | Guarantee |
|---|---|
| **Transactional outbox** | An event exists only if the change was committed, and it survives a broker outage |
| **Publisher confirms** + persistent messages | Outbox rows are deleted only after the broker has written the message to disk |
| **Idempotent inbox** | Delivery is at-least-once; the `message_id` recorded in the same transaction makes each event apply exactly once |
| **Competing consumers** | Scaling a service scales its consumption |
| **Dead-lettering** | Poison messages go to `conduit.dead` instead of blocking the queue; transient DB errors are requeued |

All of it lives in [`crates/platform/src/bus.rs`](crates/platform/src/bus.rs). A service just calls
`bus::enqueue(&mut tx, "article.deleted", json)` inside its transaction and registers a handler
with `bus::spawn_consumer(...)`. **RabbitMQ is not a readiness dependency**: with the broker down,
the API keeps serving, events pile up in the outbox, and the relay drains them on reconnect.

### Real-time comments

Readers of an article see new comments appear (and deleted ones disappear) without reloading.

```
browser ──ws──▶ nginx ──▶ gateway pod A ◀── queue live.gateway-…-a ◀──┐
browser ──ws──▶ nginx ──▶ gateway pod B ◀── queue live.gateway-…-b ◀──┤ conduit.events
                                                                       │ comment.*, article.deleted
comments ── outbox ── relay ───────────────────────────────────────────┘
```

- The browser opens a WebSocket at `GET /api/articles/{slug}/live`.
- Each gateway pod declares **its own exclusive, auto-deleted queue** (`live.<pod>`), so every pod
  receives every event (broadcast). This is the opposite of the durable work queues above.
- Each pod keeps one in-memory room (`tokio::sync::broadcast`) per article. Events for articles
  with no local readers are dropped at no cost. Otherwise the author profile is attached once and
  the message is fanned out to the room.
- `comment.created` carries the full comment, so the live path never queries `comments`.

| Failure | Behavior |
|---|---|
| RabbitMQ down | The site works normally; only live updates pause |
| Gateway pod terminating (rollout, scale-down) | Sockets are closed with code **1012** (service restart); clients reconnect to another pod with backoff and refetch the list, so nothing is missed |
| Slow client | Rooms buffer 64 messages; a lagging client gets `resync` and refetches |
| Idle connection | Server ping every 25 s; nginx allows up to 1 h of idle time |

Code: [`crates/gateway/src/live.rs`](crates/gateway/src/live.rs) and `spawn_subscriber` in
[`crates/platform/src/amqp.rs`](crates/platform/src/amqp.rs).

![A comment arriving live in a second tab](docs/evidencias/09-comentario-ao-vivo.png)

### Autoscaling

Every user-facing service has a `HorizontalPodAutoscaler` targeting **70% of its CPU request**.
Postgres and RabbitMQ are single-node stateful components and do not scale.

| Service | Min–max | Why this ceiling |
|---|---|---|
| `web` | 2–4 | nginx is cheap |
| `gateway` | 2–5 | All API traffic and WebSockets go through it |
| `users` | 2–4 | argon2 hashing is the most expensive operation |
| `articles` | 2–6 | Most-called service; 6 × 10 connections fit Postgres' limit |
| `comments` | 2–4 | Each extra pod is also an extra queue consumer |

Scaling behavior is tuned asymmetrically:

- **Scale up immediately**: every 15 s, double the pods or add 2, whichever is larger.
- **Scale down gradually**: only after 2 minutes of low load, then one pod every 30 s, so bursty
  traffic doesn't make pods flap.

The minikube metrics-server addon ships with a 60 s metric resolution, which left new pods without
CPU data for over a minute and delayed scaling by ~2.5 min under load. `cluster-up.sh` sets it
to 15 s. After that change, the gateway reached 5 pods in 40 s.

### Resource budget

The app runs inside hard limits instead of using whatever the host has free:

| Level | Where | Purpose |
|---|---|---|
| Node | `CPUS=4 MEMORY_MB=6144 ./scripts/cluster-up.sh` | cgroup limit on the minikube node: the app's "machine" |
| Namespace | `ResourceQuota` in [`00-namespace.yaml`](deploy/k8s/00-namespace.yaml) | Caps total requests/limits, autoscaling included |
| Container | `resources.requests/limits` per Deployment | Per-pod reservation and ceiling (CPU throttled, memory → OOMKilled) |

`cluster-up.sh` also sets kubelet `system-reserved` so the node's *allocatable* matches the real
ceiling. The scheduler, the HPA and the dashboard all show real numbers. With rootless podman,
minikube ignores `--cpus`, so the script applies the limit with `podman update`.

## Ops dashboard

The `/monitor` page is a control panel built on the Kubernetes API
([`crates/ops`](crates/ops), plain REST, no SDK, so every action maps to a `kubectl` call):

- a live strip of real requests per service, colored by the version that answered (red = error),
  plus which pod served each one;
- per-pod CPU, memory and req/s, with buttons to **delete pods**, **scale**, **switch versions**
  (v1/v2/broken v3) and **turn comments or RabbitMQ off**;
- **autoscaling** charts: desired vs. ready pods, CPU vs. target over the last 20 minutes, and the
  HPA's scaling decisions;
- **messaging**: queues, consumers, outbox backlog per service, live WebSocket readers per pod;
- node and `ResourceQuota` usage;
- a button that launches **k6 as a Kubernetes Job** inside the cluster.

| Comments disabled, site still up | Messaging with comments switched off |
|---|---|
| ![Comments disabled](docs/evidencias/04-comentarios-desativados.png) | ![Messaging panel](docs/evidencias/07-mensageria-comentarios-desligados.png) |

## Performance

All numbers come from a cluster capped at **4 CPUs / 6 GiB**, on a laptop with 15 GB of RAM.

### Capacity test: concurrent users

[`deploy/k8s/k6/capacity.js`](deploy/k8s/k6/capacity.js) simulates **real people browsing**. Each
virtual user loads the SPA, signs up, opens the home page (articles + tags in parallel), filters
by tag, reads an article with its comments, sometimes favorites, comments or publishes, and
**thinks for 3–8 s** between pages. The profile ramps 0 → N over 90 s, holds for 2 min and ramps
down over 30 s. Pass criteria: < 1% errors and p95 < 500 ms.

| Scenario | Users | Requests | Failures | p95 | p99 |
|---|---|---|---|---|---|
| Realistic browsing, autoscaling on | **2,000** | 137,730 | **0** | **10 ms** | 46 ms |
| Same, with live comments (WebSocket open while reading) | **2,000** | 137,525 | **0** | 27 ms | 121 ms |
| Fast browsing (0.5–1.5 s think time) | 500 | 135,305 | **0** | ≤ 25 ms at ~950 req/s | |

- During the 2,000-user run the HPA scaled `gateway`, `users` and `articles` 2 → 4 and `web` 2 → 3,
  then brought everything back to 2 about 3.5 minutes after the test ended
  ([timeline](docs/evidencias/capacidade-2000-hpa.txt)).
- **Live comments** with ~900 concurrent WebSockets: delivery to other readers had a **median of 9 ms,
  p95 of 40 ms and p99 of 149 ms** over 20,907 deliveries. The extra cost stays in the gateway
  (5 pods instead of 4, ~50 MiB each), and RabbitMQ barely notices (~5 events/s in).
- **Headroom**: ~950 req/s used 2.7 of 4 CPUs, which is roughly **2,700 concurrent users** at the
  realistic pace. Extrapolating, the 4-CPU ceiling sits around 1,400 req/s, and Postgres would be
  the first bottleneck.

### Rollouts and failure injection under load

| Test | VUs | req/s | Failures | p95 |
|---|---|---|---|---|
| Rolling update of `gateway` + `comments` (v1 → v2) at the same time | 20 | 1,927 | **0** / 135,060 | 29 ms |
| Broken `v3` stuck on `articles` + comments switched off | 20 | 589 | **0** / 47,330 | — |
| `login` scenario (argon2), HPA 2 → 4 on `users` | 80 | 148 | **0** / 20,215 | 28 ms |
| Mixed read/write scenario, HPA scaling `gateway` and `users` | 200 | 584 | **0** / 62,089 | 96 ms |

Raw k6 outputs and HPA timelines are in [`docs/evidencias/`](docs/evidencias).

## Getting started

**Prerequisites:** `minikube`, `kubectl`, and `podman` or `docker`. `k6` is optional.

```bash
# 1. Create the cluster with a fixed budget (defaults: 4 CPUs, 6 GiB)
./scripts/cluster-up.sh

# 2. Build all images (5 Rust services + web, tagged v1/v2/v3) and load them into minikube
./scripts/build-images.sh

# 3. Generate secrets, apply the manifests and wait for everything to be ready
./scripts/deploy.sh

# 4. Open the app (minikube prints a tunnel URL to NodePort 30080)
minikube -p socialclone service web -n socialclone
```

Images use `imagePullPolicy: Never`, so they are loaded straight into the node instead of being
pulled from a registry. To tear down: `kubectl delete -k deploy/k8s` or `minikube delete -p socialclone`.

### Load tests

```bash
URL=$(minikube -p socialclone service web -n socialclone --url)
k6 run -e BASE_URL=$URL -e VUS=50 -e DURATION=1m deploy/k8s/k6/load.js   # scenarios: mixed, read, write, login

./scripts/capacity.sh 2000            # concurrent-users test + HPA timeline
LIVE=1 ./scripts/capacity.sh 2000     # same, with live-comment WebSockets
```

`capacity.sh` runs k6 on the host, outside the cluster's CPU budget, and reaches the NodePort
directly through the minikube network. k6 uses ~0.5 MB per VU, so check `free -h` before large runs.

### Local development

```bash
podman run -d --name sc-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17-alpine
podman exec sc-pg psql -U postgres -c "create database users_db" -c "create database articles_db" -c "create database comments_db"

cargo build
export JWT_SECRET=dev LOG_FORMAT=pretty
PORT=8081 DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/users_db    target/debug/users &
PORT=8082 DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/articles_db target/debug/articles &
PORT=8083 DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/comments_db target/debug/comments &
PORT=8080 target/debug/gateway &

cd web && npm install && npm run dev   # http://localhost:5173, proxies /api to :8080
```

Run the official RealWorld conformance suite (requires [Hurl](https://hurl.dev)):

```bash
git clone --depth 1 https://github.com/realworld-apps/realworld /tmp/realworld
cd /tmp/realworld/specs/api && HOST=http://localhost:8080 ./run-api-tests-hurl.sh
```

## Demo walkthrough

Open an article in one tab and `/monitor` in another, then:

1. **Self-healing**: delete a pod (`×` in the dashboard or `kubectl delete pod`) and watch it get recreated with no downtime.
2. **Load balancing**: watch req/s spread evenly across pods, or hit `/api/_meta/ping/articles` repeatedly and see different pods answer.
3. **Graceful degradation**: switch comments off. The article page keeps working with "comments disabled"; switch them back on and they reappear by themselves.
4. **Live upgrade**: upgrade any service to v2 and watch v1 (green) and v2 (blue) answer side by side, with no red.
5. **Broken release**: deploy `v3`. The rollout stalls on one pod and the old pods keep serving. Roll back with one click.
6. **Autoscaling**: start a k6 run from the dashboard and watch pods scale up with CPU, then drift back to the minimum.
7. **Messaging resilience**: with comments off, delete an article and see the event waiting in `comments.article-events`; turn them on and the queue drains. Stop RabbitMQ, keep using the site and watch the outbox grow, then bring it back.
8. **Live comments**: comment from a second browser window and see it arrive instantly. Upgrade the gateway mid-conversation and both windows reconnect without losing a message.

## Lessons learned

Real issues that only surfaced under resource limits and load:

1. **OOMKilled under login bursts.** argon2 allocates 8 MiB per hash, and glibc's per-thread
   arenas held on to that memory, so pods blew past their 128 MiB limit. Fixed with a semaphore
   that bounds concurrent hashes and with **mimalloc** as the global allocator. Peak memory went
   down to ~42 MiB with 60 concurrent logins
   ([`password.rs`](crates/users/src/password.rs)).
2. **CrashLoopBackOff on cold start.** Services raced Postgres at boot. Connections and
   migrations now retry with backoff, and readiness holds traffic until the DB answers
   ([`db.rs`](crates/platform/src/db.rs)).
3. **Probe timeouts at CPU saturation** pulled healthy pods out of rotation. Probes now use a 3 s timeout.
4. **Connection churn at ~1,000 req/s.** A new TCP connection per request from nginx would have
   piled up tens of thousands of TIME_WAIT sockets. Switched to keep-alive with DNS-based,
   per-request balancing.
5. **`GET /tags` scanned the whole table** on every home page view. It is now served from a
   trigger-maintained `tag_counts` table
   ([migration](crates/articles/migrations/0003_tag_counts.sql)).
6. **Identical images for different versions.** Buildah cached `ENV APP_VERSION=${APP_VERSION}`
   across build args. The version is now written by a `RUN` step.
7. **Stale binary in a fresh image.** A source file edited during a build ended up older than the
   cached artifact, and cargo (which compares mtimes) reused the old binary. The Dockerfile now
   touches sources before building.
8. **Slow autoscaling** caused by the metrics-server's 60 s resolution (see [Autoscaling](#autoscaling)).

## Design decisions and trade-offs

- **Database per service on one Postgres instance**: separate databases and roles give logical
  isolation without the memory cost of three servers on a small cluster.
- **Single-node RabbitMQ**: enough for this environment; production would run a 3-node cluster
  with quorum queues. The outbox already protects against broker outages.
- **Polling outbox relay** (500 ms, plus an in-process wake-up on write) instead of CDC/Debezium:
  one less moving part.
- **Explicit composition over frameworks**: each service is a plain `main()` that builds its
  router and state. Cross-cutting concerns (auth, tracing, metrics, graceful shutdown, health
  checks) live in a shared `platform` crate as tower layers and extractors.
- **Hand-written SQL** with `sqlx` and migrations embedded in each binary.
- **Static, distroless images**: no shell, non-root user, read-only root filesystem.
- **Not production-hardened on purpose**: no TLS, no login rate limiting, and the dashboard has no
  authentication. It is meant to run locally.

## Project structure

```
crates/
  platform/   shared foundation: HTTP server (health, readiness, graceful shutdown, metrics),
              RealWorld error format, JWT, upstream client (headless DNS + load balancing),
              amqp.rs (RabbitMQ connection, per-pod broadcast subscriptions),
              bus.rs (outbox relay, inbox consumers, dead-lettering)
  users/      users service + migrations
  articles/   articles service + migrations
  comments/   comments service + migrations
  gateway/    public API: RealWorld routes, composition, degradation, live.rs (WebSockets)
  ops/        dashboard backend: Kubernetes REST client, traffic sampling, k6 jobs
web/          React + Vite (Conduit theme), nginx config
deploy/
  docker/     multi-stage Dockerfiles (Rust services, web)
  k8s/        manifests (kustomize), k6 scripts
scripts/      cluster-up, build-images, deploy, capacity
docs/         screenshots, load-test results and HPA timelines
```
