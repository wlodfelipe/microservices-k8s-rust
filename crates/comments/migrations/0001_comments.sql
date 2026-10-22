CREATE TABLE IF NOT EXISTS comments (
    id         BIGSERIAL PRIMARY KEY,
    -- ids de outros serviços (articles, users): sem FK entre bancos
    article_id BIGINT NOT NULL,
    author_id  BIGINT NOT NULL,
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_article_idx ON comments (article_id, created_at DESC);
