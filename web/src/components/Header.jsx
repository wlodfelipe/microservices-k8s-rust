import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Avatar, Chevrons, Mark } from './Postal';
import Icon from './Icon';

const link = ({ isActive }) => `nav-link${isActive ? ' active' : ''}`;

export default function Header() {
  const { user } = useAuth();
  return (
    <header className="masthead">
      <Chevrons />
      <div className="wrap">
        <Link className="wordmark" to="/" aria-label="conduit, home"><Mark />conduit</Link>
        <nav className="nav" aria-label="Main">
          <NavLink className={link} to="/" end>Home</NavLink>
          <NavLink className={link} to="/monitor">Monitor</NavLink>
        </nav>
        <div className="masthead-right">
          {user ? (
            <>
              <Link className="btn btn-sm" to="/editor"><Icon name="pen" /><span className="write-label">Write an article</span></Link>
              <NavLink className={link} to="/settings">Settings</NavLink>
              <NavLink className={({ isActive }) => `${link({ isActive })} me`} to={`/profile/${user.username}`}>
                <Avatar user={user} size={28} /><span className="me-name">{user.username}</span>
              </NavLink>
            </>
          ) : (
            <>
              <NavLink className={link} to="/login">Sign in</NavLink>
              <Link className="btn btn-sm" to="/register">Sign up</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
