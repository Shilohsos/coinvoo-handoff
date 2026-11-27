# 02 — Data Model

SQLite, one file: `/srv/coinvoo/coinvoo.db`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

Conventions:

- All timestamps are `INTEGER` epoch **milliseconds, UTC**.
- All money is `REAL` plus an ISO-4217 `currency` column (`USD`, `NGN`).
- Public identifiers (`click_id`, `event_id`, token) are `TEXT`; internal keys are `INTEGER`.
- Every table has `created_at` unless stated.
- Append-only tables are never `UPDATE`d except for state transitions listed below.

---

## 1. Schema (migration `001_init.sql`)

### brands

```sql
CREATE TABLE brands (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,        -- 'brand-one' | 'brand-two'
  name           TEXT NOT NULL,
  affiliate_id   TEXT,                        -- affiliate network id
  bot_username   TEXT NOT NULL,               -- gate bot the click bridge targets
  channel_id     TEXT,                        -- Telegram channel id, '-100…'
  invite_link    TEXT,
  offer_link_tpl TEXT,                        -- contains {AFFTRACK}
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);
```

Seed in `migrations/002_seed_brands.sql` (values supplied at deploy time from env; see `reference/env.example`). Two rows expected: `brand-one`, `brand-two`.

### channels

```sql
CREATE TABLE channels (
  id            INTEGER PRIMARY KEY,
  brand_id      INTEGER NOT NULL REFERENCES brands(id),
  tg_channel_id TEXT NOT NULL UNIQUE,
  title         TEXT,
  join_mode     TEXT NOT NULL DEFAULT 'bot_approves',  -- bot_approves | request | open
  created_at    INTEGER NOT NULL
);
```

### clicks

```sql
CREATE TABLE clicks (
  click_id     TEXT PRIMARY KEY,              -- base32, 10 chars
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
  ip_hash      TEXT,                          -- sha256(ip + IP_SALT)[0..32]
  ua           TEXT,
  referer      TEXT,
  created_at   INTEGER NOT NULL,
  joined_at    INTEGER,                       -- set when a member binds to it
  member_id    INTEGER REFERENCES members(id)
);

CREATE INDEX idx_clicks_created ON clicks(created_at DESC);
CREATE INDEX idx_clicks_campaign ON clicks(brand_id, campaign, adset, ad);
```

### members

```sql
CREATE TABLE members (
  id           INTEGER PRIMARY KEY,
  brand_id     INTEGER NOT NULL REFERENCES brands(id),
  telegram_id  INTEGER NOT NULL,
  username     TEXT,
  first_name   TEXT,
  joined_at    INTEGER NOT NULL,
  click_id     TEXT REFERENCES clicks(click_id),
  join_source  TEXT NOT NULL,                 -- bot:start | channel:<id> | organic:bot | backfill
  last_seen_at INTEGER,
  UNIQUE (brand_id, telegram_id)
);

CREATE INDEX idx_members_click ON members(click_id);
CREATE INDEX idx_members_joined ON members(joined_at DESC);
```

### accounts  (Telegram member ↔ broker account)

```sql
CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members(id),
  iq_user_id TEXT NOT NULL UNIQUE,            -- trader_id from the broker
  source     TEXT NOT NULL,                   -- postback | bot_db | manual
  confidence INTEGER NOT NULL DEFAULT 100,
  linked_at  INTEGER NOT NULL
);

CREATE INDEX idx_accounts_member ON accounts(member_id);
```

`UNIQUE(iq_user_id)` is the rule that stops two Telegram identities claiming the same broker account.

### events  (raw postbacks — append-only)

```sql
CREATE TABLE events (
  event_id       TEXT PRIMARY KEY,            -- from the network; else generated uuid
  brand_id       INTEGER REFERENCES brands(id),
  network        TEXT NOT NULL DEFAULT 'affstore',
  status_raw     TEXT NOT NULL,               -- exactly what arrived
  kind           TEXT NOT NULL,               -- reg | ftd | dep
  trader_id      TEXT,
  amount         REAL,
  currency       TEXT DEFAULT 'USD',
  country        TEXT,
  click_id       TEXT,
  aff_track      TEXT,                        -- inbound afftrack, verbatim
  payload_json   TEXT NOT NULL,               -- the complete raw query/body
  received_at    INTEGER NOT NULL,
  state          TEXT NOT NULL DEFAULT 'new', -- new | matched | parked | expired | ignored
  ignore_reason  TEXT,                        -- stub_guard | duplicate_soft | bad_kind
  matched_member_id INTEGER REFERENCES members(id),
  matched_at     INTEGER,
  forward_state  TEXT NOT NULL DEFAULT 'none',-- none | pending | sent | failed | skipped
  forward_tries  INTEGER NOT NULL DEFAULT 0,
  forward_next_at INTEGER,
  forward_resp   TEXT
);

CREATE INDEX idx_events_state ON events(state, received_at);
CREATE INDEX idx_events_trader ON events(trader_id);
CREATE INDEX idx_events_received ON events(received_at DESC);
CREATE INDEX idx_events_forward ON events(forward_state, forward_next_at);
```

### attributions  (one row per decided event)

```sql
CREATE TABLE attributions (
  event_id     TEXT PRIMARY KEY REFERENCES events(event_id),
  member_id    INTEGER REFERENCES members(id),
  path         TEXT NOT NULL,                 -- afftrack | trader_id | click | manual | none
  confidence   INTEGER NOT NULL,              -- 100 | 90 | 85 | 0
  decided_at   INTEGER NOT NULL,
  note         TEXT
);
```

