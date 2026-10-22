import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

// Rodapé "ao vivo": mostra a versão que cada microserviço está respondendo agora.
// Durante um rolling update dá para ver a versão mudar sem recarregar a página.
// Se a versão do próprio front mudar (web v1 → v2), avisa e oferece recarregar.
export default function Footer() {
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
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const svc = (name) => {
    const v = versions?.[name];
    const ok = v?.ok;
    return (
      <span key={name} className={`svc-chip ${ok ? 'ok' : 'down'}`} title={ok ? `${v.pod || ''}` : 'indisponível'}>
        {name} {ok ? v.version : 'off'}
      </span>
    );
  };

  return (
    <footer>
      {web && loaded.current && web !== loaded.current && (
        <div className="update-banner">
          Nova versão do front-end publicada ({loaded.current} → {web}).{' '}
          <button className="btn btn-sm btn-primary" onClick={() => window.location.reload()}>Recarregar</button>
        </div>
      )}
      <div className="container">
        <Link to="/" className="logo-font">conduit</Link>
        <span className="attribution">
          RealWorld em microserviços Rust no Kubernetes ·{' '}
          <span className={`svc-chip ok`}>web {loaded.current || '…'}</span>
          {['gateway', 'users', 'articles', 'comments'].map(svc)}
        </span>
      </div>
    </footer>
  );
}
