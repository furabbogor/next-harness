CREATE TABLE IF NOT EXISTS harness_sessions (
  id text PRIMARY KEY,
  title text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS harness_sessions_updated_at_idx
  ON harness_sessions (updated_at DESC);
