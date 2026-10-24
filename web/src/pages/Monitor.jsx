import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ops } from '../lib/api';
import { Stamp } from '../components/Postal';
import Icon from '../components/Icon';

// Monitor: a sala de triagem. Estado do cluster (via serviço `ops`) + tráfego ao vivo (via gateway).
//
// - Cada cartão é um Deployment. Trocar a versão troca a tag da imagem e o Kubernetes faz o
//   rolling update; a faixa de quadradinhos mostra, em tempo real, qual versão/pod
//   respondeu cada requisição (vermelho = erro). Numa atualização bem feita não aparece
//   vermelho nenhum.
// - "Switch comments off" zera as réplicas do serviço de comentários: o site segue no ar
//   e a página do artigo mostra o aviso de comentários desligados.
// - Mensageria: filas do RabbitMQ e a outbox de cada serviço. Desligar o RabbitMQ não
//   derruba nada: os eventos esperam na outbox e saem quando ele volta.

const STRIP = 60;
const ORDER = ['web', 'gateway', 'users', 'articles', 'comments', 'ops', 'postgres', 'rabbitmq'];
const PINGED = ['web', 'gateway', 'users', 'articles', 'comments'];
const DESC = {
  web: 'React SPA on nginx; reverse proxy for /api and /ops',
  gateway: 'Public API: JWT, response composition, WebSockets',
  users: 'Sign-up, login (argon2 + JWT), profiles, follows',
  articles: 'Articles, tags, favorites, feed',
  comments: 'Comments; can be switched off without taking the site down',
  ops: 'Control plane for this Monitor (Kubernetes API)',
  postgres: 'PostgreSQL 17, one database per service',
  rabbitmq: 'RabbitMQ 4, events between services',
};
const K6_STATE = { Rodando: 'Running', Pendente: 'Pending', 'Concluído': 'Finished', Falhou: 'Failed' };
const vClass = (v) => (['v1', 'v2', 'v3'].includes(v) ? v : 'v1');
const TRAFFIC = ['gateway', 'users', 'articles', 'comments'];
const TRAFFIC_WINDOW = 5 * 60; // segundos no gráfico de tráfego

// Memória do Monitor fora do componente: sair para a Home e voltar não zera as faixas,
// o histórico de tráfego, o registro de ações nem o último estado do cluster.
const memory = { pings: {}, traffic: {}, bus: [], data: null, updated: null, log: [], live: true, k6: null };

// O Job do k6 se chama k6-<unix timestamp do início>; a duração vem como "60s" ou "2m".
const k6Start = (job) => Number(job?.match(/^k6-(\d+)/)?.[1]) || null;
const seconds = (d) => { const m = String(d || '').match(/^(\d+)(s|m)$/); return m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : null; };

// O ops guarda 3 min de pontos (a cada 2 s); aqui o histórico cresce até a janela do gráfico.
function remember(data) {
  const now = Math.floor(Date.now() / 1000);
  for (const d of data.deployments) {
    if (!d.history) continue;
    const list = memory.traffic[d.name] || [];
    const last = list.length ? list[list.length - 1].t : -Infinity;
    const merged = list.concat(d.history.filter((p) => p.t > last));
    memory.traffic[d.name] = merged.filter((p) => p.t >= now - TRAFFIC_WINDOW - 10);
  }
}

function useInterval(fn, ms, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return undefined;
    ref.current();
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
}

