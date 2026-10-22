-- Contagem de uso de cada tag, mantida por trigger na mesma transação que muda o artigo.
-- GET /tags era um unnest + GROUP BY na tabela inteira a cada visita à home; com isto vira
-- uma leitura de índice (ver teste de capacidade no README).
CREATE TABLE IF NOT EXISTS tag_counts (
    tag TEXT PRIMARY KEY,
    n   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tag_counts_rank_idx ON tag_counts (n DESC, tag);

CREATE OR REPLACE FUNCTION articles_tag_counts() RETURNS trigger AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        UPDATE tag_counts SET n = n - 1 WHERE tag = ANY (OLD.tag_list);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        -- ordem fixa evita deadlock entre dois artigos com as mesmas tags
        INSERT INTO tag_counts (tag, n)
        SELECT t, 1 FROM unnest(NEW.tag_list) AS t GROUP BY t ORDER BY t
        ON CONFLICT (tag) DO UPDATE SET n = tag_counts.n + 1;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS articles_tag_counts ON articles;
CREATE TRIGGER articles_tag_counts
    AFTER INSERT OR DELETE OR UPDATE OF tag_list ON articles
    FOR EACH ROW EXECUTE FUNCTION articles_tag_counts();

-- carga inicial a partir do que já existe
INSERT INTO tag_counts (tag, n)
SELECT t, count(*) FROM articles, unnest(tag_list) AS t GROUP BY t
ON CONFLICT (tag) DO UPDATE SET n = EXCLUDED.n;
