import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import Errors from './Errors';
import { Avatar, Stamp } from './Postal';
import Icon from './Icon';

// Seção de comentários. Ela é carregada separada do artigo: se o microserviço de
// comentários estiver desligado, o gateway responde 503 {"errors":{"comments":["disabled"]}}
// e só esta área mostra "comments switched off". O resto da página funciona normalmente.
// Enquanto estiver desativado, tenta de novo a cada 5 s e volta sozinho quando o serviço volta.
//
// Ao vivo: um WebSocket em /api/articles/:slug/live recebe os comentários novos e apagados
// por outras pessoas. Se a conexão cai (pod do gateway saindo, RabbitMQ fora), reconecta
// com espera crescente e recarrega a lista, para não perder nada do intervalo. Enquanto
// reconecta, a faixa de chevrons do topo fica cinza (html[data-live]).

// Estado da conexão: 'connecting' | 'live' | 'offline'
function useLive(slug, onMessage, onReconnect) {
  const [state, setState] = useState('connecting');
  const handlers = useRef({ onMessage, onReconnect });
  handlers.current = { onMessage, onReconnect };

  useEffect(() => {
    let ws; let timer; let closed = false; let attempt = 0;
    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/api/articles/${encodeURIComponent(slug)}/live`);
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'hello') {
          setState('live');
          if (attempt > 0) handlers.current.onReconnect();
          attempt = 0;
        } else handlers.current.onMessage(msg);
      };
      ws.onclose = () => {
        if (closed) return;
        setState('offline');
        attempt += 1;
        const wait = Math.min(10000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
        timer = setTimeout(connect, wait);
      };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, [slug]);

  useEffect(() => {
    document.documentElement.dataset.live = state === 'offline' ? 'reconnecting' : state;
    return () => { delete document.documentElement.dataset.live; };
  }, [state]);
  return state;
}

const LIVE_LABEL = { live: 'Live', offline: 'Reconnecting…', connecting: 'Connecting…' };

export default function Comments({ slug }) {
  const { user } = useAuth();
  const [comments, setComments] = useState(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(() => new Set());
  const [articleGone, setArticleGone] = useState(false);
  const [lastTry, setLastTry] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.comments(slug);
      setComments(r.comments); setDisabled(false); setError(null);
    } catch (e) {
      if (e.commentsDisabled || e.status === 503 || e.status === 502 || e.status === 0) { setDisabled(true); setLastTry(new Date()); } else setError(e);
    }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  const live = useLive(slug, (msg) => {
    if (msg.type === 'created') {
      // o próprio autor já colocou o comentário na lista pela resposta do POST
      setComments((c) => (c && !c.some((x) => x.id === msg.comment.id) ? [msg.comment, ...c] : c));
      setFresh((f) => new Set(f).add(msg.comment.id));
    } else if (msg.type === 'deleted') {
      setComments((c) => c?.filter((x) => x.id !== msg.id));
    } else if (msg.type === 'articleDeleted') {
      setArticleGone(true);
    } else if (msg.type === 'resync') {
      load();
    }
  }, load);
  useEffect(() => {
    if (!disabled) return undefined;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [disabled, load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await api.addComment(slug, body);
      setComments((c) => [r.comment, ...(c || [])]);
      setBody('');
    } catch (err) {
      if (err.commentsDisabled) setDisabled(true); else setError(err);
    } finally { setBusy(false); }
  };

  const remove = async (id) => {
    try {
      await api.deleteComment(slug, id);
      setComments((c) => c.filter((x) => x.id !== id));
    } catch (err) { if (err.commentsDisabled) setDisabled(true); else setError(err); }
  };

  const count = comments?.length;
  return (
    <section className="replies" aria-labelledby="replies-title">
      <div className="replies-head">
        <h2 id="replies-title">{disabled || count == null ? 'Comments' : count === 1 ? '1 comment' : `${count} comments`}</h2>
        {!disabled && (
          <span className={`live ${live === 'live' ? 'on' : live}`} title="Comments from other readers appear without reloading">
            <span className="live-dot" />{LIVE_LABEL[live]}
          </span>
        )}
      </div>

      {disabled ? (
        <div className="notice" role="status">
          <Stamp kind="off">Returned</Stamp>
          <div>
            <h3>Comments are switched off</h3>
            <p>The comments service has no pods running right now. Everything else on this page still works, and comments come back on their own when the service returns.</p>
            <div className="meta">Service: comments · checking every 5 s{lastTry ? ` · last check ${lastTry.toLocaleTimeString('en-GB')}` : ''}</div>
          </div>
        </div>
      ) : (
        <>
          {error && <div style={{ marginBottom: 16 }}><Errors error={error} /></div>}
          {articleGone && <div className="errors" role="alert" style={{ marginBottom: 16 }}>The author just deleted this article.</div>}
          {user ? (
            <form className="composer" onSubmit={submit}>
              <label htmlFor="reply" className="sr-only">Write a comment</label>
              <textarea id="reply" placeholder="Write a comment…" rows="3" value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="composer-foot">
                <Avatar user={user} size={28} />
                <button className="btn btn-sm" disabled={busy || !body.trim()}>{busy ? 'Posting…' : 'Post comment'}</button>
              </div>
            </form>
          ) : (
            <p className="signin-hint"><Link to="/login">Sign in</Link> or <Link to="/register">create an account</Link> to comment.</p>
          )}
          {comments === null ? (
            <div className="reply" aria-hidden="true"><span className="skeleton line" /><span className="skeleton short" style={{ marginTop: 12 }} /></div>
          ) : comments.length === 0 ? (
            <p className="state">No comments yet. New ones appear here as they are posted.</p>
          ) : comments.map((c) => (
            <div className={`reply${fresh.has(c.id) ? ' fresh' : ''}`} key={c.id}>
              <p>{c.body}</p>
              <div className="reply-meta">
                <Avatar user={c.author} size={24} />
                <Link to={`/profile/${c.author.username}`}>{c.author.username}</Link>
                <span>{formatDate(c.createdAt)}</span>
                {user?.username === c.author.username && (
                  <button className="btn btn-xs btn-ghost" onClick={() => remove(c.id)} aria-label="Delete comment"><Icon name="trash" size={14} /> Delete</button>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
