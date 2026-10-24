import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ArticleList } from './ArticleList';
import { Stamp } from './Postal';

// "Devolvido ao remetente": a página não existe. Em vez de uma tela vazia, mostra as
// cartas mais recentes para a pessoa seguir lendo.
export default function Returned({ title = 'Return to sender', message }) {
  const [state, setState] = useState({ loading: true, articles: [], count: 0 });
  useEffect(() => {
    api.articles({ limit: 4 })
      .then((r) => setState({ loading: false, articles: r.articles, count: r.articles.length }))
      .catch((e) => setState({ loading: false, articles: [], count: 0, error: e.status }));
  }, []);
  return (
    <div className="wrap returned">
      <div className="returned-head">
        <Stamp kind="held">Returned</Stamp>
        <h1>{title}</h1>
        <p className="lede">{message} <Link to="/">Back to the feed</Link></p>
      </div>
      <h2 className="returned-sub">Recent letters</h2>
      <ArticleList state={state} setState={setState} page={0} setPage={() => {}} pageSize={4} />
    </div>
  );
}
