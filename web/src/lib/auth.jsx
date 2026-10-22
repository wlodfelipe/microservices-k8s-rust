import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    if (!getToken()) return;
    api.currentUser()
      .then((r) => setUser(r.user))
      .catch((e) => { if (e.status === 401) setToken(null); })
      .finally(() => setLoading(false));
  }, []);

  const signIn = (u) => { setToken(u.token); setUser(u); };
  const signOut = () => { setToken(null); setUser(null); };

  return <AuthCtx.Provider value={{ user, loading, signIn, signOut, setUser }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
