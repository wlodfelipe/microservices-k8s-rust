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
    <div className="auth-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-6 offset-md-3 col-xs-12">
            <h1 className="text-xs-center">{isLogin ? 'Sign in' : 'Sign up'}</h1>
            <p className="text-xs-center">
              {isLogin ? <Link to="/register">Need an account?</Link> : <Link to="/login">Have an account?</Link>}
            </p>
            <Errors error={error} />
            <form onSubmit={submit}>
              {!isLogin && (
                <fieldset className="form-group">
                  <input className="form-control form-control-lg" name="username" type="text" placeholder="Username" value={form.username} onChange={set('username')} />
                </fieldset>
              )}
              <fieldset className="form-group">
                <input className="form-control form-control-lg" name="email" type="email" placeholder="Email" value={form.email} onChange={set('email')} />
              </fieldset>
              <fieldset className="form-group">
                <input className="form-control form-control-lg" name="password" type="password" placeholder="Password" value={form.password} onChange={set('password')} />
              </fieldset>
              <button className="btn btn-lg btn-primary pull-xs-right" disabled={busy}>{isLogin ? 'Sign in' : 'Sign up'}</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
