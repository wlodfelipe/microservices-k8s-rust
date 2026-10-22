import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useNavigate } from 'react-router-dom';

export function FavoriteButton({ article, onChange, big }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (!user) return nav('/login');
    setBusy(true);
    try {
      const r = article.favorited ? await api.unfavorite(article.slug) : await api.favorite(article.slug);
      onChange?.(r.article);
    } finally { setBusy(false); }
  };
  const cls = `btn btn-sm ${article.favorited ? 'btn-primary' : 'btn-outline-primary'}${big ? '' : ' pull-xs-right'}`;
  return (
    <button className={cls} onClick={toggle} disabled={busy}>
      <i className="ion-heart" />
      {big ? <>&nbsp;{article.favorited ? 'Unfavorite' : 'Favorite'} Article <span className="counter">({article.favoritesCount})</span></> : <> {article.favoritesCount}</>}
    </button>
  );
}

export function ArticlePreview({ article, onChange }) {
  const a = article;
  return (
    <div className="article-preview">
      <div className="article-meta">
        <Link to={`/profile/${a.author.username}`}><img src={a.author.image || '/default-avatar.svg'} alt="" /></Link>
        <div className="info">
          <Link to={`/profile/${a.author.username}`} className="author">{a.author.username}</Link>
          <span className="date">{formatDate(a.createdAt)}</span>
        </div>
        <FavoriteButton article={a} onChange={onChange} />
      </div>
      <Link to={`/article/${a.slug}`} className="preview-link">
        <h1>{a.title}</h1>
        <p>{a.description}</p>
        <span>Read more...</span>
        {a.commentsCount > 0 && <span className="comments-count" title="comentários (contador atualizado por eventos do RabbitMQ)">💬 {a.commentsCount}</span>}
        <ul className="tag-list">
          {a.tagList.map((t) => <li key={t} className="tag-default tag-pill tag-outline">{t}</li>)}
        </ul>
      </Link>
    </div>
  );
}

export function ArticleList({ state, setState, page, setPage, pageSize }) {
  if (state.error) return <div className="article-preview error-messages">Não foi possível carregar os artigos ({state.error}).</div>;
  if (state.loading) return <div className="article-preview">Loading articles...</div>;
  if (!state.articles.length) return <div className="article-preview empty-feed-message">No articles are here... yet.</div>;
  const pages = Math.ceil(state.count / pageSize);
  const replace = (updated) => setState((s) => ({ ...s, articles: s.articles.map((x) => (x.slug === updated.slug ? updated : x)) }));
  return (
    <>
      {state.articles.map((a) => <ArticlePreview key={a.slug} article={a} onChange={replace} />)}
      {pages > 1 && (
        <ul className="pagination">
          {Array.from({ length: Math.min(pages, 20) }, (_, i) => (
            <li key={i} className={`page-item${i === page ? ' active' : ''}`}>
              <button className="page-link" onClick={() => setPage(i)}>{i + 1}</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
