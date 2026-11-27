-- Phase 8: outbound Meta Conversions API queue. One row per thing worth sending, keyed so a retry,
-- a re-match, or a restart can never send the same conversion twice.
CREATE TABLE meta_sends (
  send_id    TEXT PRIMARY KEY,          -- 'join:<brand_id>:<telegram_id>' | 'evt:<event_id>'
  kind       TEXT NOT NULL,             -- lead | registration | purchase
  ref        TEXT NOT NULL,             -- the member id or event id, as text
  brand_id   INTEGER,
  state      TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  tries      INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER,
  resp       TEXT,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX idx_meta_due ON meta_sends(state, next_at);

-- Raw client IP for match quality. The hash stays the dashboard's only view of the address.
ALTER TABLE clicks ADD COLUMN ip_raw TEXT;
