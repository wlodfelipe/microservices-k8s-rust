import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import Errors from '../components/Errors';

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
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const t = tagInput.trim();
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
    <div className="editor-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-10 offset-md-1 col-xs-12">
            <Errors error={error} />
            <form onSubmit={submit}>
              <fieldset>
                <fieldset className="form-group">
                  <input type="text" name="title" className="form-control form-control-lg" placeholder="Article Title" value={form.title} onChange={set('title')} />
                </fieldset>
                <fieldset className="form-group">
                  <input type="text" name="description" className="form-control" placeholder="What's this article about?" value={form.description} onChange={set('description')} />
                </fieldset>
                <fieldset className="form-group">
                  <textarea name="body" className="form-control" rows="8" placeholder="Write your article (in markdown)" value={form.body} onChange={set('body')} />
                </fieldset>
                <fieldset className="form-group">
                  <input type="text" className="form-control" placeholder="Enter tags" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={addTag} />
                  <div className="tag-list">
                    {form.tagList.map((t) => (
                      <span key={t} className="tag-default tag-pill">
                        <i className="ion-close-round" onClick={() => setForm({ ...form, tagList: form.tagList.filter((x) => x !== t) })} /> {t}
                      </span>
                    ))}
                  </div>
                </fieldset>
                <button className="btn btn-lg pull-xs-right btn-primary" type="submit" disabled={busy}>Publish Article</button>
              </fieldset>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
