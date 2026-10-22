import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import Errors from '../components/Errors';

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
    <div className="settings-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-6 offset-md-3 col-xs-12">
            <h1 className="text-xs-center">Your Settings</h1>
            <Errors error={error} />
            <form onSubmit={submit}>
              <fieldset>
                <fieldset className="form-group">
                  <input className="form-control" name="image" type="text" placeholder="URL of profile picture" value={form.image} onChange={set('image')} />
                </fieldset>
                <fieldset className="form-group">
                  <input className="form-control form-control-lg" name="username" type="text" placeholder="Your Name" value={form.username} onChange={set('username')} />
                </fieldset>
                <fieldset className="form-group">
                  <textarea className="form-control form-control-lg" name="bio" rows="8" placeholder="Short bio about you" value={form.bio} onChange={set('bio')} />
                </fieldset>
                <fieldset className="form-group">
                  <input className="form-control form-control-lg" name="email" type="text" placeholder="Email" value={form.email} onChange={set('email')} />
                </fieldset>
                <fieldset className="form-group">
                  <input className="form-control form-control-lg" name="password" type="password" placeholder="New Password" value={form.password} onChange={set('password')} />
                </fieldset>
                <button className="btn btn-lg btn-primary pull-xs-right" disabled={busy}>Update Settings</button>
              </fieldset>
            </form>
            <hr />
            <button className="btn btn-outline-danger" onClick={() => { signOut(); nav('/'); }}>Or click here to logout.</button>
          </div>
        </div>
      </div>
    </div>
  );
}
