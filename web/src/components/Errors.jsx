export default function Errors({ error }) {
  if (!error) return null;
  const msgs = error.messages?.length ? error.messages : [error.message || String(error)];
  return <ul className="error-messages">{msgs.map((m) => <li key={m}>{m}</li>)}</ul>;
}
