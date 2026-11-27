-- docs/02-data-model.md §2, with two corrections to the published DDL:
--   * v_campaign_perf referenced events.member_id (no such column); it is matched_member_id.
--   * v_campaign_perf joined events of every state; it now counts state='matched' only.
-- Money is summed across whatever currencies the events carry, so each view also exposes
-- `currencies` (comma list). A consumer must label totals with it when it holds more than one.

CREATE VIEW v_member_value AS
SELECT m.id AS member_id, m.brand_id, m.telegram_id, m.username, m.joined_at,
       m.click_id, m.join_source,
       (SELECT iq_user_id FROM accounts a WHERE a.member_id = m.id ORDER BY a.id LIMIT 1) AS iq_user_id,
       COALESCE(SUM(CASE WHEN e.kind = 'ftd' THEN e.amount END), 0) AS ftd_amount,
       COALESCE(SUM(CASE WHEN e.kind = 'dep' THEN e.amount END), 0) AS redep_amount,
       COALESCE(SUM(CASE WHEN e.kind IN ('ftd', 'dep') THEN e.amount END), 0) AS total_amount,
       COALESCE(SUM(CASE WHEN e.kind = 'ftd' THEN 1 ELSE 0 END), 0) AS ftd_count,
       COUNT(e.event_id) AS event_count,
       MAX(e.received_at) AS last_event_at,
       GROUP_CONCAT(DISTINCT CASE WHEN e.kind IN ('ftd', 'dep') THEN e.currency END) AS currencies
FROM members m
LEFT JOIN events e ON e.matched_member_id = m.id AND e.state = 'matched'
GROUP BY m.id;

CREATE VIEW v_campaign_perf AS
SELECT c.brand_id, c.campaign, c.adset, c.ad,
       COUNT(DISTINCT c.click_id) AS clicks,
       COUNT(DISTINCT m.id) AS joins,
       COUNT(DISTINCT CASE WHEN e.kind = 'ftd' THEN e.matched_member_id END) AS ftds,
       COALESCE(SUM(CASE WHEN e.kind IN ('ftd', 'dep') THEN e.amount END), 0) AS revenue,
       GROUP_CONCAT(DISTINCT CASE WHEN e.kind IN ('ftd', 'dep') THEN e.currency END) AS currencies
FROM clicks c
LEFT JOIN members m ON m.click_id = c.click_id
LEFT JOIN events e ON e.matched_member_id = m.id AND e.state = 'matched'
GROUP BY c.brand_id, c.campaign, c.adset, c.ad;
