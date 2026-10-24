import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ArticleList } from '../components/ArticleList';
import Errors from '../components/Errors';
import Returned from '../components/Returned';
import { Avatar } from '../components/Postal';
import Icon from '../components/Icon';

const PAGE = 5;

export default function Profile({ favorites }) {
  const { username } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(0);
  const [state, setState] = useState({ loading: true, articles: [], count: 0 });

  useEffect(() => { setError(null); api.profile(username).then((r) => setProfile(r.profile)).catch(setError); }, [username]);
  useEffect(() => { setPage(0); }, [username, favorites]);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const q = favorites ? { favorited: username } : { author: username };
    api.articles({ ...q, limit: PAGE, offset: page * PAGE })
      .then((r) => alive && setState({ loading: false, articles: r.articles, count: r.articlesCount }))
      .catch((e) => alive && setState({ loading: false, articles: [], count: 0, error: e.status }));
    return () => { alive = false; };
  }, [username, favorites, page]);

  if (error) {
    if (error.status === 404) return <Returned message={`No one is called ${username} here.`} />;
    return <div className="wrap form-page"><h1>Not delivered</h1><div style={{ marginTop: 20 }}><Errors error={error} /></div></div>;
  }
  if (!profile) return null;
  const mine = user?.username === profile.username;
  const toggle = async () => {
    if (!user) return nav('/login');
    const r = profile.following ? await api.unfollow(username) : await api.follow(username);
    setProfile(r.profile);
  };

  return (
    <>
      <header className="profile-head">
        <div className="wrap">
          <Avatar user={profile} size={88} />
          <div>
            <h1>{profile.username}</h1>
            {profile.bio && <p>{profile.bio}</p>}
          </div>
          <div className="actions">
            {mine ? (
              <Link to="/settings" className="btn btn-sm btn-secondary"><Icon name="pen" /> Edit profile</Link>
            ) : (
              <button className={`btn btn-sm ${profile.following ? 'btn-on' : 'btn-secondary'}`} onClick={toggle} aria-pressed={profile.following}>
                {profile.following ? <><Icon name="check" /> Following</> : <><Icon name="plus" /> Follow {profile.username}</>}
              </button>
            )}
          </div>
        </div>
      </header>
      <div className="wrap profile-body">
        <nav className="tabs" aria-label="Articles">
          <Link className={`tab${!favorites ? ' on' : ''}`} aria-current={!favorites ? 'page' : undefined} to={`/profile/${username}`}>Articles</Link>
          <Link className={`tab${favorites ? ' on' : ''}`} aria-current={favorites ? 'page' : undefined} to={`/profile/${username}/favorites`}>Favorites</Link>
        </nav>
        <ArticleList state={state} setState={setState} page={page} setPage={setPage} pageSize={PAGE}
          empty={favorites ? `${profile.username} has not favorited anything yet.` : `${profile.username} has not published anything yet.`} />
      </div>
    </>
  );
}
