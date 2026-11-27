import { once } from 'node:events';
import { requireAdmin } from '../auth.js';
import { log } from '../log.js';
import * as Q from '../queries.js';
import { lagosDayLabel, lagosDayStart } from '../worker.js';

const LAGOS_OFFSET_MS = 3600000;
const CHUNK_ROWS = 200;
const pad = (n) => String(n).padStart(2, '0');

// ISO-8601 in Africa/Lagos (UTC+1, no DST): 2026-11-15T18:29:00+01:00. Empty for no value.
export function isoLagos(ms) {
  if (ms === null || ms === undefined) return '';
  const d = new Date(ms + LAGOS_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+01:00`;
}

// RFC 4180 field. Numbers and null pass through; text with a comma, quote, CR or LF is quoted with
// inner quotes doubled. Text that a spreadsheet would run as a formula (= + - @ TAB CR at the
// start) gets a leading apostrophe: names and notes come from users, and the file gets opened in Excel.
export function csvField(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (fields) => `${fields.map(csvField).join(',')}\r\n`;

const money = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

// Write rows to the response in chunks, honouring backpressure. Nothing is accumulated beyond
// CHUNK_ROWS lines, so memory stays flat however large the export is.
async function stream(res, filename, header, rows, toFields) {
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  let buf = csvLine(header);
  let n = 0;
  let inBuf = 0;
  for (const row of rows) {
    if (res.destroyed) return n; // client went away
    buf += csvLine(toFields(row));
    n++;
    if (++inBuf >= CHUNK_ROWS) {
      if (!res.write(buf)) await once(res, 'drain');
      buf = '';
      inBuf = 0;
    }
  }
  res.end(buf);
  return n;
}

export function exportRoutes(deps) {
  const { db, config } = deps;

  // Period + brand filters as on the dashboard; no filter means the last 30 days. `period=all`
  // is an export-only extra for a complete dump.
  function filters(query) {
    const now = deps.now();
    const brandId = Q.resolveBrandId(db, query.get('brand'));
    if (query.get('period') === 'all' && !query.get('from') && !query.get('to')) {
      return { brandId, start: 0, end: 9e15, fromMs: null, toMs: null, fromDay: '0000-01-01', toDay: '9999-12-31', label: 'all', now };
    }
    const r = Q.periodRange({ period: query.get('period') || '30d', from: query.get('from'), to: query.get('to') }, now);
    return { brandId, start: r.start, end: r.end, fromMs: r.start, toMs: r.end, fromDay: r.fromDay, toDay: r.toDay, label: r.key, now };
  }

  const fname = (kind, now) => `coinvoo-${kind}-${lagosDayLabel(lagosDayStart(now))}.csv`;

  // joined, telegram, ... exactly the dashboard's member columns (snake_case) plus first_name and
  // the currency label for the amounts (USD only, like the screen).
  async function members({ req, res, query }) {
    requireAdmin(req, config);
    const f = filters(query);
    const rows = Q.iterMembers(db, { brandId: f.brandId, fromMs: f.fromMs, toMs: f.toMs, ftd: query.get('ftd') || '', q: query.get('q') || '', snapshot: deps.snapshot });
    const n = await stream(res, fname('members', f.now),
      ['joined', 'telegram', 'username', 'first_name', 'source', 'broker_id', 'ftd', 're_deposits', 'total', 'last_event', 'path', 'currency'],
      rows, (m) => [isoLagos(m.joined_at), m.telegram_id, m.username, m.first_name, Q.memberSource(m), m.iq_user_id,
        m.ftd_count ? money(m.ftd) : null, m.dep_count ? money(m.redep) : null, m.ftd_count || m.dep_count ? money(m.total) : null,
        isoLagos(m.last_event_at), m.path && m.path !== 'none' ? m.path : null, 'USD']);
    log.info('export', { kind: 'members', rows: n, period: f.label });
  }

  async function events({ req, res, query }) {
    requireAdmin(req, config);
    const f = filters(query);
    const rows = Q.iterEvents(db, { brandId: f.brandId, fromMs: f.fromMs, toMs: f.toMs, state: query.get('state') || '', kind: query.get('kind') || '', q: query.get('q') || '' });
    const n = await stream(res, fname('events', f.now),
      ['event_id', 'received', 'kind', 'amount', 'currency', 'trader_id', 'afftrack', 'country', 'state', 'ignore_reason', 'path', 'confidence', 'member', 'username', 'note'],
      rows, (e) => [e.event_id, isoLagos(e.received_at), e.kind, e.amount, e.currency, e.trader_id, e.aff_track, e.country, e.state,
        e.ignore_reason, e.path, e.confidence, e.telegram_id, e.username, e.attribution_note]);
    log.info('export', { kind: 'events', rows: n, period: f.label });
  }

  async function campaigns({ req, res, query }) {
    requireAdmin(req, config);
    const f = filters(query);
    const perf = Q.campaignPerf(db, { brandId: f.brandId, start: f.start, end: f.end, fromDay: f.fromDay, toDay: f.toDay });
    const n = await stream(res, fname('campaigns', f.now),
      ['campaign', 'ad_set', 'ad', 'clicks', 'joins', 'clicks_per_join', 'ftds', 'revenue', 'spend', 'cost_per_ftd', 'roi', 'brand', 'currency'],
      perf.rows, (r) => [r.is_none ? Q.NONE_LABEL : r.campaign, r.adset, r.ad, r.clicks, r.joins,
        r.clicks_per_join === null ? null : Math.round(r.clicks_per_join * 100) / 100, r.ftds, money(r.revenue),
        r.spend_rows > 0 ? money(r.spend) : null, r.cost_per_ftd === null ? null : money(r.cost_per_ftd),
        r.roi === null ? null : Math.round(r.roi * 10) / 10, r.brand, 'USD']);
    log.info('export', { kind: 'campaigns', rows: n, period: f.label });
  }

  return [
    ['GET', '/api/export/members.csv', members],
    ['GET', '/api/export/events.csv', events],
    ['GET', '/api/export/campaigns.csv', campaigns]
  ];
}

