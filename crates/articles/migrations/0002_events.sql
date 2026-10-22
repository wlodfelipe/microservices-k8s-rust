-- Eventos esperando para ir ao RabbitMQ. Gravados na mesma transação da mudança de
-- estado; o relay (platform::bus) publica e apaga.
CREATE TABLE IF NOT EXISTS outbox (
    id          BIGSERIAL PRIMARY KEY,
    routing_key TEXT NOT NULL,
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mensagens já processadas (deduplicação: a entrega do RabbitMQ é at-least-once).
CREATE TABLE IF NOT EXISTS inbox (
    message_id  TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Quantidade de comentários, mantida pelos eventos comment.created/comment.deleted
-- vindos do serviço comments (consistência eventual: aparece mesmo com ele desligado).
ALTER TABLE articles ADD COLUMN IF NOT EXISTS comments_count INTEGER NOT NULL DEFAULT 0;
