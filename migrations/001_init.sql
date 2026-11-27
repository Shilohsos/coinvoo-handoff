-- Phase 1 subset of docs/02-data-model.md:
-- brands, channels, clicks, members, accounts, settings, schema_migrations.
-- Timestamps: INTEGER epoch milliseconds, UTC.

CREATE TABLE brands (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  affiliate_id   TEXT,
  bot_username   TEXT NOT NULL,
  channel_id     TEXT,
  invite_link    TEXT,
  offer_link_tpl TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);

CREATE TABLE channels (
  id            INTEGER PRIMARY KEY,
  brand_id      INTEGER NOT NULL REFERENCES brands(id),
  tg_channel_id TEXT NOT NULL UNIQUE,
  title         TEXT,
  join_mode     TEXT NOT NULL DEFAULT 'bot_approves',
  created_at    INTEGER NOT NULL
);

-- One row per minted link (token == click_id). Fixed ad context is written when the
-- link is minted; volatile fields stay NULL until the link is opened.
-- created_at is the mint time; clicked_at is the most recent open (NULL = never opened).
CREATE TABLE clicks (
  click_id     TEXT PRIMARY KEY,
  brand_id     INTEGER NOT NULL REFERENCES brands(id),
  campaign     TEXT,
  adset        TEXT,
  ad           TEXT,
  creative     TEXT,
  ttclid       TEXT,
  fbclid       TEXT,
  gclid        TEXT,
  sub1         TEXT,
  sub2         TEXT,
  sub3         TEXT,
  ip_hash      TEXT,
  ua           TEXT,
  referer      TEXT,
  created_at   INTEGER NOT NULL,
  clicked_at   INTEGER,
  joined_at    INTEGER,
  member_id    INTEGER REFERENCES members(id)
);

CREATE INDEX idx_clicks_created ON clicks(created_at DESC);
CREATE INDEX idx_clicks_campaign ON clicks(brand_id, campaign, adset, ad);

CREATE TABLE members (
  id           INTEGER PRIMARY KEY,
  brand_id     INTEGER NOT NULL REFERENCES brands(id),
  telegram_id  INTEGER NOT NULL,
  username     TEXT,
  first_name   TEXT,
  joined_at    INTEGER NOT NULL,
  click_id     TEXT REFERENCES clicks(click_id),
  join_source  TEXT NOT NULL,
  last_seen_at INTEGER,
  UNIQUE (brand_id, telegram_id)
);

CREATE INDEX idx_members_click ON members(click_id);
CREATE INDEX idx_members_joined ON members(joined_at DESC);

CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members(id),
  iq_user_id TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 100,
  linked_at  INTEGER NOT NULL
);

CREATE INDEX idx_accounts_member ON accounts(member_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE schema_migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);
