import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, formatDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDelivery } from '../lib/delivery';
import { FavoriteButton } from '../components/ArticleList';
import Comments from '../components/Comments';
import Errors from '../components/Errors';
import Returned from '../components/Returned';
import { Avatar, Postmark, Tag } from '../components/Postal';
import Icon from '../components/Icon';

function FollowButton({ profile, onChange }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const toggle = async () => {
    if (!user) return nav('/login');
    const r = profile.following ? await api.unfollow(profile.username) : await api.follow(profile.username);
    onChange(r.profile);
  };
  return (
    <button className={`btn btn-sm ${profile.following ? 'btn-on' : 'btn-secondary'}`} onClick={toggle} aria-pressed={profile.following}>
      {profile.following ? <><Icon name="check" /> Following</> : <><Icon name="plus" /> Follow {profile.username}</>}
    </button>
  );
}

function Byline({ article, setArticle }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const a = article;
  const mine = user && user.username === a.author.username;
  const remove = async () => { await api.deleteArticle(a.slug); nav('/'); };
  return (
    <div className="byline">
      <div className="who">
        <Avatar user={a.author} size={36} />
        <div><Link to={`/profile/${a.author.username}`}>{a.author.username}</Link><br />{formatDate(a.createdAt)}</div>
      </div>
      <div className="actions">
        {mine ? (
          <>
            <Link className="btn btn-sm btn-secondary" to={`/editor/${a.slug}`}><Icon name="pen" /> Edit</Link>
            {confirm ? (
              <>
                <button className="btn btn-sm btn-danger" onClick={remove}><Icon name="trash" /> Delete “{a.title.slice(0, 28)}{a.title.length > 28 ? '…' : ''}”</button>
                <button className="btn btn-sm btn-ghost" onClick={() => setConfirm(false)}>Keep it</button>
              </>
            ) : (
              <button className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}><Icon name="trash" /> Delete</button>
            )}
          </>
        ) : (
          <>
            <FollowButton profile={a.author} onChange={(p) => setArticle({ ...a, author: p })} />
            <FavoriteButton big article={a} onChange={setArticle} />
          </>
        )}
      </div>
    </div>
  );
}

export default function Article() {
  const { slug } = useParams();
  const [article, setArticle] = useState(null);
  const [error, setError] = useState(null);
  const delivery = useDelivery();

  useEffect(() => {
    setArticle(null); setError(null);
    api.article(slug).then((r) => setArticle(r.article)).catch(setError);
  }, [slug]);

  const html = useMemo(() => (article ? DOMPurify.sanitize(marked.parse(article.body || '')) : ''), [article]);

  if (error) {
    if (error.status === 404) return <Returned message="This article does not exist, or its author deleted it." />;
    return <div className="wrap form-page"><h1>Not delivered</h1><p className="sub">The article could not be loaded.</p><div style={{ marginTop: 20 }}><Errors error={error} /></div></div>;
  }
  if (!article) {
    return (
      <div className="article-head"><div className="wrap" aria-hidden="true"><div><span className="skeleton title" /><span className="skeleton short" /></div></div><span className="sr-only" role="status">Loading article</span></div>
    );
  }

  return (
    <article>
      <header className="article-head">
        <div className="wrap">
          <div>
            <h1>{article.title}</h1>
            <Byline article={article} setArticle={setArticle} />
          </div>
          <Postmark delivery={delivery} size={112} />
        </div>
      </header>
      <div className="wrap">
        <div className="article-body" dangerouslySetInnerHTML={{ __html: html }} />
        {article.tagList.length > 0 && (
          <div className="article-foot"><div className="tags">{article.tagList.map((t) => <Tag key={t} name={t} as="link" />)}</div></div>
        )}
        <Comments slug={article.slug} />
      </div>
    </article>
  );
}
