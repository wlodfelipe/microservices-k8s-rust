import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDelivery } from '../lib/delivery';
import { ArticleList } from '../components/ArticleList';
import { Postmark, Tag } from '../components/Postal';

const PAGE = 10;
const SERVICES = ['gateway', 'users', 'articles', 'comments'];

function Delivered() {
  const d = useDelivery();
  return (
    <section className="slip" aria-labelledby="delivered-title">
      <h3 id="delivered-title">This page was delivered by</h3>
      <div className="delivered">
        <Postmark delivery={d} size={96} />
        <div className="kv">
          {d ? <>pod <b>{d.pod}</b><br />version <b>{d.version}</b><br />in <b className="num">{d.ms} ms</b></> : 'Waiting for the first response…'}
        </div>
      </div>
      <p className="slip-note">Read from the response headers of the last API call.</p>
    </section>
  );
}

// No celular o carimbo vem logo abaixo do texto de abertura, não depois do feed.
function DeliveredInline() {
  const d = useDelivery();
  return (
    <div className="delivered-inline">
      <span aria-hidden="true"><Postmark delivery={d} size={64} arcLabel={false} /></span>
      <span>{d ? <>Delivered by <b>{d.pod.split('-').slice(-1)[0]}</b> · <b>{d.version}</b> · <b>{d.ms} ms</b></> : 'Waiting for the first response…'}</span>
    </div>
  );
}

function ServicesNow({ versions }) {
  return (
    <section className="slip" aria-labelledby="services-title">
      <h3 id="services-title">Services answering now</h3>
      {SERVICES.map((name) => {
        const v = versions?.[name];
        return (
          <div key={name} className={`svc-row${v && !v.ok ? ' down' : ''}`}>
            <span>{name}</span>
            <span className="num">{!v ? '—' : v.ok ? `${v.version} · ${v.pod.split('-').slice(-1)[0]}` : 'switched off'}</span>
          </div>
        );
      })}
      <p className="slip-note"><Link to="/monitor" className="btn btn-xs btn-secondary">Open the Monitor</Link></p>
    </section>
  );
}

// Feed vazio (ninguém seguido ainda): mostra as últimas do feed global logo abaixo.
function Latest({ onTag }) {
  const [state, setState] = useState({ loading: true, articles: [], count: 0 });
  useEffect(() => {
    api.articles({ limit: 5 }).then((r) => setState({ loading: false, articles: r.articles, count: r.articles.length }))
      .catch((e) => setState({ loading: false, articles: [], count: 0, error: e.status }));
  }, []);
  return <ArticleList state={state} setState={setState} page={0} setPage={() => {}} pageSize={5} onTag={onTag} />;
}

export default function Home({ versions }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag');
  const [feed, setFeed] = useState(user ? 'feed' : 'global');
  const tab = tag ? 'tag' : feed;
  const [page, setPage] = useState(0);
  const [state, setState] = useState({ loading: true, articles: [], count: 0 });
  const [tags, setTags] = useState(null);

  useEffect(() => { if (user && !tag) setFeed('feed'); }, [user]); // eslint-disable-line

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    const p = tab === 'feed' ? api.feed(PAGE, page * PAGE) : api.articles({ limit: PAGE, offset: page * PAGE, tag: tab === 'tag' ? tag : undefined });
    p.then((r) => alive && setState({ loading: false, articles: r.articles, count: r.articlesCount }))
      .catch((e) => alive && setState({ loading: false, articles: [], count: 0, error: e.messages?.join(', ') || e.status }));
    return () => { alive = false; };
  }, [tab, tag, page]);

  useEffect(() => { api.tags().then((r) => setTags(r.tags)).catch(() => setTags([])); }, []);

  const go = (t) => { setFeed(t); setParams({}); setPage(0); };
  const pickTag = (t) => { setParams({ tag: t }); setPage(0); };

  return (
    <div className="wrap home">
      <section className="feed">
        <div className="screen-head">
          <h1>Letters from a running cluster</h1>
          <p className="lede">Articles and comments delivered by Rust services on Kubernetes. Every page is postmarked by the pod that served it.</p>
          <DeliveredInline />
        </div>
        <div className="tabs" role="tablist" aria-label="Feeds">
          {user && <button role="tab" aria-selected={tab === 'feed'} className={`tab${tab === 'feed' ? ' on' : ''}`} onClick={() => go('feed')}>Your feed</button>}
          <button role="tab" aria-selected={tab === 'global'} className={`tab${tab === 'global' ? ' on' : ''}`} onClick={() => go('global')}>Global feed</button>
          {tag && <button role="tab" aria-selected className="tab on">#{tag}</button>}
        </div>
        <ArticleList state={state} setState={setState} page={page} setPage={setPage} pageSize={PAGE} onTag={pickTag}
          empty={tab === 'feed' ? 'Your feed is empty. Follow people from their profile and their articles land here. Meanwhile, the latest from everyone:' : 'No articles here yet.'} />
        {tab === 'feed' && !state.loading && !state.error && state.articles.length === 0 && <Latest onTag={pickTag} />}
      </section>
      <aside className="rail" aria-label="About this delivery">
        <Delivered />
        <ServicesNow versions={versions} />
        <section className="slip tags-slip" aria-labelledby="tags-title">
          <h3 id="tags-title">Popular tags</h3>
          {tags === null ? <span className="skeleton short" /> : tags.length ? (
            <div className="tags">{tags.slice(0, 20).map((t) => <Tag key={t} name={t} onClick={() => pickTag(t)} />)}</div>
          ) : <p className="slip-note">No tags yet.</p>}
        </section>
      </aside>
    </div>
  );
}
