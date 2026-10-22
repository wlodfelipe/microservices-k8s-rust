// Teste de capacidade: quantas pessoas usando o site AO MESMO TEMPO a aplicação aguenta
// em 4 minutos, dentro do orçamento do cluster (4 CPU / ~5,5 GiB por padrão).
//
//   ./scripts/capacity.sh 1000        (recomendado: roda o k6 na rede do minikube)
//   k6 run -e BASE_URL=http://<minikube ip>:30080 -e USERS=1000 deploy/k8s/k6/capacity.js
//
// Cada VU é uma pessoa navegando, com o mesmo padrão de requisições do front:
//   - chega no site: index.html + JS/CSS (uma vez), 80% se cadastram, 20% só leem;
//   - home: GET /articles + GET /tags em paralelo (logado: às vezes o feed);
//   - abre um artigo: GET /articles/:slug + GET /articles/:slug/comments;
//   - às vezes filtra por tag, favorita (5%), comenta (4%) ou publica um artigo (1%);
//   - "pensa" de 3 a 8 s entre uma página e outra (média 5,5 s).
//
// Com LIVE=1, quem está lendo um artigo fica com o WebSocket de comentários ao vivo aberto
// durante a leitura (como o front faz), e o comentário leva a hora em que foi enviado: quem
// recebe mede o atraso de entrega (live_delay_ms).
//
// Perfil de 4 minutos: sobe de 0 a USERS em 90 s, segura 2 min, desce em 30 s.
// Critério de "aguentou": < 1% de erros e p95 < 500 ms (thresholds abaixo).

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep, group } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const API = `${BASE}/api`;
const USERS = parseInt(__ENV.USERS || '1000');
const THINK_MIN = parseFloat(__ENV.THINK_MIN || '3');
const THINK_MAX = parseFloat(__ENV.THINK_MAX || '8');
const LIVE = __ENV.LIVE === '1';
const TAGS = ['rust', 'kubernetes', 'k6', 'minikube', 'axum', 'tokio', 'docker', 'devops', 'sre', 'microservices'];

const homePage = new Trend('page_home_ms', true);
const articlePage = new Trend('page_article_ms', true);
const pages = new Counter('pages_viewed');
const commentsDisabled = new Counter('comments_disabled');
const liveDelay = new Trend('live_delay_ms', true);
const liveReceived = new Counter('live_received');

export const options = {
  scenarios: {
    pessoas: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '90s', target: USERS },
        { duration: '120s', target: USERS },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  // Corpo das respostas só é guardado quando o script precisa ler (economiza memória do k6).
  discardResponseBodies: true,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    page_home_ms: ['p(95)<800'],
    page_article_ms: ['p(95)<800'],
    ...(LIVE ? { live_delay_ms: ['p(95)<1000'], ws_connecting: ['p(95)<500'] } : {}),
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const asText = { responseType: 'text' };
// 404: outro VU apagou o artigo; 503: comentários desligados (degradação esperada).
const articleOk = http.expectedStatuses(200, 404);
const commentsOk = http.expectedStatuses(200, 201, 404, 503);

function opts(token, name, extra = {}) {
  const headers = token ? { ...JSON_HEADERS, Authorization: `Token ${token}` } : JSON_HEADERS;
  return { headers, tags: { name }, ...extra };
}

function register(prefix) {
  const id = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
  const body = JSON.stringify({ user: { username: id, email: `${id}@k6.test`, password: 'password123' } });
  const r = http.post(`${API}/users`, body, opts(null, 'POST /users', asText));
  check(r, { 'cadastro 201': (x) => x.status === 201 });
  return r.status === 201 ? r.json('user.token') : null;
}

export function setup() {
  // Conteúdo inicial: 10 autores, 60 artigos, alguns com comentários.
  const slugs = [];
  for (let i = 0; i < 10; i++) {
    const token = register('autor');
    if (!token) continue;
    for (let j = 0; j < 6; j++) {
      const r = http.post(`${API}/articles`, JSON.stringify({ article: {
        title: `Capacidade ${i}-${j}`, description: 'conteúdo do teste de capacidade',
        body: 'Lorem ipsum dolor sit amet. '.repeat(60), tagList: [TAGS[(i + j) % TAGS.length], TAGS[(i * 3 + j) % TAGS.length]],
      } }), opts(token, 'setup', asText));
      if (r.status !== 201) continue;
      const slug = r.json('article.slug');
      slugs.push(slug);
      for (let k = 0; k < (j % 3); k++) {
        http.post(`${API}/articles/${slug}/comments`, JSON.stringify({ comment: { body: `Comentário ${k}` } }), opts(token, 'setup'));
      }
    }
  }
  return { slugs };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function thinkSecs() {
  return THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN);
}

function think() {
  sleep(thinkSecs());
}

// Lê o artigo com o WebSocket aberto pelo mesmo tempo de uma "pensada".
function readLive(slug) {
  const url = `${BASE.replace(/^http/, 'ws')}/api/articles/${encodeURIComponent(slug)}/live`;
  const res = ws.connect(url, { tags: { name: 'WS /live' } }, (socket) => {
    socket.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      if (msg.type !== 'created') return;
      liveReceived.add(1);
      const m = /t=(\d+)/.exec(msg.comment?.body || '');
      if (m) liveDelay.add(Date.now() - parseInt(m[1], 10));
    });
    socket.setTimeout(() => socket.close(), thinkSecs() * 1000);
  });
  // 404: outro VU apagou o artigo
  check(res, { 'ws 101': (r) => r && (r.status === 101 || r.status === 404) });
}

