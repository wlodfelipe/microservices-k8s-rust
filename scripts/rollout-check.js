// Prova de "atualização sem quebrar": tráfego constante enquanto você troca versões.
//
//   URL=$(minikube -p socialclone service web -n socialclone --url)
//   k6 run -e BASE_URL=$URL -e DURATION=90s scripts/rollout-check.js
//   (enquanto roda: Monitor → "Subir para v2" em qualquer serviço, ou kubectl set image)
//
// Falha se qualquer requisição der erro. Ao final mostra quantas respostas vieram de cada versão.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const byVersion = new Counter('respostas_por_versao');

export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '90s',
  thresholds: { http_req_failed: ['rate==0'] },
};

export default function () {
  const list = http.get(`${BASE}/api/articles?limit=5`, { tags: { name: 'articles' } });
  byVersion.add(1, { svc: 'gateway', v: list.headers['X-Service-Version'] || '?' });
  for (const svc of ['users', 'articles', 'comments']) {
    const r = http.get(`${BASE}/api/_meta/ping/${svc}`, { tags: { name: `ping ${svc}` } });
    if (r.status === 200) byVersion.add(1, { svc, v: r.json('ok') ? r.json('version') : 'fora' });
  }
  const web = http.get(`${BASE}/version.json`, { tags: { name: 'web' } });
  if (web.status === 200) byVersion.add(1, { svc: 'web', v: web.json('version') });
}

export function handleSummary(data) {
  const failed = data.metrics.http_req_failed.values;
  const lines = [
    `requisições: ${data.metrics.http_reqs.values.count}  (${data.metrics.http_reqs.values.rate.toFixed(0)}/s)`,
    `falhas: ${failed.passes} (${(failed.rate * 100).toFixed(3)}%)`,
    `p95: ${data.metrics.http_req_duration.values['p(95)'].toFixed(1)} ms`,
  ];
  return { stdout: `\n${lines.join('\n')}\n` };
}
