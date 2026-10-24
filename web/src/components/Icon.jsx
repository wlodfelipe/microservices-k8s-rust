// Ícones desenhados para o conduit: traço único de 1.6px, 16px, herdam a cor do texto.
const PATHS = {
  pen: 'M3 13l1-3.5L11.5 2l2.5 2.5L6.5 12 3 13zM10 3.5l2.5 2.5',
  heart: 'M8 13.5S2 10 2 5.8A3 3 0 018 4.3a3 3 0 016 1.5C14 10 8 13.5 8 13.5z',
  trash: 'M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5',
  plus: 'M8 3v10M3 8h10',
  check: 'M3 8.5l3 3 7-7',
  x: 'M4 4l8 8M12 4l-8 8',
  up: 'M8 13V3M4 7l4-4 4 4',
  power: 'M8 2v6M4.6 4.2a5 5 0 106.8 0',
  refresh: 'M13 3v3.5H9.5M13 6.5A5 5 0 103 8',
  out: 'M6 2.5H3v11h3M10 5l3 3-3 3M13 8H6',
  play: 'M5 3l8 5-8 5V3z',
  stop: 'M4 4h8v8H4z',
};

export default function Icon({ name, size = 16, className = '', label }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={PATHS[name]} />
    </svg>
  );
}