// Estado de cada pessoa (um por VU, vive entre as iterações).
let session = null;

function arrive() {
  const s = { token: null, slugs: [] };
  group('chegada', () => {
    const html = http.get(`${BASE}/`, { tags: { name: 'GET /' }, responseType: 'text' });
    check(html, { 'index 200': (r) => r.status === 200 });
    const assets = (html.body || '').match(/\/assets\/[^"']+/g) || [];
    if (assets.length) http.batch(assets.map((a) => ['GET', `${BASE}${a}`, null, { tags: { name: 'GET /assets' } }]));
    if (Math.random() < 0.8) s.token = register('p');
    if (s.token) check(http.get(`${API}/user`, opts(s.token, 'GET /user')), { 'user 200': (r) => r.status === 200 });
  });
  return s;
}

function home(s) {
  const t0 = Date.now();
  const feed = s.token && Math.random() < 0.2;
  const list = feed
    ? ['GET', `${API}/articles/feed?limit=10&offset=0`, null, opts(s.token, 'GET /articles/feed', asText)]
    : ['GET', `${API}/articles?limit=10&offset=0`, null, opts(s.token, 'GET /articles', asText)];
  const [l, tags] = http.batch([list, ['GET', `${API}/tags`, null, opts(null, 'GET /tags')]]);
  check(l, { 'lista 200': (r) => r.status === 200 });
  check(tags, { 'tags 200': (r) => r.status === 200 });
  homePage.add(Date.now() - t0);
  pages.add(1);
  if (l.status === 200) {
    const found = (l.json('articles') || []).map((a) => a.slug);
    if (found.length) s.slugs = found;
  }
}

function byTag(s) {
  const r = http.get(`${API}/articles?tag=${pick(TAGS)}&limit=10&offset=0`, opts(s.token, 'GET /articles?tag', asText));
  check(r, { 'por tag 200': (x) => x.status === 200 });
  pages.add(1);
  if (r.status === 200) {
    const found = (r.json('articles') || []).map((a) => a.slug);
    if (found.length) s.slugs = found;
  }
}

// Devolve o slug lido (para a leitura ao vivo), ou null.
function article(s, seed) {
  const slug = s.slugs.length ? pick(s.slugs) : pick(seed);
  if (!slug) return null;
  const t0 = Date.now();
  const [a, c] = http.batch([
    ['GET', `${API}/articles/${slug}`, null, opts(s.token, 'GET /articles/:slug', { responseCallback: articleOk })],
    ['GET', `${API}/articles/${slug}/comments`, null, opts(s.token, 'GET /articles/:slug/comments', { responseCallback: commentsOk })],
  ]);
  check(a, { 'artigo 200': (r) => r.status === 200 || r.status === 404 });
  check(c, { 'comentários 200 ou desativados': (r) => [200, 404, 503].includes(r.status) });
  if (c.status === 503) commentsDisabled.add(1);
  articlePage.add(Date.now() - t0);
  pages.add(1);
  if (a.status !== 200) return null;
  if (!s.token) return slug;

  const roll = Math.random();
  if (roll < 0.05) {
    check(http.post(`${API}/articles/${slug}/favorite`, null, opts(s.token, 'POST /favorite')), { 'favoritar 200': (r) => r.status === 200 || r.status === 404 });
  } else if (roll < 0.09) {
    const r = http.post(`${API}/articles/${slug}/comments`, JSON.stringify({ comment: { body: `Muito bom! t=${Date.now()}` } }),
      opts(s.token, 'POST /comments', { responseCallback: commentsOk }));
    check(r, { 'comentar 201 ou desativado': (x) => [201, 404, 503].includes(x.status) });
  }
  return slug;
}

function publish(s) {
  const r = http.post(`${API}/articles`, JSON.stringify({ article: {
    title: `Post ${__VU}-${__ITER}`, description: 'escrito durante o teste', body: 'Texto. '.repeat(80), tagList: [pick(TAGS)],
  } }), opts(s.token, 'POST /articles'));
  check(r, { 'publicar 201': (x) => x.status === 201 });
  pages.add(1);
}

export default function (data) {
  if (!session) session = arrive();
  const s = session;
  home(s);
  think();
  if (Math.random() < 0.3) {
    byTag(s);
    think();
  }
  const read = article(s, data.slugs);
  if (LIVE && read) readLive(read);
  else think();
  if (s.token && Math.random() < 0.01) {
    publish(s);
    think();
  }
}
