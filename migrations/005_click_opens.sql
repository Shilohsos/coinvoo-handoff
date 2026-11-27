-- One row per open of an ad link. clicks holds one row per ad link and can only remember its LAST open,
-- so counting clicks by clicks.clicked_at made past periods shrink whenever a link was opened again.
-- Additive. The backfill gives each existing link the one open it still remembers, so the numbers on the
-- day this is deployed are exactly the numbers of the day before.

CREATE TABLE click_opens (
  id        INTEGER PRIMARY KEY,
  click_id  TEXT NOT NULL REFERENCES clicks(click_id),
  brand_id  INTEGER NOT NULL REFERENCES brands(id),
  opened_at INTEGER NOT NULL,
  ip_hash   TEXT,
  is_bot    INTEGER NOT NULL DEFAULT 0   -- link-preview crawlers: kept for the record, never counted
);

CREATE INDEX idx_opens_brand_time ON click_opens(brand_id, opened_at);
CREATE INDEX idx_opens_click_time ON click_opens(click_id, opened_at);

INSERT INTO click_opens (click_id, brand_id, opened_at, ip_hash, is_bot)
SELECT click_id, brand_id, clicked_at, ip_hash, 0 FROM clicks WHERE clicked_at IS NOT NULL;