### attribution_log  (append-only audit trail)

```sql
CREATE TABLE attribution_log (
  id         INTEGER PRIMARY KEY,
  event_id   TEXT NOT NULL,
  candidate  TEXT,                            -- member id or telegram id tried
  reason     TEXT NOT NULL,                   -- rule applied / why rejected
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_alog_event ON attribution_log(event_id);
```

### costs  (manual ad spend, v1)

```sql
CREATE TABLE costs (
  id        INTEGER PRIMARY KEY,
  brand_id  INTEGER NOT NULL REFERENCES brands(id),
  day       TEXT NOT NULL,                    -- 'YYYY-MM-DD' in Africa/Lagos
  campaign  TEXT NOT NULL DEFAULT '',
  adset     TEXT NOT NULL DEFAULT '',
  ad        TEXT NOT NULL DEFAULT '',
  spend     REAL NOT NULL,
  currency  TEXT NOT NULL DEFAULT 'USD',
  note      TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (brand_id, day, campaign, adset, ad)
);
```

### daily_rollup  (rebuilt, never appended by hand)

```sql
CREATE TABLE daily_rollup (
  brand_id  INTEGER NOT NULL,
  day       TEXT NOT NULL,                    -- 'YYYY-MM-DD' Africa/Lagos
  clicks    INTEGER NOT NULL DEFAULT 0,
  joins     INTEGER NOT NULL DEFAULT 0,
  regs      INTEGER NOT NULL DEFAULT 0,
  ftds      INTEGER NOT NULL DEFAULT 0,
  redeps    INTEGER NOT NULL DEFAULT 0,
  revenue   REAL NOT NULL DEFAULT 0,
  spend     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, day)
);
```

### settings

```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Used for: `ip_salt` (generated at first boot if absent), `joinvoo_pb_url`, `park_hours`, `report_chat_id`, `report_hour`.

### schema_migrations

```sql
CREATE TABLE schema_migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);
```

---

## 2. Derived views (create in `003_views.sql`)

```sql
-- Member value: total deposits and counts
CREATE VIEW v_member_value AS
SELECT m.id AS member_id, m.brand_id, m.telegram_id, m.username, m.joined_at,
       m.click_id, m.join_source,
       (SELECT iq_user_id FROM accounts a WHERE a.member_id = m.id LIMIT 1) AS iq_user_id,
       COALESCE(SUM(CASE WHEN e.kind='ftd' THEN e.amount END),0) AS ftd_amount,
       COALESCE(SUM(CASE WHEN e.kind='dep' THEN e.amount END),0) AS redep_amount,
       COALESCE(SUM(CASE WHEN e.kind IN ('ftd','dep') THEN e.amount END),0) AS total_amount,
       COALESCE(SUM(CASE WHEN e.kind='ftd' THEN 1 ELSE 0 END),0) AS ftd_count,
       COUNT(e.event_id) AS event_count,
       MAX(e.received_at) AS last_event_at
FROM members m
LEFT JOIN events e ON e.matched_member_id = m.id AND e.state IN ('matched')
GROUP BY m.id;

-- Campaign performance (joins, conversions, spend)
CREATE VIEW v_campaign_perf AS
SELECT c.brand_id, c.campaign, c.adset, c.ad,
       COUNT(DISTINCT c.click_id) AS clicks,
       COUNT(DISTINCT m.id) AS joins,
       COUNT(DISTINCT CASE WHEN e.kind='ftd' THEN e.member_id END) AS ftds,
       COALESCE(SUM(CASE WHEN e.kind IN ('ftd','dep') THEN e.amount END),0) AS revenue
FROM clicks c
LEFT JOIN members m ON m.click_id = c.click_id
LEFT JOIN events e ON e.matched_member_id = m.id
GROUP BY c.brand_id, c.campaign, c.adset, c.ad;
```

---

## 3. Retention

| Data | Retention | Action |
|---|---|---|
| `events.payload_json` | 12 months | Nulled (row and amounts kept) by the Phase 5 maintenance task |
| `events` rows | permanent | Aggregated into `daily_rollup` |
| `clicks` | permanent | Small; needed for campaign ROI forever |
| `attribution_log` | permanent | Audit trail — never pruned |
| `daily_rollup` | rebuilt daily | Safe to delete entirely and regenerate |

---

## 4. Migration policy

- Files live in `migrations/`, named `NNN_description.sql`.
- Applied in numeric order at boot, inside a transaction, recorded in `schema_migrations`.
- **Additive only.** Adding a column is `ALTER TABLE … ADD COLUMN` with a default. Dropping or renaming requires a new table + copy, and a note in the PR.
- Never edit an applied migration file. Add the next number.

---

## 5. Invariants (test these in Phase 2)

1. `events` count for a day equals the sum of `reg/ftd/dep` in `daily_rollup` for that day.
2. No two `accounts` rows share an `iq_user_id`.
3. Every `events` row with `state='matched'` has exactly one `attributions` row with `confidence > 0`.
4. Every `events` row with `state='parked'` has zero `attributions` rows and `forward_state IN ('none','pending','sent')`.
5. `SUM(attributions.confidence=0)` equals the count of `state IN ('parked','expired')` plus `ignored` events.
6. `members.click_id`, when set, always exists in `clicks`.
