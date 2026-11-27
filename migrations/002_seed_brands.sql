-- Brand seeds. Values arrive as bound parameters from BRAND_* environment variables
-- (see reference/env.example); nothing is interpolated into this file.
-- The brand-one row is mandatory (config.js enforces BRAND_ONE_BOT_USERNAME).
-- The brand-two row is seeded only when BRAND_TWO_BOT_USERNAME is set.

INSERT INTO brands (code, name, affiliate_id, bot_username, channel_id, invite_link, offer_link_tpl, active, created_at)
VALUES (
  COALESCE($BRAND_ONE_CODE, 'brand-one'),
  COALESCE($BRAND_ONE_NAME, 'brand-one'),
  $BRAND_ONE_AFFILIATE_ID,
  $BRAND_ONE_BOT_USERNAME,
  $BRAND_ONE_CHANNEL_ID,
  $BRAND_ONE_INVITE_LINK,
  $BRAND_ONE_OFFER_TPL,
  1,
  $NOW_MS
)
ON CONFLICT(code) DO NOTHING;

INSERT INTO brands (code, name, affiliate_id, bot_username, channel_id, invite_link, offer_link_tpl, active, created_at)
SELECT
  COALESCE($BRAND_TWO_CODE, 'brand-two'),
  COALESCE($BRAND_TWO_NAME, 'brand-two'),
  $BRAND_TWO_AFFILIATE_ID,
  $BRAND_TWO_BOT_USERNAME,
  $BRAND_TWO_CHANNEL_ID,
  $BRAND_TWO_INVITE_LINK,
  $BRAND_TWO_OFFER_TPL,
  1,
  $NOW_MS
WHERE $BRAND_TWO_BOT_USERNAME IS NOT NULL
ON CONFLICT(code) DO NOTHING;
