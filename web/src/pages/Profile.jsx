import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ArticleList } from '../components/ArticleList';
import Errors from '../components/Errors';

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

  if (error) return <div className="container page"><Errors error={error} /></div>;
  if (!profile) return null;
  const mine = user?.username === profile.username;
  const toggle = async () => {
    if (!user) return nav('/login');
    const r = profile.following ? await api.unfollow(username) : await api.follow(username);
    setProfile(r.profile);
  };

  return (
    <div className="profile-page">
      <div className="user-info">
        <div className="container">
          <div className="row">
            <div className="col-xs-12 col-md-10 offset-md-1">
              <img src={profile.image || '/default-avatar.svg'} className="user-img" alt="" />
              <h4>{profile.username}</h4>
              <p>{profile.bio}</p>
              {mine ? (
                <Link to="/settings" className="btn btn-sm btn-outline-secondary action-btn"><i className="ion-gear-a" />&nbsp;Edit Profile Settings</Link>
              ) : (
                <button className={`btn btn-sm ${profile.following ? 'btn-secondary' : 'btn-outline-secondary'} action-btn`} onClick={toggle}>
                  <i className="ion-plus-round" />&nbsp;{profile.following ? 'Unfollow' : 'Follow'} {profile.username}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="container">
        <div className="row">
          <div className="col-xs-12 col-md-10 offset-md-1">
            <div className="articles-toggle">
              <ul className="nav nav-pills outline-active">
                <li className="nav-item"><Link className={`nav-link${!favorites ? ' active' : ''}`} to={`/profile/${username}`}>My Articles</Link></li>
                <li className="nav-item"><Link className={`nav-link${favorites ? ' active' : ''}`} to={`/profile/${username}/favorites`}>Favorited Articles</Link></li>
              </ul>
            </div>
            <ArticleList state={state} setState={setState} page={page} setPage={setPage} pageSize={PAGE} />
          </div>
        </div>
      </div>
    </div>
  );
}
