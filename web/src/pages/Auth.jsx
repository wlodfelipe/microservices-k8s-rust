import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import Errors from '../components/Errors';

export default function Auth({ mode }) {
  const isLogin = mode === 'login';
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = isLogin ? await api.login(form.email, form.password) : await api.register(form.username, form.email, form.password);
      signIn(r.user);
      nav('/');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <div className="wrap auth">
    <div className="form-page">
      <h1>{isLogin ? 'Sign in' : 'Create an account'}</h1>
      <p className="sub">
        {isLogin ? <>New here? <Link to="/register">Create an account</Link></> : <>Already have one? <Link to="/login">Sign in</Link></>}
      </p>
      <form className="form" onSubmit={submit}>
        <Errors error={error} />
        {!isLogin && (
          <div className="field">
            <label htmlFor="username">Username</label>
            <input id="username" className="input" name="username" autoComplete="username" value={form.username} onChange={set('username')} required />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" name="email" type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" name="password" type="password" autoComplete={isLogin ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')} required />
        </div>
        <div className="form-actions">
          <span />
          <button className="btn" disabled={busy}>{busy ? (isLogin ? 'Signing in…' : 'Creating…') : isLogin ? 'Sign in' : 'Create account'}</button>
        </div>
      </form>
    </div>
    <aside className="slip route" aria-labelledby="route-title">
      <h3 id="route-title">Where your {isLogin ? 'sign-in' : 'sign-up'} goes</h3>
      <ol>
        <li><b>gateway</b><span>Receives the form and forwards it inside the cluster; the users service is never exposed outside it.</span></li>
        <li><b>users</b><span>{isLogin ? 'Checks your password against its argon2 hash.' : 'Stores your password as an argon2 hash, never in plain text.'}</span></li>
        <li><b>token</b><span>You get a signed JWT. The gateway checks it on every request and passes only your id to the other services.</span></li>
      </ol>
    </aside>
    </div>
  );
}
