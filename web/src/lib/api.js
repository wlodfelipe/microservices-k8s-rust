// Cliente da API RealWorld (/api) e do monitor (/ops). Mesmo domínio: o nginx faz o proxy.

const TOKEN_KEY = 'jwtToken';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* sem storage */ }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body || {};
    this.errors = this.body.errors || {};
  }
  // ["email has already been taken", ...]
  get messages() {
    return Object.entries(this.errors).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((m) => `${k} ${m}`));
  }
  get commentsDisabled() {
    return this.status === 503 && this.errors.comments?.[0] === 'disabled';
  }
}

export async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Token ${token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new ApiError(0, { errors: { rede: ['indisponível'] } });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  login: (email, password) => request('POST', '/api/users/login', { user: { email, password } }),
  register: (username, email, password) => request('POST', '/api/users', { user: { username, email, password } }),
  currentUser: () => request('GET', '/api/user'),
  updateUser: (user) => request('PUT', '/api/user', { user }),
  profile: (u) => request('GET', `/api/profiles/${enc(u)}`),
  follow: (u) => request('POST', `/api/profiles/${enc(u)}/follow`),
  unfollow: (u) => request('DELETE', `/api/profiles/${enc(u)}/follow`),
  articles: (q = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
    return request('GET', `/api/articles${qs ? `?${qs}` : ''}`);
  },
  feed: (limit, offset) => request('GET', `/api/articles/feed?limit=${limit}&offset=${offset}`),
  article: (slug) => request('GET', `/api/articles/${enc(slug)}`),
  createArticle: (article) => request('POST', '/api/articles', { article }),
  updateArticle: (slug, article) => request('PUT', `/api/articles/${enc(slug)}`, { article }),
  deleteArticle: (slug) => request('DELETE', `/api/articles/${enc(slug)}`),
  favorite: (slug) => request('POST', `/api/articles/${enc(slug)}/favorite`),
  unfavorite: (slug) => request('DELETE', `/api/articles/${enc(slug)}/favorite`),
  comments: (slug) => request('GET', `/api/articles/${enc(slug)}/comments`),
  addComment: (slug, body) => request('POST', `/api/articles/${enc(slug)}/comments`, { comment: { body } }),
  deleteComment: (slug, id) => request('DELETE', `/api/articles/${enc(slug)}/comments/${id}`),
  tags: () => request('GET', '/api/tags'),
  versions: () => request('GET', '/api/_meta/versions'),
  ping: (svc) => request('GET', `/api/_meta/ping/${svc}`),
};

export const ops = {
  overview: () => request('GET', '/ops/overview'),
  setVersion: (name, version) => request('POST', `/ops/deployments/${name}/version`, { version }),
  scale: (name, replicas) => request('POST', `/ops/deployments/${name}/scale`, { replicas }),
  hpaReset: (name) => request('POST', `/ops/deployments/${name}/hpa/reset`),
  restart: (name) => request('POST', `/ops/deployments/${name}/restart`),
  killPods: (name) => request('DELETE', `/ops/deployments/${name}/pods`),
  deletePod: (name) => request('DELETE', `/ops/pods/${name}`),
  k6: () => request('GET', '/ops/k6'),
  k6Run: (cfg) => request('POST', '/ops/k6', cfg),
  k6Stop: () => request('DELETE', '/ops/k6'),
};

export function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}
