import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, formatDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, Tag } from './Postal';
import Icon from './Icon';

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
  const label = article.favorited ? 'Remove from favorites' : 'Add to favorites';
  return (
    <button className={`btn btn-sm fav ${article.favorited ? 'btn-on' : 'btn-secondary'}`} onClick={toggle} disabled={busy}
      aria-pressed={article.favorited} aria-label={big ? undefined : `${label} (${article.favoritesCount})`}>
      <Icon name="heart" />
      {big && <span>{article.favorited ? 'Favorited' : 'Favorite'}</span>}
      <span className="count">{article.favoritesCount}</span>
    </button>
  );
}

export function ArticlePreview({ article, onChange, onTag }) {
  const a = article;
  const replies = a.commentsCount === 1 ? '1 comment' : `${a.commentsCount || 0} comments`;
  return (
    <article className="letter">
      <div>
        <div className="from">
          <Avatar user={a.author} size={26} />
          <span>From <Link to={`/profile/${a.author.username}`}>{a.author.username}</Link> · {formatDate(a.createdAt)} · {replies}</span>
        </div>
        <h2><Link to={`/article/${a.slug}`}>{a.title}</Link></h2>
        {a.description && <p>{a.description}</p>}
        {a.tagList.length > 0 && (
          <div className="tags">{a.tagList.map((t) => <Tag key={t} name={t} onClick={onTag ? () => onTag(t) : undefined} />)}</div>
        )}
      </div>
      <div className="letter-side"><FavoriteButton article={a} onChange={onChange} /></div>
    </article>
  );
}

function Skeleton() {
  return Array.from({ length: 3 }, (_, i) => (
    <div className="letter" key={i} aria-hidden="true">
      <div><span className="skeleton short" /><span className="skeleton title" /><span className="skeleton line" /></div>
    </div>
  ));
}

export function ArticleList({ state, setState, page, setPage, pageSize, empty, onTag }) {
  if (state.error) return <p className="state">The articles could not be loaded ({state.error}). The articles service may be restarting; try again in a moment.</p>;
  if (state.loading) return <><Skeleton /><span className="sr-only" role="status">Loading articles</span></>;
  if (!state.articles.length) return <p className="state">{empty || 'No articles here yet.'}</p>;
  const pages = Math.ceil(state.count / pageSize);
  const replace = (updated) => setState((s) => ({ ...s, articles: s.articles.map((x) => (x.slug === updated.slug ? updated : x)) }));
  return (
    <>
      {state.articles.map((a) => <ArticlePreview key={a.slug} article={a} onChange={replace} onTag={onTag} />)}
      {pages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button className="btn btn-sm btn-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</button>
          <span className="pager-pos">Page <b>{page + 1}</b> of {pages}</span>
          <button className="btn btn-sm btn-secondary" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Older</button>
        </nav>
      )}
    </>
  );
}
