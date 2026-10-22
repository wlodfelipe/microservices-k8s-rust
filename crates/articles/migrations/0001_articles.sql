CREATE TABLE IF NOT EXISTS articles (
    id              BIGSERIAL PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    body            TEXT NOT NULL,
    -- tags na ordem em que o autor escreveu (a spec preserva a ordem)
    tag_list        TEXT[] NOT NULL DEFAULT '{}',
    -- id do usuário no serviço `users` (sem FK: outro banco, outro serviço)
    author_id       BIGINT NOT NULL,
    -- contador desnormalizado, atualizado na mesma transação do favorito
    favorites_count INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS articles_created_idx ON articles (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS articles_author_idx ON articles (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS articles_tags_idx ON articles USING GIN (tag_list);

CREATE TABLE IF NOT EXISTS favorites (
    user_id    BIGINT NOT NULL,
    article_id BIGINT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, article_id)
);
CREATE INDEX IF NOT EXISTS favorites_article_idx ON favorites (article_id);
