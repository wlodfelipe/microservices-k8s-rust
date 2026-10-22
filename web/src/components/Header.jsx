import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const link = ({ isActive }) => `nav-link${isActive ? ' active' : ''}`;

export default function Header() {
  const { user } = useAuth();
  return (
    <nav className="navbar navbar-light">
      <div className="container">
        <Link className="navbar-brand" to="/">conduit</Link>
        <ul className="nav navbar-nav pull-xs-right">
          <li className="nav-item"><NavLink className={link} to="/" end>Home</NavLink></li>
          {user ? (
            <>
              <li className="nav-item"><NavLink className={link} to="/editor"><i className="ion-compose" />&nbsp;New Article</NavLink></li>
              <li className="nav-item"><NavLink className={link} to="/settings"><i className="ion-gear-a" />&nbsp;Settings</NavLink></li>
              <li className="nav-item">
                <NavLink className={link} to={`/profile/${user.username}`}>
                  <img src={user.image || '/default-avatar.svg'} className="user-pic" alt="" />
                  {user.username}
                </NavLink>
              </li>
            </>
          ) : (
            <>
              <li className="nav-item"><NavLink className={link} to="/login">Sign in</NavLink></li>
              <li className="nav-item"><NavLink className={link} to="/register">Sign up</NavLink></li>
            </>
          )}
          <li className="nav-item"><NavLink className={link} to="/monitor"><i className="ion-stats-bars" />&nbsp;Monitor</NavLink></li>
        </ul>
      </div>
    </nav>
  );
}
