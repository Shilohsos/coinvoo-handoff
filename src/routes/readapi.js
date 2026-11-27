import { HttpError, sendJson } from '../router.js';
import { requireAdmin } from '../auth.js';
import * as Q from '../queries.js';
import { validDay } from './spend.js';
import { buildDailyReport, reportDayFor, summarize, topCampaign } from '../report.js';

// Read API (docs/05 §6): the numbers the dashboard and the daily card show, as JSON, for bots and
// ad-hoc queries. Same auth as the admin JSON; every answer carries `generated_at` (epoch ms) and
// `Cache-Control: no-store`.
export function readApiRoutes(deps) {
  const { db, config } = deps;

  // GET /api/report/daily?day=YYYY-MM-DD&brand=brand-one — exactly what the card prints. No day = yesterday
  // (the day the scheduled card covers); no brand = every active brand plus the combined total.
  function daily({ req, res, query }) {
    requireAdmin(req, config);
    const now = deps.now();
    const day = query.get('day') || reportDayFor(now);
    if (!validDay(day)) throw new HttpError(400, 'bad_params', 'day must be a real date, YYYY-MM-DD (Africa/Lagos)');
    const brand = query.get('brand');
    if (brand && brand !== 'all') Q.resolveBrandId(db, brand); // 400 on an unknown code
    const report = buildDailyReport(db, { day, brandCode: brand && brand !== 'all' ? brand : null, now, silenceHours: deps.reportConfig ? deps.reportConfig.silenceHours : 6 });
    sendJson(res, 200, { ok: true, ...report });
  }

  // GET /api/summary?period=today|7d|30d&brand= — the Overview numbers (and the previous period's counts).
  function summary({ req, res, query }) {
    requireAdmin(req, config);
    const now = deps.now();
    const brandCode = query.get('brand') || 'all';
    const brandId = Q.resolveBrandId(db, brandCode);
    const range = Q.periodRange({ period: query.get('period'), from: query.get('from'), to: query.get('to') }, now);
    const cur = summarize(db, { brandId, start: range.start, end: range.end, fromDay: range.fromDay, toDay: range.toDay });
    const label = (ms) => new Date(ms + 3600000).toISOString().slice(0, 10); // Lagos calendar day of an instant
    const prev = summarize(db, { brandId, start: range.prevStart, end: range.prevEnd, fromDay: label(range.prevStart), toDay: label(range.prevEnd - 1) });
    sendJson(res, 200, {
      ok: true, generated_at: now, currency: 'USD', brand: brandCode,
      period: { key: range.key, from: range.fromDay, to: range.toDay },
      ...cur,
      top_campaign: topCampaign(db, { brandId, start: range.start, end: range.end, fromDay: range.fromDay, toDay: range.toDay }),
      last_event_at: Q.lastEventAt(db, brandId),
      previous: { clicks: prev.clicks, joins: prev.joins, regs: prev.regs, ftds: prev.ftds, redeps: prev.redeps, revenue: prev.revenue }
    });
  }

  // GET /api/member/:telegram_id[?brand=brand-one] — value and the last five events, for the bots.
  function member({ req, res, params, query }) {
    requireAdmin(req, config);
    if (!/^\d{1,15}$/.test(params.telegram_id)) throw new HttpError(400, 'bad_params', 'telegram_id must be a positive integer');
    const brand = query.get('brand');
    const brandId = brand && brand !== 'all' ? Q.resolveBrandId(db, brand) : null;
    const found = db.prepare('SELECT id, brand_id FROM members WHERE telegram_id = ? AND (? IS NULL OR brand_id = ?) ORDER BY id LIMIT 2')
      .all(Number(params.telegram_id), brandId, brandId);
    if (!found.length) throw new HttpError(404, 'not_found', 'no such member');
    if (found.length > 1) throw new HttpError(409, 'ambiguous_brand', 'this Telegram id is a member of several brands; pass ?brand=');
    const d = Q.memberDetail(db, found[0].id);
    const { offer_link_tpl, ...m } = d.member;
    void offer_link_tpl;
    const value = d.value; // per currency: ftd, redep, total, events, last_event_at
    sendJson(res, 200, {
      ok: true, generated_at: deps.now(),
      member: { id: m.id, brand: m.brand_code, telegram_id: m.telegram_id, username: m.username, first_name: m.first_name, joined_at: m.joined_at, join_source: m.join_source,
        campaign: m.campaign, adset: m.adset, ad: m.ad },
      accounts: d.accounts.map((a) => a.iq_user_id),
      value,
      events: d.trail.slice(0, 5)
    });
  }

  return [
    ['GET', '/api/report/daily', daily],
    ['GET', '/api/summary', summary],
    ['GET', '/api/member/:telegram_id', member]
  ];
}
