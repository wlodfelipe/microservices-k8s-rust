import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ops } from '../lib/api';

// Aba Monitor: estado do cluster (via serviço `ops`) + tráfego ao vivo (via gateway).
//
// - Cada card é um Deployment. "Subir versão" troca a tag da imagem e o Kubernetes faz o
//   rolling update; a faixa de quadradinhos mostra, em tempo real, qual versão/pod
//   respondeu cada requisição (vermelho = erro). Numa atualização bem feita não aparece
//   vermelho nenhum.
// - "Desligar comentários" zera as réplicas do serviço de comentários: o site segue no ar
//   e a página do artigo mostra "Comentários desativados".
// - Mensageria: filas do RabbitMQ e a outbox de cada serviço. Desligar o RabbitMQ não
//   derruba nada: os eventos esperam na outbox e saem quando ele volta.

const VERSION_COLORS = { v1: '#5cb85c', v2: '#3d8bfd', v3: '#f0ad4e', dev: '#999' };
const vColor = (v) => VERSION_COLORS[v] || '#8e6dd8';
const STRIP = 60;
const ORDER = ['web', 'gateway', 'users', 'articles', 'comments', 'ops', 'postgres', 'rabbitmq'];

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
  if (s == null) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const shortPod = (name, app) => (name?.startsWith(`${app}-`) ? name.slice(app.length + 1) : name);

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
    if (!r.ok) return { ok: false, error: r.endpoints === 0 ? 'sem pods prontos' : 'indisponível', ms: performance.now() - t0 };
    return { ok: true, version: r.version, pod: r.pod, ms: performance.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.status === 503 ? 'indisponível' : `erro ${e.status || ''}`, ms: performance.now() - t0 };
  }
}

function usePings(services, enabled) {
  const [pings, setPings] = useState({});
  const busy = useRef({});
  useInterval(() => {
    services.forEach(async (svc) => {
      if (busy.current[svc]) return;
      busy.current[svc] = true;
      const p = await pingOnce(svc);
      busy.current[svc] = false;
      setPings((all) => {
        const list = [...(all[svc] || []), { ...p, t: Date.now() }].slice(-STRIP);
        return { ...all, [svc]: list };
      });
    });
  }, 250, enabled);
  return pings;
}

function Strip({ pings }) {
  const list = pings || [];
  const errors = list.filter((p) => !p.ok).length;
  const last = list[list.length - 1];
  const byPod = {};
  list.slice(-20).forEach((p) => { if (p.ok && p.pod) byPod[p.pod] = (byPod[p.pod] || 0) + 1; });
  return (
    <div className="strip-wrap">
      <div className="strip">
        {Array.from({ length: STRIP - list.length }).map((_, i) => <span key={`e${i}`} className="sq empty" />)}
        {list.map((p) => (
          <span key={p.t} className="sq" title={p.ok ? `${p.version} · ${p.pod} · ${p.ms.toFixed(0)} ms` : p.error}
            style={{ background: p.ok ? vColor(p.version) : '#d9534f' }} />
        ))}
      </div>
      <div className="strip-legend">
        {last ? (last.ok ? <>última: <b style={{ color: vColor(last.version) }}>{last.version}</b> de <code>{last.pod}</code></> : <b className="text-danger">{last.error}</b>) : 'aguardando…'}
        {' · '}erros: <b className={errors ? 'text-danger' : ''}>{errors}/{list.length}</b>
        {Object.keys(byPod).length > 1 && <> · balanceamento (últimas 20): {Object.entries(byPod).map(([pod, n]) => <span key={pod} className="lb-chip">{pod.split('-').slice(-1)[0]}: {n}</span>)}</>}
      </div>
    </div>
  );
}

