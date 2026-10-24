import { useId } from 'react';
import { Link } from 'react-router-dom';

// Peças do mundo "air mail": a faixa de chevrons, o carimbo postal, o selo de estado,
// as etiquetas de tag e o avatar de iniciais.

// Faixa de chevrons no topo da moldura. É padrão SVG (não gradiente) e as cores vêm dos
// tokens, então a web v2 troca as cores sozinha. Em `quiet` ela fica cinza (reconectando).
export function Chevrons() {
  return (
    <svg className="chevrons" aria-hidden="true" preserveAspectRatio="none">
      <defs>
        <pattern id="chev" width="44" height="10" patternUnits="userSpaceOnUse">
          <path d="M0 10L10 0h12L12 10z" className="chev-a" />
          <path d="M22 10L32 0h12L34 10z" className="chev-b" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#chev)" />
    </svg>
  );
}

// O envelope do wordmark.
export function Mark({ size = 28 }) {
  return (
    <svg className="mark-glyph" width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect x="2" y="6" width="24" height="17" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M2.8 7l11.2 8.6L25.2 7" fill="none" className="mark-flap" strokeWidth="2.2" strokeLinejoin="round" />
    </svg>
  );
}

const clock = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Carimbo postal: o pod do gateway que entregou a resposta, a versão e a hora.
export function Postmark({ delivery, size = 104, label = 'gateway', arcLabel = true }) {
  const pod = delivery?.pod?.split('-').slice(-1)[0] || '·····';
  const arc = useId();
  return (
    <svg className="postmark" width={size} height={size} viewBox="0 0 104 104" role="img"
      aria-label={delivery ? `Delivered by pod ${delivery.pod}, version ${delivery.version}, at ${clock(delivery.at)}` : 'Waiting for the first delivery'}>
      <defs><path id={arc} d="M13 52a39 39 0 0178 0" /></defs>
      <circle cx="52" cy="52" r="50" fill="none" strokeWidth="2.2" strokeDasharray="70 2.5 46 1.5 92 3" />
      <circle cx="52" cy="52" r="34" fill="none" strokeWidth="1" />
      {arcLabel && <text className="pm-arc"><textPath href={`#${arc}`} startOffset="50%" textAnchor="middle">{label.toUpperCase()}</textPath></text>}
      <text x="52" y="50" textAnchor="middle" className="pm-big">{delivery?.version || '—'}</text>
      <text x="52" y="64" textAnchor="middle" className="pm-small">{pod}</text>
      <text x="52" y="77" textAnchor="middle" className="pm-small">{delivery ? clock(delivery.at) : '--:--:--'}</text>
    </svg>
  );
}

// Selo de estado: a palavra carrega o estado; o tom só reforça.
export function Stamp({ kind = 'ok', children }) {
  return <span className={`stamp stamp-${kind}`}>{children}</span>;
}

export function Tag({ name, onClick, as = 'span' }) {
  if (as === 'link') return <Link className="tag" to={`/?tag=${encodeURIComponent(name)}`}>{name}</Link>;
  if (onClick) return <button type="button" className="tag" onClick={onClick}>{name}</button>;
  return <span className="tag">{name}</span>;
}

// Avatar: a foto, se a pessoa tiver; senão a inicial num dos três tons da paleta, estável por nome.
export function Avatar({ user, size = 32 }) {
  const name = user?.username || '?';
  if (user?.image) return <img className="avatar" src={user.image} width={size} height={size} alt="" />;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 3;
  return (
    <span className={`avatar avatar-initial tint-${h}`} style={{ width: size, height: size, fontSize: size * 0.46 }} aria-hidden="true">
      {name[0].toUpperCase()}
    </span>
  );
}
