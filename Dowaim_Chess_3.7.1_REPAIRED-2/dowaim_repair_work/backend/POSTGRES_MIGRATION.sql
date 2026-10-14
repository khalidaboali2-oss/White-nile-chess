-- White Nile Chess PostgreSQL foundation.
-- Dowaim Chess 3.7.1 stores the current application state snapshot in PostgreSQL JSONB.
-- This single-row snapshot is durable but is not a normalized transactional repository for multi-replica scaling.
CREATE TABLE IF NOT EXISTS app_state (
  id SMALLINT PRIMARY KEY CHECK (id=1),
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_state_updated_at_idx ON app_state(updated_at);
