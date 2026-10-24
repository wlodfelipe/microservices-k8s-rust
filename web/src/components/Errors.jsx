// A API devolve "username has already been taken"; na tela vira uma frase.
const PLAIN = { 'credentials invalid': 'Email or password is incorrect.', 'network unreachable': 'The server could not be reached. Check that the cluster is running.' };
const sentence = (m) => { const t = PLAIN[String(m).trim()] || String(m).trim(); return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : t; };

export default function Errors({ error }) {
  if (!error) return null;
  const msgs = error.messages?.length ? error.messages : [error.status ? `Request failed (HTTP ${error.status})` : error.message || String(error)];
  return <div className="errors" role="alert">{msgs.map((m) => <span key={m}>{sentence(m)}</span>)}</div>;
}
