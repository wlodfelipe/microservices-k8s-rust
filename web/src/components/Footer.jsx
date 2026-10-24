import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Mark } from './Postal';

// Rodapé "ao vivo": a versão que cada microserviço está respondendo agora. Durante um
// rolling update dá para ver a versão mudar sem recarregar a página. Se a versão do
// próprio front mudar (web v1 → v2), avisa e oferece recarregar.
const SERVICES = ['gateway', 'users', 'articles', 'comments'];

export function useVersions() {
  const [versions, setVersions] = useState(null);
  const [web, setWeb] = useState(null);
  const loaded = useRef(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const v = await api.versions(); if (alive) setVersions(v); } catch { if (alive) setVersions(null); }
      try {
        const r = await fetch('/version.json', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        if (loaded.current === null) {
          loaded.current = j.version;
          document.documentElement.dataset.webVersion = j.version;
        }
        setWeb(j.version);
      } catch { /* sem version.json no dev */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return { versions, web, loadedWeb: loaded.current };
}

export default function Footer({ status }) {
  const { versions, web, loadedWeb } = status;
  return (
    <>
      {web && loadedWeb && web !== loadedWeb && (
        <div className="update-banner" role="status">
          <div className="wrap">
            A new front-end version is live ({loadedWeb} → {web}). You are still reading {loadedWeb}.
            <button className="btn btn-sm" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      )}
      <footer className="footer">
        <div className="wrap">
          <Link to="/" className="wordmark"><Mark size={22} />conduit</Link>
          <span className="footer-note">RealWorld as Rust microservices on Kubernetes</span>
          <ul className="versions" aria-label="Versions answering right now">
            <li>web <b>{loadedWeb || 'dev'}</b></li>
            {SERVICES.map((name) => {
              const v = versions?.[name];
              return (
                <li key={name} className={v?.ok ? '' : 'down'} title={v?.ok ? v.pod : 'not answering'}>
                  {name} <b>{v ? (v.ok ? v.version : 'off') : '—'}</b>
                </li>
              );
            })}
          </ul>
        </div>
      </footer>
    </>
  );
}
