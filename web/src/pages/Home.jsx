import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ArticleList } from '../components/ArticleList';

const PAGE = 10;

export default function Home() {
  const { user } = useAuth();
  const [tab, setTab] = useState(user ? 'feed' : 'global');
  const [tag, setTag] = useState(null);
  const [page, setPage] = useState(0);
  const [state, setState] = useState({ loading: true, articles: [], count: 0 });
  const [tags, setTags] = useState(null);

  useEffect(() => { if (user && tab === 'global' && !tag) setTab('feed'); }, [user]); // eslint-disable-line

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    const p = tab === 'feed' ? api.feed(PAGE, page * PAGE) : api.articles({ limit: PAGE, offset: page * PAGE, tag: tab === 'tag' ? tag : undefined });
    p.then((r) => alive && setState({ loading: false, articles: r.articles, count: r.articlesCount }))
      .catch((e) => alive && setState({ loading: false, articles: [], count: 0, error: e.messages?.join(', ') || e.status }));
    return () => { alive = false; };
  }, [tab, tag, page]);

  useEffect(() => { api.tags().then((r) => setTags(r.tags)).catch(() => setTags([])); }, []);

  const go = (t, tg = null) => { setTab(t); setTag(tg); setPage(0); };

  return (
    <div className="home-page">
      {!user && (
        <div className="banner">
          <div className="container">
            <h1 className="logo-font">conduit</h1>
            <p>A place to share your knowledge.</p>
          </div>
        </div>
      )}
      <div className="container page">
        <div className="row">
          <div className="col-md-9">
            <div className="feed-toggle">
              <ul className="nav nav-pills outline-active">
                {user && <li className="nav-item"><button className={`nav-link${tab === 'feed' ? ' active' : ''}`} onClick={() => go('feed')}>Your Feed</button></li>}
                <li className="nav-item"><button className={`nav-link${tab === 'global' ? ' active' : ''}`} onClick={() => go('global')}>Global Feed</button></li>
                {tab === 'tag' && <li className="nav-item"><button className="nav-link active"><i className="ion-pound" /> {tag}</button></li>}
              </ul>
            </div>
            <ArticleList state={state} setState={setState} page={page} setPage={setPage} pageSize={PAGE} />
          </div>
          <div className="col-md-3">
            <div className="sidebar">
              <p>Popular Tags</p>
              {tags === null ? <div>Loading tags...</div> : (
                <div className="tag-list">
                  {tags.slice(0, 20).map((t) => (
                    <button key={t} className="tag-pill tag-default" onClick={() => go('tag', t)}>{t}</button>
                  ))}
                  {!tags.length && <span>No tags are here... yet.</span>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