function age(s) {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const shortPod = (name, app) => (name?.startsWith(`${app}-`) ? name.slice(app.length + 1) : name);
const fmt1 = (n) => (n == null ? '—' : n.toFixed(1));

// ---------- tráfego ao vivo (pings) ----------

async function pingOnce(svc) {
  const t0 = performance.now();
  try {
    if (svc === 'web') {
      const r = await fetch('/version.json', { cache: 'no-store' });
      const j = await r.json();
      return { ok: r.ok, version: j.version, pod: r.headers.get('x-served-by'), ms: performance.now() - t0 };
    }
    const r = await api.ping(svc);
    if (!r.ok) return { ok: false, error: r.endpoints === 0 ? 'no ready pods' : 'unavailable', ms: performance.now() - t0 };
    return { ok: true, version: r.version, pod: r.pod, ms: performance.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.status === 503 ? 'unavailable' : `error ${e.status || ''}`.trim(), ms: performance.now() - t0 };
  }
}

function usePings(services, enabled) {
  const [pings, setPings] = useState(() => memory.pings);
  const busy = useRef({});
  useInterval(() => {
    services.forEach(async (svc) => {
      if (busy.current[svc]) return;
      busy.current[svc] = true;
      const p = await pingOnce(svc);
      busy.current[svc] = false;
      setPings((all) => {
        const list = [...(all[svc] || []), { ...p, t: Date.now() }].slice(-STRIP);
        memory.pings = { ...all, [svc]: list };
        return memory.pings;
      });
    });
  }, 250, enabled);
  return pings;
}

// Faixa de entregas: cada quadrado é uma requisição real, na cor da versão que respondeu.
function Deliveries({ pings }) {
  const list = pings || [];
  const errors = list.filter((p) => !p.ok).length;
  const last = list[list.length - 1];
  const byPod = {};
  list.slice(-20).forEach((p) => { if (p.ok && p.pod) byPod[p.pod] = (byPod[p.pod] || 0) + 1; });
  return (
    <div className="deliveries">
      <div className="strip" role="img" aria-label={`Last ${list.length} requests, ${errors} failed`}>
        {Array.from({ length: STRIP - list.length }).map((_, i) => <span key={`e${i}`} className="sq" />)}
        {list.map((p) => (
          <span key={p.t} className={`sq ${p.ok ? vClass(p.version) : 'err'}`} title={p.ok ? `${p.version} · ${p.pod} · ${p.ms.toFixed(0)} ms` : p.error} />
        ))}
      </div>
      <div className="strip-legend">
        {last ? (last.ok
          ? <span>last <b>{last.version}</b> from {last.pod?.split('-').slice(-1)[0]}</span>
          : <b className="bad">{last.error}</b>) : <span>waiting for the first request…</span>}
        <span className={errors ? 'bad' : ''}>failed <b className={errors ? 'bad' : ''}>{errors}</b> of {list.length}</span>
        {Object.keys(byPod).length > 1 && (
          <span>last 20 by pod: {Object.entries(byPod).map(([pod, n]) => `${pod.split('-').slice(-1)[0]} ${n}`).join(' · ')}</span>
        )}
      </div>
    </div>
  );
}

// ---------- cartão de cada Deployment ----------

function serviceState(d) {
  if (d.stuck) return { kind: 'held', txt: 'Held' };
  if (d.desired === 0) return { kind: 'off', txt: 'Off' };
  if (d.rolling) return { kind: 'busy', txt: 'Updating' };
  if (d.ready < d.desired) return { kind: 'busy', txt: 'Starting' };
  return { kind: 'ok', txt: 'Delivering' };
}

function ServiceCard({ d, pods, pings, act, busy, metrics }) {
  const versions = d.versions || [];
  const st = serviceState(d);
  const running = Object.entries(d.running || {});
  const scalable = !['postgres', 'ops', 'rabbitmq'].includes(d.name);
  const min = d.hpa ? 1 : 0;

  return (
    <section className="panel svc" aria-labelledby={`svc-${d.name}`}>
      <div className="svc-main">
      <div className="svc-head">
        <div>
          <h3 id={`svc-${d.name}`}>{d.name}</h3>
          <div className="desc">{DESC[d.name] || d.description}</div>
        </div>
        <Stamp kind={st.kind}>{st.txt}</Stamp>
      </div>

      <div className="svc-meta">
        <span>pods <b className="num">{d.ready}/{d.desired}</b> ready</span>
        {d.hpa && <span>autoscaler <b className="num">{d.hpa.min}–{d.hpa.max}</b>{d.hpa.cpu != null && <> · CPU <b className="num">{d.hpa.cpu}%</b> of {d.hpa.targetCpu}% target</>}</span>}
        {running.length > 0 && <span>running {running.map(([v, n]) => <b key={v} className="num"> {v}×{n}</b>)}</span>}
        <span>image <b>{d.image?.split('/').slice(-1)[0]}</b></span>
      </div>
      {d.stuck && <div className="svc-msg">The new version never became ready, so the old pods keep serving. Pick a working version to unblock it.{d.message ? ` (${d.message})` : ''}</div>}

      <div className="controls">
        {versions.length > 0 && (
          <div className="seg" role="group" aria-label={`${d.name} version`}>
            {versions.map((v) => (
              <button key={v} className={v === d.version ? 'on' : ''} disabled={busy || v === d.version} aria-pressed={v === d.version}
                title={v === 'v3' ? 'Broken on purpose: readiness never passes' : `Switch ${d.name} to ${v}`}
                onClick={() => act(`Switch ${d.name} to ${v}`, () => ops.setVersion(d.name, v))}>{v === 'v3' ? 'v3 broken' : v}</button>
            ))}
          </div>
        )}
        {scalable && d.desired > 0 && (
          <div className="stepper" role="group" aria-label={`${d.name} minimum pods`}>
            <button disabled={busy || d.desired <= min} aria-label="One pod fewer" onClick={() => act(`Scale ${d.name} to ${d.desired - 1}`, () => ops.scale(d.name, d.desired - 1))}>−</button>
            <span>{d.desired}</span>
            <button disabled={busy || d.desired >= 8} aria-label="One pod more" onClick={() => act(`Scale ${d.name} to ${d.desired + 1}`, () => ops.scale(d.name, d.desired + 1))}>+</button>
          </div>
        )}
        {d.hpa && d.hpa.defaultMin != null && d.hpa.min !== d.hpa.defaultMin && (
          <button className="btn btn-xs btn-secondary" disabled={busy} title={`Minimum pinned at ${d.hpa.min} by the − / + buttons`}
            onClick={() => act(`Return ${d.name} to automatic (minimum ${d.hpa.defaultMin})`, () => ops.hpaReset(d.name))}>Back to automatic</button>
        )}
        <span className="spacer" />
        {scalable && d.desired > 0 && (
          <button className="btn btn-xs btn-ghost" disabled={busy} onClick={() => act(`Restart ${d.name} (rolling)`, () => ops.restart(d.name))}><Icon name="refresh" size={14} /> Restart</button>
        )}
        <button className="btn btn-xs btn-ghost" disabled={busy || !pods.length} onClick={() => act(`Delete every ${d.name} pod`, () => ops.killPods(d.name))}><Icon name="trash" size={14} /> Delete pods</button>
        {d.name === 'comments' && (d.desired > 0 ? (
          <button className="btn btn-xs btn-danger" disabled={busy} onClick={() => act('Switch comments off (0 pods)', () => ops.scale('comments', 0))}><Icon name="power" size={14} /> Switch comments off</button>
        ) : (
          <button className="btn btn-xs" disabled={busy} onClick={() => act('Switch comments back on (2 pods)', () => ops.scale('comments', 2))}><Icon name="power" size={14} /> Switch comments on</button>
        ))}
        {d.name === 'rabbitmq' && (d.desired > 0 ? (
          <button className="btn btn-xs btn-danger" disabled={busy} onClick={() => act('Switch RabbitMQ off', () => ops.scale('rabbitmq', 0))}><Icon name="power" size={14} /> Switch RabbitMQ off</button>
        ) : (
          <button className="btn btn-xs" disabled={busy} onClick={() => act('Switch RabbitMQ back on', () => ops.scale('rabbitmq', 1))}><Icon name="power" size={14} /> Switch RabbitMQ on</button>
        ))}
      </div>

      {PINGED.includes(d.name) && <Deliveries pings={pings} />}
      {TRAFFIC.includes(d.name) && <ServiceTraffic d={d} />}

      </div>
      <div className="table-scroll svc-pods">
        <table className="data">
          <thead>
            <tr><th><span className="sr-only">Ready</span></th><th>Pod</th><th>Version</th><th>State</th><th className="num opt">Age</th><th className="num">CPU</th><th className="num">Memory</th><th className="num opt">Req/s</th><th><span className="sr-only">Delete</span></th></tr>
          </thead>
          <tbody>
            {pods.map((p) => (
              <tr key={p.name} className={p.phase === 'Terminating' ? 'gone' : ''}>
                <td><span className={`dot ${p.ready ? '' : p.phase === 'Terminating' ? 'off' : 'warn'}`} aria-label={p.ready ? 'ready' : 'not ready'} /></td>
                <td><span title={p.name}>{shortPod(p.name, d.name)}</span></td>
                <td><span className={`vtag ${vClass(p.version)}`} title={p.version}>{p.version}</span></td>
                <td>{p.phase}{p.restarts ? <span className="warn"> · {p.restarts} restarts</span> : ''}</td>
                <td className="num opt">{age(p.ageSecs)}</td>
                <td className="num">{metrics && p.cpuMilli != null ? `${p.cpuMilli.toFixed(0)}m` : '—'}</td>
                <td className="num">{metrics && p.memMi != null ? `${p.memMi.toFixed(0)} Mi` : '—'}</td>
                <td className="num opt">{p.traffic ? fmt1(p.traffic.rps) : '—'}</td>
                <td><button className="x-btn" aria-label={`Delete pod ${p.name}; the Deployment recreates it`} title="Delete this pod (Kubernetes recreates it)"
                  disabled={busy || p.phase === 'Terminating'} onClick={() => act(`Delete pod ${p.name}`, () => ops.deletePod(p.name))}><Icon name="x" size={14} /></button></td>
              </tr>
            ))}
            {!pods.length && <tr><td colSpan="9" className="sub">No pods. {d.desired === 0 ? 'Scaled to zero on purpose.' : ''}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- tráfego por serviço ----------

// Topo "redondo" do eixo y: 1, 2, 5, 10, 20, 50…
function niceMax(v) {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function TrafficChart({ name, points }) {
  const w = 300; const h = 120;
  const now = Math.floor(Date.now() / 1000);
  const top = niceMax(Math.max(...points.map((p) => p.rps), 1) * 1.1);
  const x = (t) => w - ((now - t) / TRAFFIC_WINDOW) * w;
  const y = (v) => h - (v / top) * h;
  // Lacuna na coleta (mais de 6 s sem ponto) quebra a linha em vez de inventar valores no meio.
  const segments = [];
  points.forEach((p, i) => {
    if (!i || p.t - points[i - 1].t > 6) segments.push([]);
    segments[segments.length - 1].push(p);
  });
  const path = (seg) => seg.map((p) => `${x(p.t).toFixed(1)},${y(p.rps).toFixed(1)}`).join(' ');
  const errs = points.filter((p) => p.errorsPerSec > 0);
  // o nome do Job marca quando o k6 foi criado; o pod começa a gerar carga segundos depois
  const start = k6Start(memory.k6?.job);
  const marks = [[start, `k6 · ${memory.k6?.vus} VUs`]].filter(([t]) => t && now - t < TRAFFIC_WINDOW);
  return (
    <div className="tchart">
      <div className="tchart-y" aria-hidden="true"><span>{top}</span><span>{top / 2}</span><span>0</span></div>
      <div className="tplot">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
        aria-label={`${name}: requests per second over the last 5 minutes`}>
        {[0, 0.5, 1].map((f) => <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} className={f === 1 ? 'base' : 'grid'} vectorEffect="non-scaling-stroke" />)}
        {segments.filter((seg) => seg.length > 1).map((seg) => (
          <g key={seg[0].t}>
            <polygon points={`${x(seg[0].t)},${h} ${path(seg)} ${x(seg[seg.length - 1].t)},${h}`} className="area" />
            <polyline points={path(seg)} className="rps" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {errs.map((p) => <line key={p.t} x1={x(p.t)} x2={x(p.t)} y1={h} y2={h - 10} className="err" vectorEffect="non-scaling-stroke" />)}
        {marks.map(([t]) => <line key={t} x1={x(t)} x2={x(t)} y1="0" y2={h} className="mark" vectorEffect="non-scaling-stroke" />)}
      </svg>
      {marks.map(([t, label]) => <span key={label} className="tmark" style={{ left: `calc(${(x(t) / w) * 100}% + 4px)` }}>{label}</span>)}
      </div>
    </div>
  );
}

// Carga do serviço dentro do próprio cartão: req/s agora, p95, pico e o gráfico de 5 min.
function ServiceTraffic({ d }) {
  const pts = memory.traffic[d.name] || [];
  const last = pts[pts.length - 1];
  const peak = pts.reduce((m, p) => Math.max(m, p.rps), 0);
  return (
    <div className="svc-traffic">
      <div className="svc-traffic-head">
        <span className="tcell-value">{d.desired === 0 ? <span className="off">off</span> : <>{last ? fmt1(last.rps) : '—'}<small> req/s</small></>}</span>
        <span className="tcell-sub">
          p95 {last?.p95Ms != null ? <b>≤ {last.p95Ms} ms</b> : <b>—</b>} · peak <b>{fmt1(peak)}</b> ·{' '}
          {last?.errorsPerSec ? <span className="bad">{fmt1(last.errorsPerSec)} errors/s</span> : <><b>0</b> errors/s</>}
        </span>
      </div>
      <TrafficChart name={d.name} points={pts} />
      <div className="scale-axis"><span>5 min ago</span><span>now</span></div>
    </div>
  );
}

// ---------- autoscaling ----------

const SCALE_WINDOW = 20 * 60; // segundos: a mesma escala de tempo para todos os serviços

function hpaState(d) {
  const h = d.hpa;
  if (d.desired === 0) return { cls: '', txt: 'Off; autoscaler paused' };
  if (h.active === false) return { cls: 'busy', txt: 'Waiting for CPU metrics' };
  if ((h.desired ?? d.desired) > d.desired) return { cls: 'busy', txt: `Scaling up to ${h.desired}` };
  if ((h.desired ?? d.desired) < d.desired) return { cls: 'busy', txt: `Scaling down to ${h.desired}` };
  if (h.limited === 'TooManyReplicas') return { cls: 'held', txt: 'At the maximum' };
  if (d.desired > h.min) return { cls: 'busy', txt: `${d.desired - h.min} above the minimum` };
  return { cls: '', txt: 'At the minimum' };
}

function ScaleChart({ d }) {
  const pts = d.scaleHistory || [];
  const w = 240; const h = 96;
  const now = pts.length ? pts[pts.length - 1].t : 0;
  const top = Math.max(d.hpa.max, ...pts.map((p) => p.desired), 1);
  const x = (t) => w - ((now - t) / SCALE_WINDOW) * w;
  const y = (n) => h - (n / top) * (h - 4);
  const yCpu = (c) => h - (Math.min(c, 200) / 200) * (h - 4);
  const steps = (field) => pts.map((p, i) => `${i ? `${x(p.t)},${y(pts[i - 1][field])} ` : ''}${x(p.t)},${y(p[field])}`).join(' ');
  const cpu = pts.filter((p) => p.cpu != null).map((p) => `${x(p.t)},${yCpu(p.cpu)}`).join(' ');
  return (
    <svg className="scale-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
      aria-label={`${d.name}: pods over the last 20 minutes, now ${d.ready} ready of ${d.desired}`}>
      <line x1="0" x2={w} y1={h} y2={h} className="grid" vectorEffect="non-scaling-stroke" />
      {[d.hpa.min, d.hpa.max].map((n) => <line key={n} x1="0" x2={w} y1={y(n)} y2={y(n)} className="bound" vectorEffect="non-scaling-stroke" />)}
      {cpu && <polyline points={cpu} className="cpu" vectorEffect="non-scaling-stroke" />}
      {pts.length > 1 && <polyline points={steps('desired')} className="desired" vectorEffect="non-scaling-stroke" />}
      {pts.length > 1 && <polyline points={steps('ready')} className="ready" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function Autoscaling({ deps, scaling }) {
  const withHpa = deps.filter((d) => d.hpa);
  if (!withHpa.length) return null;
  return (
    <>
      <div className="section-title">
        <h2>Autoscaling</h2>
        <p>Above 70% CPU the autoscaler adds pods at once; after 2 quiet minutes it removes one every 30 s.</p>
      </div>
      <div className="panel">
        <div className="scale-grid">
          {withHpa.map((d) => {
            const st = hpaState(d);
            return (
              <div key={d.name} className="scale">
                <div className="scale-top"><b>{d.name}</b><span>CPU <b className="num">{d.hpa.cpu ?? '—'}%</b></span></div>
                <div className={`scale-state ${st.cls}`}>{st.txt}</div>
                <div className="scale-pods"><b className="num">{d.ready}</b> ready · range {d.hpa.min}–{d.hpa.max}</div>
                <div className="tchart">
                  <div className="tchart-y" aria-hidden="true" style={{ height: 96 }}><span>{Math.max(d.hpa.max, ...(d.scaleHistory || []).map((p) => p.desired))}</span><span>0</span></div>
                  <ScaleChart d={d} />
                </div>
                <div className="scale-axis"><span>20 min ago</span><span>now</span></div>
              </div>
            );
          })}
        </div>
        <div className="legend">
          <span><i />pods ready</span>
          <span><i className="desired" />pods requested</span>
          <span><i className="cpu" />CPU, 0–200% of request</span>
          <span><i className="bound" />minimum and maximum</span>
        </div>
        {scaling?.length > 0 && (
          <div className="panel-body table-scroll">
            <table className="data">
              <thead><tr><th className="num">Age</th><th>Autoscaler</th><th>Decision</th></tr></thead>
              <tbody>
                {scaling.map((e, i) => (
                  <tr key={i}>
                    <td className="num">{age(e.ageSecs)}</td>
                    <td>{e.object.replace('HorizontalPodAutoscaler/', '')}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------- mensageria ----------

// As rotas que existem no código: quem publica, o que publica, em que fila cai e quem consome.
const ROUTES = [
  { from: ['comments'], keys: 'comment.created · comment.deleted', queue: 'articles.comment-events', to: 'articles', does: 'keeps each article’s comment count' },
  { from: ['articles'], keys: 'article.deleted', queue: 'comments.article-events', to: 'comments', does: 'deletes that article’s comments' },
  { from: ['comments', 'articles'], keys: 'comment.* · article.deleted', queue: 'live.', to: 'gateway', does: (m) => `pushes to ${m.live?.clients ?? 0} open article ${m.live?.clients === 1 ? 'page' : 'pages'}` },
];

function rememberBus(m) {
  const now = Math.floor(Date.now() / 1000);
  const list = memory.bus || [];
  const last = list.length ? list[list.length - 1].t : -Infinity;
  memory.bus = list.concat((m.history || []).filter((p) => p.t > last)).filter((p) => p.t >= now - TRAFFIC_WINDOW - 10);
}

// Uma rota com várias filas (live.<pod> do gateway) soma as filas.
function queueFor(b, name) {
  const qs = (b.queues || []).filter((q) => (name.endsWith('.') ? q.name.startsWith(name) : q.name === name));
  if (!qs.length) return null;
  const sum = (k) => qs.reduce((n, q) => n + (q[k] || 0), 0);
  return { count: qs.length, ready: sum('ready'), consumers: sum('consumers'), flow: sum('publishRate') + sum('ackRate') };
}

function Route({ r, m }) {
  const b = m.broker || {};
  const q = b.up ? queueFor(b, r.queue) : null;
  const held = r.from.reduce((n, s) => n + (m.services?.[s]?.outboxPending || 0), 0);
  const state = !b.up ? 'off' : !q ? 'off' : !q.consumers ? 'bad' : q.ready ? 'busy' : q.flow > 0 ? 'flowing' : '';
  const qname = r.queue.endsWith('.') ? `${r.queue}<gateway pod>` : r.queue;
  return (
    <li className={`bus-route ${state}`}>
      <div className="route-end">
        <b>{r.from.join(' + ')}</b>
        <span className={held ? 'warn' : ''}>{held ? `${held} waiting in outbox` : 'outbox empty'}</span>
      </div>
      <div className="route-line" aria-hidden="true"><span>{r.keys}</span><i /></div>
      <div className="route-queue">
        <b>{qname}{q?.count > 1 && <small> ×{q.count}</small>}</b>
        <span className={state === 'bad' ? 'bad' : state === 'busy' ? 'warn' : ''}>
          {!b.up ? 'broker unreachable' : !q ? 'not declared yet' : !q.consumers ? `${q.ready} queued · no consumer` : `${q.ready} queued · ${q.consumers} ${q.consumers === 1 ? 'consumer' : 'consumers'}`}
        </span>
      </div>
      <div className="route-line short" aria-hidden="true"><i /></div>
      <div className="route-end">
        <b>{r.to}</b>
        <span>{typeof r.does === 'function' ? r.does(m) : r.does}</span>
      </div>
    </li>
  );
}

// Eventos por segundo (publicados × entregues) e o que está parado nas outboxes.
function BusChart({ points }) {
  const w = 300; const h = 110; const hb = 36;
  const now = Math.floor(Date.now() / 1000);
  const delivered = (p) => p.consumed + p.live;
  const top = niceMax(Math.max(...points.map((p) => Math.max(p.published, delivered(p))), 1) * 1.1);
  const topHeld = Math.max(...points.map((p) => p.outbox), 0);
  const x = (t) => w - ((now - t) / TRAFFIC_WINDOW) * w;
  const y = (v) => h - (v / top) * h;
  const segments = [];
  points.forEach((p, i) => {
    if (!i || p.t - points[i - 1].t > 6) segments.push([]);
    segments[segments.length - 1].push(p);
  });
  const path = (seg, f, yy = y) => seg.map((p) => `${x(p.t).toFixed(1)},${yy(f(p)).toFixed(1)}`).join(' ');
  const yb = (v) => hb - (topHeld ? (v / topHeld) * hb : 0);
  return (
    <>
      <div className="tchart">
        <div className="tchart-y" style={{ height: h }} aria-hidden="true"><span>{top}</span><span>{top / 2}</span><span>0</span></div>
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height: h }} role="img" aria-label="Events published and delivered per second over the last 5 minutes">
          {[0, 0.5, 1].map((f) => <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} className={f === 1 ? 'base' : 'grid'} vectorEffect="non-scaling-stroke" />)}
          {segments.filter((seg) => seg.length > 1).map((seg) => (
            <g key={seg[0].t}>
              <polygon points={`${x(seg[0].t)},${h} ${path(seg, (p) => p.published)} ${x(seg[seg.length - 1].t)},${h}`} className="area" />
              <polyline points={path(seg, (p) => p.published)} className="rps" vectorEffect="non-scaling-stroke" />
              <polyline points={path(seg, delivered)} className="del" vectorEffect="non-scaling-stroke" />
            </g>
          ))}
        </svg>
      </div>
      {topHeld > 0 && (
        <>
        <div className="held-label">Waiting in outboxes</div>
        <div className="tchart held-chart">
          <div className="tchart-y" style={{ height: hb }} aria-hidden="true"><span>{topHeld}</span><span>0</span></div>
          <svg viewBox={`0 0 ${w} ${hb}`} preserveAspectRatio="none" style={{ height: hb }} role="img" aria-label={`Events waiting in outboxes, up to ${topHeld}`}>
            <line x1="0" x2={w} y1={hb} y2={hb} className="base" vectorEffect="non-scaling-stroke" />
            {segments.filter((seg) => seg.length > 1).map((seg) => (
              <polygon key={seg[0].t} points={`${x(seg[0].t)},${hb} ${path(seg, (p) => p.outbox, yb)} ${x(seg[seg.length - 1].t)},${hb}`} className="held" />
            ))}
          </svg>
        </div>
        </>
      )}
    </>
  );
}

const QUEUE_INFO = {
  'comments.article-events': 'article.deleted → comments deletes that article’s comments',
  'articles.comment-events': 'comment.created / comment.deleted → articles updates the comment count',
  'conduit.dead': 'dead letters: messages that could not be processed',
};
const queueInfo = (name) => QUEUE_INFO[name]
  || (name.startsWith('live.') ? 'one gateway pod’s own queue: forwards comment events to browsers' : '');

function Messaging({ m, rabbit, act, busy }) {
  if (!m) return null;
  const b = m.broker || {};
  const services = Object.entries(m.services || {});
  const pts = memory.bus || [];
  const last = pts[pts.length - 1];
  const held = services.reduce((n, [, s]) => n + (s.outboxPending || 0), 0);
  const dead = (b.queues || []).find((q) => q.name === 'conduit.dead');
  const on = rabbit ? rabbit.desired > 0 : b.up;
  return (
    <>
      <div className="section-title">
        <h2>Messaging</h2>
        <p>Each change writes its event to an outbox in the same database transaction. A relay publishes it to RabbitMQ; each consumer records it in an inbox, so a redelivered message is ignored.</p>
      </div>
      <div className="panel">
        <div className="panel-body">
          <div className="broker">
            {b.up
              ? <><Stamp kind="ok">Up</Stamp><span>RabbitMQ <b>{b.version}</b> · <b className="num">{b.connections}</b> connections · topic exchange <b>conduit.events</b></span></>
              : <><Stamp kind="off">Off</Stamp><span>RabbitMQ is not answering. Events wait in each service’s outbox; nothing on the site fails.</span></>}
            {rabbit && (on ? (
              <button className="btn btn-xs btn-danger" disabled={busy} onClick={() => act('Switch RabbitMQ off', () => ops.scale('rabbitmq', 0))}><Icon name="power" size={14} /> Switch RabbitMQ off</button>
            ) : (
              <button className="btn btn-xs" disabled={busy} onClick={() => act('Switch RabbitMQ back on', () => ops.scale('rabbitmq', 1))}><Icon name="power" size={14} /> Switch RabbitMQ on</button>
            ))}
          </div>
        </div>

        <div className="panel-body bus">
          <div className="bus-flow">
            <div className="svc-traffic-head">
              <span className="tcell-value">{last ? fmt1(last.published) : '—'}<small> events/s published</small></span>
              <span className="tcell-sub">
                delivered <b>{last ? fmt1(last.consumed + last.live) : '—'}</b>/s ·{' '}
                {held ? <span className="warn-ink"><b>{held}</b> waiting in outboxes</span> : <>outboxes <b>empty</b></>}
                {dead?.ready ? <> · <span className="bad">{dead.ready} dead letters</span></> : null}
              </span>
            </div>
            <BusChart points={pts} />
            <div className="scale-axis"><span>5 min ago</span><span>now</span></div>
            <div className="legend bus-legend">
              <span><span className="swatch" style={{ background: 'var(--accent)' }} />published</span>
              <span><span className="swatch line" />delivered (one event reaches every queue bound to it)</span>
              {pts.some((p) => p.outbox) && <span><span className="swatch" style={{ background: 'var(--warning-ink)', opacity: 0.4 }} />waiting in outboxes</span>}
            </div>
          </div>
          <div className="try">
            <h3>Try it</h3>
            <ol>
              <li>Switch RabbitMQ off.</li>
              <li>Post a comment on any article. It saves; its event waits in the comments outbox.</li>
              <li>The article’s comment count stays behind, because articles never heard about it.</li>
              <li>Switch RabbitMQ back on. The outbox drains in a second and the count catches up.</li>
            </ol>
          </div>
        </div>

        <div className="panel-body routes-body">
          <h3 className="routes-title">Routes</h3>
          <ol className="routes">
            {ROUTES.map((r) => <Route key={r.queue} r={r} m={m} />)}
          </ol>
          <p className="panel-note">A message that keeps failing goes to <b>conduit.dead</b> instead of blocking its queue{b.up ? <> ({dead?.ready || 0} there now)</> : null}. A database error puts it back on the queue to try again.</p>
        </div>

        {m.live && (
          <div className="panel-body" style={{ borderTop: '1px solid var(--rule)' }}>
            <div className="broker">
              <b>Live comments</b>
              <span><b className="num">{m.live.clients}</b> readers connected · <b className="num">{m.live.events}</b> events received · <b className="num">{m.live.delivered}</b> messages delivered</span>
            </div>
            {m.live.pods.length > 0 && (
              <div className="readers" aria-label="Readers per gateway pod">
                {m.live.pods.map((p) => (
                  <span key={p.pod} className={`reader${p.connected ? '' : ' down'}`} title={p.connected ? 'Subscribed to RabbitMQ' : 'Not subscribed: RabbitMQ unreachable'}>
                    <span>{shortPod(p.pod, 'gateway')}</span> <b>{p.clients}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <details className="panel-body bus-details">
          <summary>Queues and counters</summary>
          <div className="two">
            <div className="table-scroll">
              <table className="data">
                <thead><tr><th>Queue</th><th className="num">Ready</th><th className="num opt">Unacked</th><th className="num">Consumers</th><th className="num opt">In/s</th><th className="num opt">Ack/s</th></tr></thead>
                <tbody>
                  {(b.queues || []).map((q) => (
                    <tr key={q.name}>
                      <td><span>{q.name}</span><span className="sub">{queueInfo(q.name)}</span></td>
                      <td className={`num ${q.ready ? (q.name === 'conduit.dead' ? 'bad' : 'warn') : ''}`}>{q.ready}</td>
                      <td className="num opt">{q.unacked}</td>
                      <td className={`num ${q.consumers || q.name === 'conduit.dead' ? '' : 'bad'}`}>{q.consumers}</td>
                      <td className="num opt">{fmt1(q.publishRate)}</td>
                      <td className="num opt">{fmt1(q.ackRate)}</td>
                    </tr>
                  ))}
                  {!b.queues?.length && <tr><td colSpan="6" className="sub">{b.up ? 'No queues yet.' : 'No data while the broker is off.'}</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="table-scroll">
              <table className="data">
                <thead><tr><th>Service</th><th className="num">Outbox</th><th className="num opt">Published</th><th className="num opt">Consumed</th><th className="num">Duplicates</th><th className="num">Connected</th></tr></thead>
                <tbody>
                  {services.map(([svc, s]) => (
                    <tr key={svc}>
                      <td>{svc}</td>
                      <td className={`num ${s.outboxPending ? 'warn' : ''}`}>{s.outboxPending}</td>
                      <td className="num opt">{s.published}</td>
                      <td className="num opt">{s.consumed}</td>
                      <td className="num">{s.duplicates}</td>
                      <td className={`num ${s.connected < s.pods ? 'bad' : ''}`}>{s.connected}/{s.pods}</td>
                    </tr>
                  ))}
                  {!services.length && <tr><td colSpan="6" className="sub">No pod with messaging is running.</td></tr>}
                </tbody>
              </table>
              <p className="panel-note" style={{ marginTop: 10 }}>Counters since each pod started, summed across replicas. Duplicates are redeliveries the inbox caught and skipped.</p>
            </div>
          </div>
        </details>
      </div>
    </>
  );
}

// ---------- k6 ----------

function LoadTest({ act, busy }) {
  const [cfg, setCfg] = useState({ vus: 30, duration: '60s', scenario: 'mixed' });
  const [st, setSt] = useState(null);
  useInterval(async () => { try { const k = await ops.k6(); memory.k6 = k; setSt(k); } catch { setSt(null); } }, 3000);
  const running = st?.state === 'Rodando' || st?.state === 'Pendente';
  const state = K6_STATE[st?.state] || st?.state;
  return (
    <>
      <div className="section-title">
        <h2>Load test</h2>
        <p>k6 runs as a Job inside the cluster, inside the same CPU budget as the app.</p>
      </div>
      <div className="panel">
        <div className="panel-body">
          <div className="k6-form">
            <div className="field"><label htmlFor="k6-vus">Virtual users</label>
              <input id="k6-vus" className="input num" type="number" min="1" max="500" value={cfg.vus} onChange={(e) => setCfg({ ...cfg, vus: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="k6-dur">Duration</label>
              <select id="k6-dur" className="input" value={cfg.duration} onChange={(e) => setCfg({ ...cfg, duration: e.target.value })}>
                {['30s', '60s', '2m', '5m'].map((x) => <option key={x}>{x}</option>)}
              </select></div>
            <div className="field"><label htmlFor="k6-sc">Scenario</label>
              <select id="k6-sc" className="input" value={cfg.scenario} onChange={(e) => setCfg({ ...cfg, scenario: e.target.value })}>
                <option value="mixed">Mixed (70% reads)</option>
                <option value="read">Reads only</option>
                <option value="write">Writes only</option>
                <option value="login">Login (users CPU)</option>
              </select></div>
            <button className="btn btn-sm" disabled={busy || running} onClick={() => act(`Run k6 (${cfg.vus} VUs, ${cfg.duration})`, () => ops.k6Run(cfg))}><Icon name="play" size={14} /> Run k6</button>
            <button className="btn btn-sm btn-danger" disabled={busy || !st?.job} onClick={() => act('Stop k6', () => ops.k6Stop())}><Icon name="stop" size={14} /> Stop</button>
          </div>
          {st?.job ? (
            <>
              <div className="k6-status"><span>{st.job}</span> · <b>{state}</b> · {st.vus} VUs · {st.duration} · {st.scenario}</div>
              {running && k6Start(st.job) && seconds(st.duration) && (() => {
                const total = seconds(st.duration);
                const elapsed = Math.min(total, Math.max(0, Math.floor(Date.now() / 1000) - k6Start(st.job)));
                return (
                  <div className="k6-progress">
                    <div className="track"><i style={{ transform: `scaleX(${elapsed / total})` }} /></div>
                    <span className="num">{elapsed} s of {total} s</span>
                  </div>
                );
              })()}
              <pre className="k6-log">{st.log || (st.state === 'Rodando' ? 'k6 prints its summary when it finishes…' : 'Waiting for the k6 pod…')}</pre>
            </>
          ) : <p className="k6-status">No test has run yet. Start one and watch the Autoscaling charts react.</p>}
        </div>
      </div>
    </>
  );
}

// ---------- página ----------

function Meter({ label, used, total, unit, note, unknown }) {
  if (!total) return null;
  const ratio = unknown ? 0 : Math.min(1, used / total);
  return (
    <div className="meter">
      <div className="label">{label}</div>
      <div className="value num">{unknown ? '—' : used.toFixed(0)}<small> {unit} of {total.toFixed(0)} {unit}</small></div>
      <div className={`track${ratio > 0.85 ? ' hot' : ''}`}><i style={{ transform: `scaleX(${ratio})` }} /></div>
      <div className="ends"><span>{unknown ? 'no data' : `${Math.round(ratio * 100)}%`}</span><span>{note}</span></div>
    </div>
  );
}

function finding(deps) {
  const stuck = deps.find((d) => d.stuck);
  if (stuck) return <><b className="bad">{stuck.name} is held:</b> {stuck.version} never became ready, so the old pods keep serving.</>;
  const off = deps.filter((d) => d.desired === 0).map((d) => d.name);
  if (off.includes('comments')) return <><b>Comments are switched off.</b> Article pages show the notice; everything else is serving.</>;
  if (off.includes('rabbitmq')) return <><b>RabbitMQ is off.</b> Events wait in each service’s outbox until it returns.</>;
  const rolling = deps.find((d) => d.rolling);
  if (rolling) return <><b>{rolling.name} is updating</b> to {rolling.version}; old and new pods answer side by side.</>;
  const extra = deps.filter((d) => d.hpa && d.desired > d.hpa.min);
  if (extra.length) return <><b>The autoscaler added pods</b> to {extra.map((d) => `${d.name} (${d.desired})`).join(', ')}.</>;
  const pods = deps.reduce((n, d) => n + d.ready, 0);
  return <><b>All {deps.length} services delivering</b> with {pods} pods ready.</>;
}

export default function Monitor() {
  const [data, setData] = useState(() => memory.data);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLogState] = useState(() => memory.log);
  const [live, setLiveState] = useState(() => memory.live);
  const [updated, setUpdated] = useState(() => memory.updated);
  const setLog = (fn) => setLogState((l) => (memory.log = fn(l)));
  const setLive = (v) => { memory.live = v; setLiveState(v); };
  const [allEvents, setAllEvents] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await ops.overview();
      remember(d);
      if (d.messaging) rememberBus(d.messaging);
      memory.data = d; memory.updated = new Date();
      setData(d); setError(null); setUpdated(memory.updated);
    } catch (e) { setError(e); }
  }, []);
  useInterval(refresh, 2000);
  const pings = usePings(PINGED, live);

  const act = async (label, fn) => {
    setBusy(true);
    const t = new Date().toLocaleTimeString('en-GB');
    try {
      await fn();
      setLog((l) => [{ t, label, ok: true }, ...l].slice(0, 6));
    } catch (e) {
      setLog((l) => [{ t, label, ok: false, err: e.body?.raw || e.messages?.join(', ') || `HTTP ${e.status}` }, ...l].slice(0, 6));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (error && !data) {
    return (
      <div className="wrap monitor">
        <div className="mon-head"><div><h1>Monitor</h1></div></div>
        <div className="notice mon-error">
          <Stamp kind="off">Unreachable</Stamp>
          <div>
            <h3>The ops service is not answering</h3>
            <p>The Monitor talks to the Kubernetes API through the ops service, which only runs inside the cluster. Open the site through the minikube address.</p>
            <div className="meta">Service: ops · {error.status ? `HTTP ${error.status}` : 'network error'} · retrying every 2 s</div>
          </div>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="wrap monitor">
        <div className="mon-head"><div><h1>Monitor</h1><p className="finding">Reading the cluster…</p></div></div>
        <div className="panel meters" aria-hidden="true">{[0, 1, 2, 3].map((i) => <div className="meter" key={i}><span className="skeleton short" /><span className="skeleton title" /></div>)}</div>
      </div>
    );
  }

  const deps = [...data.deployments].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
  const podsOf = (name) => data.pods.filter((p) => p.app === name);
  const node = data.nodes?.[0];
  const q = data.quota;

  return (
    <div className="wrap monitor">
      <div className="mon-head">
        <div>
          <h1>Monitor</h1>
          <p className="finding">{finding(deps)}</p>
        </div>
        <div className="mon-tools">
          <label className="switch"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live traffic, 4 requests/s per service</label>
          <span className="footer-note num">namespace {data.namespace} · updated {updated?.toLocaleTimeString('en-GB')}</span>
        </div>
      </div>

      <div className="panel meters">
        {node && <Meter label="Node CPU" used={node.cpuMilli} total={node.cpuCapacityMilli} unit="m" note={node.name} unknown={!data.metricsAvailable} />}
        {node && <Meter label="Node memory" used={node.memMi} total={node.memCapacityMi} unit="Mi" note={`kubelet ${node.kubelet}`} unknown={!data.metricsAvailable} />}
        {q && <Meter label="CPU reserved by the app" used={q.cpuRequests.used || 0} total={q.cpuRequests.hard} unit="m" note={`quota ${q.name}`} />}
        {q && <Meter label="Memory reserved by the app" used={q.memRequests.used || 0} total={q.memRequests.hard} unit="Mi" note={`limits ${(q.memLimits.used || 0).toFixed(0)} of ${q.memLimits.hard?.toFixed(0)} Mi`} />}
      </div>
      {!data.metricsAvailable && <p className="panel-note" style={{ marginTop: 8 }}>metrics-server has no data yet, so CPU and memory read as dashes.</p>}

      {log.length > 0 && (
        <div className="panel log" role="log" aria-label="Your actions">
          {log.map((l, i) => <div key={i} className={l.ok ? '' : 'bad'}><span className="num">{l.t}</span> · <b>{l.label}</b> {l.ok ? 'sent' : `failed: ${l.err}`}</div>)}
        </div>
      )}

      <Autoscaling deps={deps} scaling={data.scaling} />

      <div className="section-title">
        <h2>Services</h2>
        <p>Each square is one real request, coloured by the version that answered it; a hollow red square failed. The chart is the load the service handled, summed over its pods.</p>
      </div>
      <div className="legend" style={{ border: 0, padding: '0 0 12px' }}>
        <span><span className="swatch" style={{ background: 'var(--v1)' }} />v1</span>
        <span><span className="swatch" style={{ background: 'var(--v2)' }} />v2</span>
        <span><span className="swatch" style={{ background: 'var(--v3)' }} />v3 (broken)</span>
        <span><span className="swatch" style={{ background: 'var(--negative)' }} />failed</span>
      </div>
      <div className="services">
        {deps.map((d) => <ServiceCard key={d.name} d={d} pods={podsOf(d.name)} pings={pings[d.name]} act={act} busy={busy} metrics={data.metricsAvailable} />)}
      </div>

      <Messaging m={data.messaging} rabbit={deps.find((d) => d.name === 'rabbitmq')} act={act} busy={busy} />
      <LoadTest act={act} busy={busy} />

      <div className="section-title"><h2>Kubernetes events</h2><p>Newest first, from the namespace.</p>
        {data.events.length > 10 && <button className="btn btn-xs btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => setAllEvents((v) => !v)}>{allEvents ? 'Show the latest 10' : `Show all ${data.events.length}`}</button>}
      </div>
      <div className="panel">
        <div className="panel-body table-scroll">
          <table className="data">
            <thead><tr><th className="num">Age</th><th>Reason</th><th>Object</th><th>Message</th></tr></thead>
            <tbody>
              {(allEvents ? data.events : data.events.slice(0, 10)).map((e, i) => (
                <tr key={i}>
                  <td className="num">{age(e.ageSecs)}</td>
                  <td className={e.type === 'Warning' ? 'bad' : ''}>{e.reason}</td>
                  <td><span>{e.object}</span></td>
                  <td>{e.message}</td>
                </tr>
              ))}
              {!data.events.length && <tr><td colSpan="4" className="sub">No recent events.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
