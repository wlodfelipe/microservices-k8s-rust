// Teste de carga do SocialClone (k6).
//
// Local:      k6 run -e BASE_URL=http://127.0.0.1:8080 -e VUS=50 -e DURATION=1m deploy/k8s/k6/load.js
// No cluster: botão "Rodar k6" na aba Monitor (cria um Job com este script via ConfigMap).
//
// Cenários (SCENARIO):
//   mixed  70% leitura, 20% escrita, 10% login  (padrão)
//   read   só leitura (lista, artigo, comentários, tags)
//   write  cria artigos, comenta e favorita
//   login  só login: CPU do serviço users (argon2) → bom para ver o HPA escalar
//
// Comentários desligados (503 "disabled") NÃO contam como falha: é a degradação esperada.
// Eles aparecem na métrica comments_disabled.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const API = `${BASE}/api`;
const VUS = parseInt(__ENV.VUS || '20');
const DURATION = __ENV.DURATION || '60s';
const SCENARIO = __ENV.SCENARIO || 'mixed';
const TAGS = ['rust', 'kubernetes', 'k6', 'minikube', 'axum', 'tokio', 'docker', 'devops', 'sre', 'microservices'];

const commentsDisabled = new Counter('comments_disabled');
const servedBy = new Counter('served_by_version');
const articleLatency = new Trend('article_page_ms', true);

export const options = {
  scenarios: {
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const commentsOk = http.expectedStatuses(200, 201, 204, 404, 503);
// Outro VU pode apagar o artigo entre a listagem e a leitura: 404 aí é resposta correta.
const articleOk = http.expectedStatuses(200, 404);

function auth(token) {
  return { headers: { ...JSON_HEADERS, Authorization: `Token ${token}` } };
}

function register(prefix) {
  const id = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
  const body = JSON.stringify({ user: { username: id, email: `${id}@k6.test`, password: 'password123' } });
  const r = http.post(`${API}/users`, body, { headers: JSON_HEADERS, tags: { name: 'POST /users' } });
  check(r, { 'register 201': (x) => x.status === 201 });
  return r.status === 201 ? { email: `${id}@k6.test`, username: id, token: r.json('user.token') } : null;
}

export function setup() {
  // Alguns autores com artigos, para as leituras terem o que buscar.
  const authors = [];
  for (let i = 0; i < 5; i++) {
    const u = register('seed');
    if (!u) continue;
    authors.push(u);
    for (let j = 0; j < 4; j++) {
      const tags = [TAGS[(i + j) % TAGS.length], TAGS[(i * 3 + j) % TAGS.length]];
      http.post(`${API}/articles`, JSON.stringify({ article: {
        title: `Artigo de carga ${i}-${j}`, description: 'gerado pelo k6', body: 'Lorem ipsum '.repeat(40), tagList: tags,
      } }), auth(u.token));
    }
  }
  return { authors };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function readFlow(token) {
  const p = token ? auth(token) : { headers: JSON_HEADERS };
  const t0 = Date.now();
  const list = http.get(`${API}/articles?limit=10`, { ...p, tags: { name: 'GET /articles' } });
  check(list, { 'list 200': (r) => r.status === 200 });
  const v = list.headers['X-Service-Version'];
  if (v) servedBy.add(1, { version: v });
  const articles = list.status === 200 ? list.json('articles') : [];
  if (articles.length) {
    const slug = pick(articles).slug;
    const res = http.batch([
      ['GET', `${API}/articles/${slug}`, null, { ...p, tags: { name: 'GET /articles/:slug' }, responseCallback: articleOk }],
      ['GET', `${API}/articles/${slug}/comments`, null, { ...p, tags: { name: 'GET /articles/:slug/comments' }, responseCallback: commentsOk }],
    ]);
    check(res[0], { 'article 200 (ou 404 se apagado)': (r) => r.status === 200 || r.status === 404 });
    check(res[1], { 'comments 200 ou desativado': (r) => [200, 404, 503].includes(r.status) });
    if (res[1].status === 503) commentsDisabled.add(1);
    articleLatency.add(Date.now() - t0);
  }
  if (Math.random() < 0.3) {
    check(http.get(`${API}/tags`, { tags: { name: 'GET /tags' } }), { 'tags 200': (r) => r.status === 200 });
  }
  if (Math.random() < 0.3) {
    check(http.get(`${API}/articles?tag=${pick(TAGS)}&limit=10`, { ...p, tags: { name: 'GET /articles?tag' } }), { 'by tag 200': (r) => r.status === 200 });
  }
}

function writeFlow(me) {
  const p = auth(me.token);
  const created = http.post(`${API}/articles`, JSON.stringify({ article: {
    title: `k6 ${__VU}-${__ITER}`, description: 'carga', body: 'Texto do artigo. '.repeat(20), tagList: [pick(TAGS)],
  } }), { ...p, tags: { name: 'POST /articles' } });
  check(created, { 'create 201': (r) => r.status === 201 });
  if (created.status !== 201) return;
  const slug = created.json('article.slug');
  const c = http.post(`${API}/articles/${slug}/comments`, JSON.stringify({ comment: { body: 'Comentário do k6' } }),
    { ...p, tags: { name: 'POST /articles/:slug/comments' }, responseCallback: commentsOk });
  check(c, { 'comment 201 ou desativado': (r) => r.status === 201 || r.status === 503 });
  if (c.status === 503) commentsDisabled.add(1);
  check(http.post(`${API}/articles/${slug}/favorite`, null, { ...p, tags: { name: 'POST /favorite' } }), { 'favorite 200': (r) => r.status === 200 });
  if (Math.random() < 0.5) {
    check(http.del(`${API}/articles/${slug}`, null, { ...p, tags: { name: 'DELETE /articles/:slug' } }), { 'delete 204': (r) => r.status === 204 });
  }
}

function loginFlow(me) {
  const r = http.post(`${API}/users/login`, JSON.stringify({ user: { email: me.email, password: 'password123' } }),
    { headers: JSON_HEADERS, tags: { name: 'POST /users/login' } });
  check(r, { 'login 200': (x) => x.status === 200 });
  check(http.get(`${API}/user`, { ...auth(me.token), tags: { name: 'GET /user' } }), { 'user 200': (x) => x.status === 200 });
}

let me = null; // um usuário por VU, criado na primeira iteração

export default function () {
  if (!me) me = register('vu');
  if (!me) { sleep(1); return; }
  const roll = Math.random();
  if (SCENARIO === 'read') readFlow(Math.random() < 0.5 ? me.token : null);
  else if (SCENARIO === 'write') writeFlow(me);
  else if (SCENARIO === 'login') loginFlow(me);
  else if (roll < 0.7) readFlow(Math.random() < 0.5 ? me.token : null);
  else if (roll < 0.9) writeFlow(me);
  else loginFlow(me);
  sleep(0.5 + Math.random());
}
