import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import Errors from './Errors';

// Seção de comentários. Ela é carregada separada do artigo: se o microserviço de
// comentários estiver desligado, o gateway responde 503 {"errors":{"comments":["disabled"]}}
// e só esta área mostra "Comentários desativados". O resto da página funciona normalmente.
// Enquanto estiver desativado, tenta de novo a cada 5 s e volta sozinho quando o serviço volta.
//
// Ao vivo: um WebSocket em /api/articles/:slug/live recebe os comentários novos e apagados
// por outras pessoas. Se a conexão cai (pod do gateway saindo, RabbitMQ fora), reconecta
// com espera crescente e recarrega a lista, para não perder nada do intervalo.

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
  return state;
}

export default function Comments({ slug }) {
  const { user } = useAuth();
  const [comments, setComments] = useState(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(() => new Set());
  const [articleGone, setArticleGone] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.comments(slug);
      setComments(r.comments); setDisabled(false); setError(null);
    } catch (e) {
      if (e.commentsDisabled || e.status === 503 || e.status === 502 || e.status === 0) setDisabled(true);
      else setError(e);
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

  if (disabled) {
    return (
      <div className="row">
        <div className="col-xs-12 col-md-8 offset-md-2">
          <div className="comments-disabled">
            <i className="ion-chatbubbles" />
            <div>
              <strong>Comentários desativados</strong>
              <p>O serviço de comentários está fora do ar no momento. O restante do site continua funcionando; os comentários voltam sozinhos quando o serviço voltar.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="row">
      <div className="col-xs-12 col-md-8 offset-md-2">
        <Errors error={error} />
        <div className={`live-badge ${live}`} title="comentários de outras pessoas aparecem sem recarregar a página">
          <span className="live-dot" />
          {live === 'live' ? 'ao vivo' : live === 'offline' ? 'reconectando…' : 'conectando…'}
        </div>
        {articleGone && <div className="error-messages">Este artigo acabou de ser apagado pelo autor.</div>}
        {user ? (
          <form className="card comment-form" onSubmit={submit}>
            <div className="card-block">
              <textarea className="form-control" placeholder="Write a comment..." rows="3" value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div className="card-footer">
              <img src={user.image || '/default-avatar.svg'} className="comment-author-img" alt="" />
              <button className="btn btn-sm btn-primary" disabled={busy}>Post Comment</button>
            </div>
          </form>
        ) : (
          <p><Link to="/login">Sign in</Link> or <Link to="/register">sign up</Link> to add comments on this article.</p>
        )}
        {comments === null ? <div>Loading comments...</div> : comments.map((c) => (
          <div className={`card${fresh.has(c.id) ? ' comment-fresh' : ''}`} key={c.id}>
            <div className="card-block"><p className="card-text">{c.body}</p></div>
            <div className="card-footer">
              <Link to={`/profile/${c.author.username}`} className="comment-author">
                <img src={c.author.image || '/default-avatar.svg'} className="comment-author-img" alt="" />
              </Link>
              &nbsp;<Link to={`/profile/${c.author.username}`} className="comment-author">{c.author.username}</Link>
              <span className="date-posted">{formatDate(c.createdAt)}</span>
              {user?.username === c.author.username && (
                <span className="mod-options"><i className="ion-trash-a" onClick={() => remove(c.id)} /></span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
