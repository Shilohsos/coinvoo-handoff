-- Phase 12 (directive "Phase 10: ad links -> channel invites -> join binding"). Saved ad links resolved at
-- /c/<code>, and the per-click channel invites the gate bot mints for them. Additive only.
CREATE TABLE ad_links (
  id          INTEGER PRIMARY KEY,
  brand_id    INTEGER NOT NULL REFERENCES brands(id),
  code        TEXT NOT NULL UNIQUE,
  label       TEXT,
  campaign    TEXT,
  adset       TEXT,
  ad          TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);
CREATE INDEX ad_links_brand ON ad_links(brand_id, active);

-- One row per click an invite was handed to: the invite the bot minted for it, or the one it re-used when minting
-- was refused. A join is resolved back to its click through this table.
CREATE TABLE invites (
  id          INTEGER PRIMARY KEY,
  brand_id    INTEGER NOT NULL REFERENCES brands(id),
  click_id    TEXT NOT NULL,
  invite_link TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX invites_click ON invites(click_id);
CREATE INDEX invites_link ON invites(invite_link);
CREATE INDEX invites_brand ON invites(brand_id, id);

-- Which ad link minted a click (NULL for every other click), for the per-link counts.
ALTER TABLE clicks ADD COLUMN ad_link_id INTEGER REFERENCES ad_links(id);
CREATE INDEX idx_clicks_ad_link ON clicks(ad_link_id);
