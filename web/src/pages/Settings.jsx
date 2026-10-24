import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import Errors from '../components/Errors';
import { Avatar } from '../components/Postal';
import Icon from '../components/Icon';

export default function Settings() {
  const { user, loading, setUser, signOut } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user) nav('/login');
    if (user && !form) setForm({ image: user.image || '', username: user.username, bio: user.bio || '', email: user.email, password: '' });
  }, [user, loading]); // eslint-disable-line

  if (!form) return null;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = { ...form };
    if (!body.password) delete body.password;
    try {
      const r = await api.updateUser(body);
      setUser(r.user);
      nav(`/profile/${r.user.username}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <div className="wrap form-page">
      <h1>Settings</h1>
      <p className="sub">Your public profile and sign-in details.</p>
      <form className="form" onSubmit={submit}>
        <Errors error={error} />
        <div className="field">
          <label htmlFor="image">Profile picture URL</label>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Avatar user={{ username: form.username, image: form.image }} size={42} />
            <input id="image" className="input" name="image" type="url" placeholder="https://…" value={form.image} onChange={set('image')} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="username">Username</label>
          <input id="username" className="input" name="username" value={form.username} onChange={set('username')} />
        </div>
        <div className="field">
          <label htmlFor="bio">Bio</label>
          <textarea id="bio" className="input read" name="bio" rows="5" value={form.bio} onChange={set('bio')} />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" name="email" type="email" value={form.email} onChange={set('email')} />
        </div>
        <div className="field">
          <label htmlFor="password">New password</label>
          <input id="password" className="input" name="password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
          <span className="hint">Leave empty to keep the current one.</span>
        </div>
        <div className="form-actions">
          <span />
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
        </div>
      </form>
      <hr className="divider" />
      <button className="btn btn-danger" onClick={() => { signOut(); nav('/'); }}><Icon name="out" /> Sign out</button>
    </div>
  );
}
