import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, formatDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { FavoriteButton } from '../components/ArticleList';
import Comments from '../components/Comments';
import Errors from '../components/Errors';

function FollowButton({ profile, onChange }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const toggle = async () => {
    if (!user) return nav('/login');
    const r = profile.following ? await api.unfollow(profile.username) : await api.follow(profile.username);
    onChange(r.profile);
  };
  return (
    <button className={`btn btn-sm ${profile.following ? 'btn-secondary' : 'btn-outline-secondary'} action-btn`} onClick={toggle}>
      <i className="ion-plus-round" />&nbsp;{profile.following ? 'Unfollow' : 'Follow'} {profile.username}
    </button>
  );
}

function Meta({ article, setArticle }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const a = article;
  const mine = user && user.username === a.author.username;
  const remove = async () => { await api.deleteArticle(a.slug); nav('/'); };
  return (
    <div className="article-meta">
      <Link to={`/profile/${a.author.username}`}><img src={a.author.image || '/default-avatar.svg'} alt="" /></Link>
      <div className="info">
        <Link to={`/profile/${a.author.username}`} className="author">{a.author.username}</Link>
        <span className="date">{formatDate(a.createdAt)}</span>
      </div>
      {mine ? (
        <>
          <Link className="btn btn-sm btn-outline-secondary" to={`/editor/${a.slug}`}><i className="ion-edit" /> Edit Article</Link>{' '}
          <button className="btn btn-sm btn-outline-danger" onClick={remove}><i className="ion-trash-a" /> Delete Article</button>
        </>
      ) : (
        <>
          <FollowButton profile={a.author} onChange={(p) => setArticle({ ...a, author: p })} />{' '}
          <FavoriteButton big article={a} onChange={setArticle} />
        </>
      )}
    </div>
  );
}

export default function Article() {
  const { slug } = useParams();
  const [article, setArticle] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setArticle(null); setError(null);
    api.article(slug).then((r) => setArticle(r.article)).catch(setError);
  }, [slug]);

  const html = useMemo(() => (article ? DOMPurify.sanitize(marked.parse(article.body || '')) : ''), [article]);

  if (error) return <div className="container page"><Errors error={error} /></div>;
  if (!article) return <div className="article-page"><div className="container page">Loading article...</div></div>;

  return (
    <div className="article-page">
      <div className="banner">
        <div className="container">
          <h1>{article.title}</h1>
          <Meta article={article} setArticle={setArticle} />
        </div>
      </div>
      <div className="container page">
        <div className="row article-content">
          <div className="col-md-12">
            <div dangerouslySetInnerHTML={{ __html: html }} />
            <ul className="tag-list">
              {article.tagList.map((t) => <li key={t} className="tag-default tag-pill tag-outline">{t}</li>)}
            </ul>
          </div>
        </div>
        <hr />
        <div className="article-actions"><Meta article={article} setArticle={setArticle} /></div>
        <Comments slug={article.slug} />
      </div>
    </div>
  );
}