function Sparkline({ history, field = 'rps', color = '#5cb85c' }) {
  const pts = (history || []).map((h) => h[field] || 0);
  if (pts.length < 2) return <svg className="spark" />;
  const max = Math.max(1, ...pts);
  const w = 160; const h = 32;
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

// ---------- card de cada Deployment ----------

function DeploymentCard({ d, pods, pings, act, busy }) {
  const versions = d.versions || [];
  const idx = versions.indexOf(d.version);
  const next = idx >= 0 && idx < versions.length - 1 ? versions[idx + 1] : null;
  const isComments = d.name === 'comments';
  const status = d.stuck ? { cls: 'bad', txt: 'Rollout travado (versão nova não fica pronta)' }
    : d.rolling ? { cls: 'warn', txt: 'Atualizando…' }
      : d.desired === 0 ? { cls: 'off', txt: 'Desligado (0 réplicas)' }
        : d.ready < d.desired ? { cls: 'warn', txt: 'Subindo pods…' } : { cls: 'ok', txt: 'Estável' };
  const running = Object.entries(d.running || {});
  const last = d.history?.[d.history.length - 1];
  const showStrip = ['web', 'gateway', 'users', 'articles', 'comments'].includes(d.name);

  return (
    <div className={`dep-card ${status.cls}`}>
      <div className="dep-head">
        <div>
          <h3>{d.name}</h3>
          <div className="dep-desc">{d.description}</div>
        </div>
        <div className="dep-status">
          <span className={`pill ${status.cls}`}>{status.txt}</span>
          <div className="dep-replicas">{d.ready}/{d.desired} prontos{d.hpa ? ` · HPA ${d.hpa.min}–${d.hpa.max}${d.hpa.cpu != null ? ` (CPU ${d.hpa.cpu}% / alvo ${d.hpa.targetCpu}%)` : ''}` : ''}</div>
          {d.hpa && d.hpa.defaultMin != null && d.hpa.min !== d.hpa.defaultMin && (
            <button className="btn btn-sm btn-outline-primary hpa-reset" disabled={busy} title={`mínimo fixado em ${d.hpa.min} pelos botões − / +`}
              onClick={() => act(`Devolver ${d.name} ao automático (mínimo ${d.hpa.defaultMin})`, () => ops.hpaReset(d.name))}>↺ automático (mín. {d.hpa.defaultMin})</button>
          )}
        </div>
      </div>

      <div className="dep-versions">
        <span>imagem: <code>{d.image?.split('/').slice(-1)[0]}</code></span>
        {running.length > 0 && <span> · rodando: {running.map(([v, n]) => <span key={v} className="vbadge" style={{ background: vColor(v) }}>{v} ×{n}</span>)}</span>}
      </div>
      {d.stuck && d.message && <div className="dep-msg">{d.message}</div>}

      {versions.length > 0 && (
        <div className="dep-actions">
          {next && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(`Subir ${d.name} para ${next}`, () => ops.setVersion(d.name, next))}>
              <i className="ion-arrow-up-c" /> Subir para {next}{next === 'v3' ? ' (com defeito)' : ''}
            </button>
          )}
          {versions.map((v) => (
            <button key={v} className={`btn btn-sm ${v === d.version ? 'btn-secondary' : 'btn-outline-secondary'}`} disabled={busy || v === d.version}
              title={v === 'v3' ? 'versão com defeito: readiness nunca passa' : ''}
              onClick={() => act(`Trocar ${d.name} para ${v}`, () => ops.setVersion(d.name, v))}>{v}{v === 'v3' ? ' ⚠' : ''}</button>
          ))}
        </div>
      )}

      <div className="dep-actions">
        {!['postgres', 'ops', 'rabbitmq'].includes(d.name) && (
          <>
            <button className="btn btn-sm btn-outline-secondary" disabled={busy || d.desired <= (d.hpa ? 1 : 0)} onClick={() => act(`Escalar ${d.name} para ${d.desired - 1}`, () => ops.scale(d.name, d.desired - 1))}>−</button>
            <span className="replicas">{d.desired}</span>
            <button className="btn btn-sm btn-outline-secondary" disabled={busy || d.desired >= 8} onClick={() => act(`Escalar ${d.name} para ${d.desired + 1}`, () => ops.scale(d.name, d.desired + 1))}>+</button>
            <button className="btn btn-sm btn-outline-secondary" disabled={busy} onClick={() => act(`Reiniciar ${d.name} (rolling)`, () => ops.restart(d.name))}><i className="ion-refresh" /> Reiniciar</button>
          </>
        )}
        <button className="btn btn-sm btn-outline-danger" disabled={busy || !pods.length} onClick={() => act(`Excluir todos os pods de ${d.name}`, () => ops.killPods(d.name))}>
          <i className="ion-trash-a" /> Excluir pods
        </button>
        {isComments && (d.desired > 0 ? (
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => act('Desligar comentários (0 réplicas)', () => ops.scale('comments', 0))}>
            <i className="ion-power" /> Desligar comentários
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('Religar comentários (2 réplicas)', () => ops.scale('comments', 2))}>
            <i className="ion-power" /> Religar comentários
          </button>
        ))}
        {d.name === 'rabbitmq' && (d.desired > 0 ? (
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => act('Desligar RabbitMQ (0 réplicas)', () => ops.scale('rabbitmq', 0))}>
            <i className="ion-power" /> Desligar RabbitMQ
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('Religar RabbitMQ', () => ops.scale('rabbitmq', 1))}>
            <i className="ion-power" /> Religar RabbitMQ
          </button>
        ))}
      </div>

      {showStrip && <Strip pings={pings} />}

      {d.history && (
        <div className="dep-traffic">
          <Sparkline history={d.history} />
          <span>{last ? `${last.rps.toFixed(1)} req/s` : '–'}{last?.p95Ms != null ? ` · p95 ≤ ${last.p95Ms} ms` : ''}{last?.errorsPerSec ? <b className="text-danger"> · {last.errorsPerSec.toFixed(1)} erros/s</b> : ''}</span>
        </div>
      )}

      <table className="pods">
        <thead>
          <tr><th /><th>pod</th><th>versão</th><th>estado</th><th>idade</th><th className="num">CPU</th><th className="num">memória</th><th className="num">req/s</th><th /></tr>
        </thead>
        <tbody>
          {pods.map((p) => (
            <tr key={p.name} className={p.phase === 'Terminating' ? 'terminating' : ''}>
              <td><span className={`dot ${p.ready ? 'ok' : p.phase === 'Terminating' ? 'off' : 'warn'}`} /></td>
              <td><code title={p.name}>{shortPod(p.name, d.name)}</code></td>
              <td><span className="vbadge" style={{ background: vColor(p.version) }}>{p.version}</span></td>
              <td className="muted">{p.phase}{p.restarts ? ` · ${p.restarts}↻` : ''}</td>
              <td className="muted">{age(p.ageSecs)}</td>
              <td className="num">{p.cpuMilli ? `${p.cpuMilli.toFixed(0)} mCPU` : ''}</td>
              <td className="num">{p.memMi ? `${p.memMi.toFixed(0)}Mi` : ''}</td>
              <td className="num">{p.traffic ? `${p.traffic.rps.toFixed(1)}/s` : ''}</td>
              <td><button className="btn-x" title="excluir pod (o Deployment recria)" disabled={busy || p.phase === 'Terminating'} onClick={() => act(`Excluir pod ${p.name}`, () => ops.deletePod(p.name))}>×</button></td>
            </tr>
          ))}
          {!pods.length && <tr><td colSpan="9" className="muted">nenhum pod</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------- autoscaling ----------

const SCALE_WINDOW = 20 * 60; // segundos mostrados no gráfico

function hpaState(d) {
  const h = d.hpa;
  if (d.desired === 0) return { cls: 'off', txt: 'desligado (HPA pausado)' };
  if (h.active === false) return { cls: 'warn', txt: 'sem métrica de CPU' };
  if ((h.desired ?? d.desired) > d.desired) return { cls: 'warn', txt: `subindo para ${h.desired}` };
  if ((h.desired ?? d.desired) < d.desired) return { cls: 'warn', txt: `descendo para ${h.desired}` };
  if (h.limited === 'TooManyReplicas') return { cls: 'bad', txt: 'no máximo' };
  if (d.desired > h.min) return { cls: 'warn', txt: 'acima do mínimo' };
  return { cls: 'ok', txt: 'no mínimo' };
}

function ScaleChart({ d }) {
  const pts = d.scaleHistory || [];
  const w = 300; const h = 70;
  const now = pts.length ? pts[pts.length - 1].t : 0;
  const top = Math.max(d.hpa.max, ...pts.map((p) => p.desired), 1);
  const x = (t) => w - ((now - t) / SCALE_WINDOW) * w;
  const y = (n) => h - 2 - (n / top) * (h - 6);
  const yCpu = (c) => h - 2 - (Math.min(c, 200) / 200) * (h - 6);
  const steps = (field) => pts.map((p, i) => `${i ? `${x(p.t)},${y(pts[i - 1][field])} ` : ''}${x(p.t)},${y(p[field])}`).join(' ');
  const cpu = pts.filter((p) => p.cpu != null).map((p) => `${x(p.t)},${yCpu(p.cpu)}`).join(' ');
  return (
    <svg className="scale-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
      aria-label={`réplicas de ${d.name} nos últimos 20 minutos`}>
      {[d.hpa.min, d.hpa.max].map((n) => <line key={n} x1="0" x2={w} y1={y(n)} y2={y(n)} className="scale-limit" />)}
      <line x1="0" x2={w} y1={yCpu(d.hpa.targetCpu || 70)} y2={yCpu(d.hpa.targetCpu || 70)} className="scale-target" />
      {cpu && <polyline points={cpu} className="scale-cpu" />}
      {pts.length > 1 && <polyline points={steps('ready')} className="scale-ready" />}
      {pts.length > 1 && <polyline points={steps('desired')} className="scale-desired" />}
    </svg>
  );
}

function AutoscalingPanel({ deps, scaling }) {
  const withHpa = deps.filter((d) => d.hpa);
  if (!withHpa.length) return null;
  return (
    <div className="panel">
      <h4>Autoscaling (HPA)</h4>
      <p className="muted">
        Cada serviço tem um mínimo e um máximo de pods. Quando a CPU média passa de 70% do que o pod reservou, o HPA
        cria pods na hora (dobra a cada 15 s se precisar). Quando a carga vai embora, espera 2 min e tira 1 pod a cada
        30 s até voltar ao mínimo. Os botões − / + do card fixam um mínimo novo; <b>↺ automático</b> devolve ao original.
      </p>
      <div className="scale-grid">
        {withHpa.map((d) => {
          const st = hpaState(d);
          return (
            <div key={d.name} className="scale-item">
              <div className="scale-head">
                <b>{d.name}</b>
                <span className={`pill ${st.cls}`}>{st.txt}</span>
                <span className="muted">{d.ready}/{d.desired} pods · {d.hpa.min}–{d.hpa.max} · CPU {d.hpa.cpu ?? '–'}%</span>
              </div>
              <ScaleChart d={d} />
            </div>
          );
        })}
      </div>
      <div className="muted small scale-legend">
        <span className="lg lg-desired" /> pods pedidos <span className="lg lg-ready" /> pods prontos
        <span className="lg lg-cpu" /> CPU (% do request, até 200%) <span className="lg lg-target" /> alvo 70%
        · tracejado: mínimo e máximo · últimos 20 min
      </div>
      {scaling?.length > 0 && (
        <table className="events scale-events">
          <tbody>
            {scaling.map((e, i) => (
              <tr key={i}>
                <td className="muted">{age(e.ageSecs)}</td>
                <td><code>{e.object.replace('HorizontalPodAutoscaler/', '')}</code></td>
                <td>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- mensageria ----------

const QUEUE_INFO = {
  'comments.article-events': 'article.deleted → comments apaga os comentários do artigo',
  'articles.comment-events': 'comment.created / comment.deleted → articles atualiza o contador 💬',
  'conduit.dead': 'dead-letter: mensagens que não puderam ser processadas',
};

const queueInfo = (name) => QUEUE_INFO[name]
  || (name.startsWith('live.') ? 'fila própria de um pod do gateway: repassa comment.* aos navegadores (WebSocket)' : '');

function MessagingPanel({ m }) {
  if (!m) return null;
  const b = m.broker || {};
  const services = Object.entries(m.services || {});
  return (
    <div className="panel">
      <h4>Mensageria (RabbitMQ)</h4>
      <p className="muted">
        Cada serviço grava o evento na própria <b>outbox</b> (mesma transação da mudança) e um laço publica no exchange{' '}
        <code>conduit.events</code>. Quem consome registra o id da mensagem no <b>inbox</b> para não processar duas vezes.
        Experimente: desligue os comentários, apague um artigo com comentários e veja a mensagem esperando na fila;
        ou desligue o RabbitMQ e veja a outbox crescer sem nenhum erro no site.
      </p>
      <div className="mq-broker">
        {b.up
          ? <><span className="pill ok">no ar</span> RabbitMQ {b.version} · {b.connections} conexões · publicando {b.publishRate?.toFixed(1)}/s · entregando {b.deliverRate?.toFixed(1)}/s</>
          : <><span className="pill bad">fora do ar</span> os eventos ficam na outbox de cada serviço até ele voltar</>}
      </div>
      <div className="mq-grid">
        <table className="pods">
          <thead><tr><th>fila</th><th className="num">prontas</th><th className="num">em processamento</th><th className="num">consumidores</th><th className="num">entrada/s</th><th className="num">ack/s</th></tr></thead>
          <tbody>
            {(b.queues || []).map((q) => (
              <tr key={q.name}>
                <td><code>{q.name}</code><div className="muted small">{queueInfo(q.name)}</div></td>
                <td className={`num ${q.ready ? (q.name === 'conduit.dead' ? 'text-danger' : 'text-warn') : ''}`}><b>{q.ready}</b></td>
                <td className="num">{q.unacked}</td>
                <td className={`num ${q.consumers ? '' : 'text-danger'}`}>{q.consumers}</td>
                <td className="num">{q.publishRate.toFixed(1)}</td>
                <td className="num">{q.ackRate.toFixed(1)}</td>
              </tr>
            ))}
            {!b.queues?.length && <tr><td colSpan="6" className="muted">{b.up ? 'nenhuma fila ainda' : 'sem dados do broker'}</td></tr>}
          </tbody>
        </table>
        <table className="pods">
          <thead><tr><th>serviço</th><th className="num">outbox</th><th className="num">publicados</th><th className="num">consumidos</th><th className="num">duplicados</th><th className="num">conectados</th></tr></thead>
          <tbody>
            {services.map(([svc, s]) => (
              <tr key={svc}>
                <td>{svc}</td>
                <td className={`num ${s.outboxPending ? 'text-warn' : ''}`}><b>{s.outboxPending}</b></td>
                <td className="num">{s.published}</td>
                <td className="num">{s.consumed}</td>
                <td className="num">{s.duplicates}</td>
                <td className={`num ${s.connected < s.pods ? 'text-danger' : ''}`}>{s.connected}/{s.pods}</td>
              </tr>
            ))}
            {!services.length && <tr><td colSpan="6" className="muted">nenhum pod com mensageria no ar</td></tr>}
          </tbody>
        </table>
      </div>
      {m.live && (
        <div className="mq-live">
          <b>Comentários ao vivo (WebSocket):</b> {m.live.clients} leitores conectados ·{' '}
          {m.live.events} eventos recebidos · {m.live.delivered} mensagens entregues
          {m.live.pods.length > 0 && <> · por pod: {m.live.pods.map((p) => (
            <span key={p.pod} className={`lb-chip ${p.connected ? '' : 'text-danger'}`} title={p.connected ? 'assinando o RabbitMQ' : 'sem RabbitMQ'}>
              {shortPod(p.pod, 'gateway')}: {p.clients}
            </span>
          ))}</>}
        </div>
      )}
      <div className="muted small">Contadores desde o início de cada pod (somados entre as réplicas). A outbox é por banco: mostra o que ainda não chegou ao RabbitMQ.</div>
    </div>
  );
}

// ---------- k6 ----------

function K6Panel({ act, busy }) {
  const [cfg, setCfg] = useState({ vus: 30, duration: '60s', scenario: 'mixed' });
  const [st, setSt] = useState(null);
  useInterval(async () => { try { setSt(await ops.k6()); } catch { setSt(null); } }, 3000);
  const running = st?.state === 'Rodando' || st?.state === 'Pendente';
  return (
    <div className="panel">
      <h4>Teste de carga (k6 dentro do cluster)</h4>
      <div className="k6-form">
        <label>VUs <input type="number" min="1" max="500" value={cfg.vus} onChange={(e) => setCfg({ ...cfg, vus: Number(e.target.value) })} /></label>
        <label>Duração <select value={cfg.duration} onChange={(e) => setCfg({ ...cfg, duration: e.target.value })}>
          {['30s', '60s', '2m', '5m'].map((x) => <option key={x}>{x}</option>)}
        </select></label>
        <label>Cenário <select value={cfg.scenario} onChange={(e) => setCfg({ ...cfg, scenario: e.target.value })}>
          <option value="mixed">misto (70% leitura)</option>
          <option value="read">só leitura</option>
          <option value="write">só escrita</option>
          <option value="login">login (CPU do users)</option>
        </select></label>
        <button className="btn btn-sm btn-primary" disabled={busy || running} onClick={() => act(`Rodar k6 (${cfg.vus} VUs, ${cfg.duration})`, () => ops.k6Run(cfg))}>Rodar k6</button>
        <button className="btn btn-sm btn-outline-danger" disabled={busy || !st?.job} onClick={() => act('Parar k6', () => ops.k6Stop())}>Parar</button>
      </div>
      {st?.job && (
        <>
          <div className="muted">{st.job} · <b>{st.state}</b> · {st.vus} VUs · {st.duration} · {st.scenario}</div>
          <pre className="k6-log">{st.log || (st.state === 'Rodando' ? '(o k6 imprime o resumo quando termina…)' : '(aguardando o pod do k6…)')}</pre>
        </>
      )}
    </div>
  );
}

// ---------- página ----------

function Bar({ label, used, total, unit }) {
  if (!total) return null;
  const pct = Math.min(100, (used / total) * 100);
  return (
    <div className="bar">
      <div className="bar-label">{label}: <b>{used.toFixed(0)}{unit}</b> / {total.toFixed(0)}{unit}</div>
      <div className="bar-track"><div className={`bar-fill ${pct > 85 ? 'bad' : pct > 65 ? 'warn' : ''}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export default function Monitor() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [live, setLive] = useState(true);

  const refresh = useCallback(async () => {
    try { setData(await ops.overview()); setError(null); } catch (e) { setError(e); }
  }, []);
  useInterval(refresh, 2000);
  const pings = usePings(['web', 'gateway', 'users', 'articles', 'comments'], live);

  const act = async (label, fn) => {
    setBusy(true);
    const t = new Date().toLocaleTimeString();
    try {
      await fn();
      setLog((l) => [{ t, label, ok: true }, ...l].slice(0, 12));
    } catch (e) {
      setLog((l) => [{ t, label, ok: false, err: e.body?.raw || e.messages?.join(', ') || String(e.status) }, ...l].slice(0, 12));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (error && !data) {
    return <div className="container page monitor"><h2>Monitor</h2><div className="error-messages">Não foi possível falar com o serviço ops ({error.status || 'rede'}). Ele roda dentro do cluster: abra o site pelo endereço do minikube.</div></div>;
  }
  if (!data) return <div className="container page monitor">Carregando estado do cluster…</div>;

  const deps = [...data.deployments].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
  const podsOf = (name) => data.pods.filter((p) => p.app === name);
  const node = data.nodes?.[0];
  const q = data.quota;

  return (
    <div className="container-fluid page monitor">
      <div className="mon-top">
        <div>
          <h2>Monitor <small className="muted">namespace {data.namespace}</small></h2>
          <p className="muted">Atualiza a cada 2 s. Ações chamam a API do Kubernetes pelo serviço <code>ops</code> (ServiceAccount com RBAC restrito ao namespace).</p>
          <label className="muted"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> tráfego ao vivo (4 pings/s por serviço)</label>
        </div>
        <div className="panel res">
          <h4>Recursos</h4>
          {node && <>
            <div className="muted">nó {node.name} · kubelet {node.kubelet}</div>
            <Bar label="CPU do nó" used={node.cpuMilli} total={node.cpuCapacityMilli} unit="m" />
            <Bar label="Memória do nó" used={node.memMi} total={node.memCapacityMi} unit="Mi" />
          </>}
          {q && <>
            <div className="muted">ResourceQuota <code>{q.name}</code> (orçamento da aplicação)</div>
            <Bar label="CPU reservada" used={q.cpuRequests.used || 0} total={q.cpuRequests.hard} unit="m" />
            <Bar label="Memória reservada" used={q.memRequests.used || 0} total={q.memRequests.hard} unit="Mi" />
            <Bar label="Memória limite" used={q.memLimits.used || 0} total={q.memLimits.hard} unit="Mi" />
          </>}
          {!data.metricsAvailable && <div className="muted">metrics-server ainda sem dados (minikube addons enable metrics-server)</div>}
        </div>
      </div>

      {log.length > 0 && (
        <div className="action-log">
          {log.map((l, i) => <div key={i} className={l.ok ? '' : 'text-danger'}>{l.t} · {l.label} {l.ok ? '✓' : `✗ ${l.err}`}</div>)}
        </div>
      )}

      <div className="dep-grid">
        {deps.map((d) => <DeploymentCard key={d.name} d={d} pods={podsOf(d.name)} pings={pings[d.name]} act={act} busy={busy} />)}
      </div>

      <AutoscalingPanel deps={deps} scaling={data.scaling} />

      <MessagingPanel m={data.messaging} />

      <K6Panel act={act} busy={busy} />

      <div className="panel">
        <h4>Eventos do Kubernetes</h4>
        <table className="events">
          <tbody>
            {data.events.map((e, i) => (
              <tr key={i} className={e.type === 'Warning' ? 'warn' : ''}>
                <td className="muted">{age(e.ageSecs)}</td>
                <td>{e.reason}</td>
                <td><code>{e.object}</code></td>
                <td>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
