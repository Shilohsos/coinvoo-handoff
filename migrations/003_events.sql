-- Phase 2 (docs/02-data-model.md): events, attributions, attribution_log, costs, daily_rollup.
-- accounts already exists (001_init). Additive only.

-- Locked decision 2026-11-15: brand-one only. brand-two stays seeded but inactive.
UPDATE brands SET active = 0 WHERE code = 'brand-two';

CREATE TABLE events (
  event_id          TEXT PRIMARY KEY,
  brand_id          INTEGER REFERENCES brands(id),
  network           TEXT NOT NULL DEFAULT 'affstore',
  status_raw        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  trader_id         TEXT,
  amount            REAL,
  currency          TEXT DEFAULT 'USD',
  country           TEXT,
  click_id          TEXT,
  aff_track         TEXT,
  payload_json      TEXT NOT NULL,
  received_at       INTEGER NOT NULL,
  state             TEXT NOT NULL DEFAULT 'new',
  ignore_reason     TEXT,
  matched_member_id INTEGER REFERENCES members(id),
  matched_at        INTEGER,
  forward_state     TEXT NOT NULL DEFAULT 'none',
  forward_tries     INTEGER NOT NULL DEFAULT 0,
  forward_next_at   INTEGER,
  forward_resp      TEXT
);

CREATE INDEX idx_events_state ON events(state, received_at);
CREATE INDEX idx_events_trader ON events(trader_id);
CREATE INDEX idx_events_received ON events(received_at DESC);
CREATE INDEX idx_events_forward ON events(forward_state, forward_next_at);

CREATE TABLE attributions (
  event_id   TEXT PRIMARY KEY REFERENCES events(event_id),
  member_id  INTEGER REFERENCES members(id),
  path       TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  decided_at INTEGER NOT NULL,
  note       TEXT
);

CREATE TABLE attribution_log (
  id         INTEGER PRIMARY KEY,
  event_id   TEXT NOT NULL,
  candidate  TEXT,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_alog_event ON attribution_log(event_id);

CREATE TABLE costs (
  id         INTEGER PRIMARY KEY,
  brand_id   INTEGER NOT NULL REFERENCES brands(id),
  day        TEXT NOT NULL,
  campaign   TEXT NOT NULL DEFAULT '',
  adset      TEXT NOT NULL DEFAULT '',
  ad         TEXT NOT NULL DEFAULT '',
  spend      REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  note       TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (brand_id, day, campaign, adset, ad)
);

-- Rebuilt by the worker, never appended by hand. revenue and spend are USD only.
CREATE TABLE daily_rollup (
  brand_id INTEGER NOT NULL,
  day      TEXT NOT NULL,
  clicks   INTEGER NOT NULL DEFAULT 0,
  joins    INTEGER NOT NULL DEFAULT 0,
  regs     INTEGER NOT NULL DEFAULT 0,
  ftds     INTEGER NOT NULL DEFAULT 0,
  redeps   INTEGER NOT NULL DEFAULT 0,
  revenue  REAL NOT NULL DEFAULT 0,
  spend    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, day)
);
