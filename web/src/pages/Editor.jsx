import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import Errors from '../components/Errors';
import Icon from '../components/Icon';

export default function Editor() {
  const { slug } = useParams();
  const { user, loading } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ title: '', description: '', body: '', tagList: [] });
  const [tagInput, setTagInput] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!loading && !user) nav('/login'); }, [user, loading]); // eslint-disable-line
  useEffect(() => {
    if (!slug) { setForm({ title: '', description: '', body: '', tagList: [] }); return; }
    api.article(slug).then((r) => setForm({ title: r.article.title, description: r.article.description, body: r.article.body, tagList: r.article.tagList })).catch(setError);
  }, [slug]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const addTag = (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const t = tagInput.trim().replace(/,$/, '');
    if (t && !form.tagList.includes(t)) setForm({ ...form, tagList: [...form.tagList, t] });
    setTagInput('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = slug ? await api.updateArticle(slug, form) : await api.createArticle(form);
      nav(`/article/${r.article.slug}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <div className="wrap form-page wide">
      <h1>{slug ? 'Edit article' : 'Write an article'}</h1>
      <form className="form" onSubmit={submit}>
        <Errors error={error} />
        <div className="field">
          <label htmlFor="title">Title</label>
          <input id="title" className="input title" name="title" value={form.title} onChange={set('title')} />
        </div>
        <div className="field">
          <label htmlFor="description">Summary</label>
          <input id="description" className="input read" name="description" value={form.description} onChange={set('description')} />
          <span className="hint">One sentence. It shows under the title in the feed.</span>
        </div>
        <div className="field">
          <label htmlFor="body">Article</label>
          <textarea id="body" className="input read" name="body" rows="16" value={form.body} onChange={set('body')} />
          <span className="hint">Markdown: headings, lists, links and code blocks.</span>
        </div>
        <div className="field">
          <label htmlFor="tags">Tags</label>
          <input id="tags" className="input" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={addTag} />
          <span className="hint">Press Enter after each tag.</span>
          {form.tagList.length > 0 && (
            <div className="tags">
              {form.tagList.map((t) => (
                <button type="button" key={t} className="tag" aria-label={`Remove tag ${t}`}
                  onClick={() => setForm({ ...form, tagList: form.tagList.filter((x) => x !== t) })}>
                  {t}&nbsp;<Icon name="x" size={12} />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={() => nav(-1)}>Cancel</button>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Publishing…' : slug ? 'Save changes' : 'Publish article'}</button>
        </div>
      </form>
    </div>
  );
}
