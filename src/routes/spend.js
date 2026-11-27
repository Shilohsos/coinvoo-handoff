import { HttpError, readJson, sendJson } from '../router.js';
import { requireAdmin, requireSameOrigin } from '../auth.js';
import { log } from '../log.js';
import * as Q from '../queries.js';

const MAX_TEXT = 200;
const MAX_NOTE = 500;
const MAX_SPEND = 1e9;

// 'YYYY-MM-DD' that is a real calendar day. It is a Lagos day label and is stored as given.
export function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === day;
}

function text(b, name, max, dflt = '') {
  const v = b[name];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'string') throw new HttpError(400, 'bad_params', `${name} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, 'bad_params', `${name} is longer than ${max} characters`);
  return t;
}

// Validate a spend entry (JSON body or form fields). Returns the normalised row and its brand id.
// 400 = malformed, 422 = well-formed but unacceptable (unknown brand, negative spend).
export function parseSpend(db, b) {
  if (typeof b.brand !== 'string' || b.brand.trim() === '') throw new HttpError(400, 'bad_params', 'brand is required');
  const brand = db.prepare('SELECT id, code FROM brands WHERE code = ? AND active = 1').get(b.brand.trim());
  if (!brand) throw new HttpError(422, 'unknown_brand', `no active brand "${b.brand}"`);

  if (!validDay(b.day)) throw new HttpError(400, 'bad_params', 'day must be a real date, YYYY-MM-DD (Africa/Lagos)');

  const raw = b.spend;
  const amount = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(amount)) throw new HttpError(400, 'bad_params', 'spend must be a number');
  if (amount < 0) throw new HttpError(422, 'negative_spend', 'spend cannot be negative');
  if (amount > MAX_SPEND) throw new HttpError(400, 'bad_params', 'spend is out of range');

  const currency = text(b, 'currency', 3, 'USD').toUpperCase() || 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'bad_params', 'currency must be a 3-letter ISO code');
  const note = text(b, 'note', MAX_NOTE, '');

  return {
    brandId: brand.id, brand: brand.code, day: b.day,
    campaign: text(b, 'campaign', MAX_TEXT), adset: text(b, 'adset', MAX_TEXT), ad: text(b, 'ad', MAX_TEXT),
    spend: amount, currency, note: note === '' ? null : note
  };
}

// Shared by POST /api/spend and the dashboard form: validate, upsert, log.
export function saveSpend(deps, input) {
  const r = parseSpend(deps.db, input);
  const row = Q.upsertSpend(deps.db, { ...r, now: deps.now() });
  log.info('spend', { brand: r.brand, day: r.day, campaign: r.campaign, adset: r.adset, ad: r.ad, amount: r.spend, currency: r.currency });
  return { ...row, brand: r.brand };
}

export function spendRoutes(deps) {
  const { db, config } = deps;

  async function post({ req, res }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const row = saveSpend(deps, await readJson(req));
    sendJson(res, 200, { ok: true, spend: row });
  }

  function list({ req, res, query }) {
    requireAdmin(req, config);
    const from = query.get('from');
    const to = query.get('to');
    if ((from && !validDay(from)) || (to && !validDay(to))) throw new HttpError(400, 'bad_params', 'from/to must be YYYY-MM-DD');
    const rows = Q.listSpend(db, {
      brandId: Q.resolveBrandId(db, query.get('brand')), fromDay: from, toDay: to, limit: Q.parseLimit(query.get('limit'), 500, 1000)
    });
    sendJson(res, 200, { ok: true, count: rows.length, spend: rows });
  }

  // DELETE /api/spend/:id — remove one row (Phase 11). 404 when it does not exist.
  function del({ req, res, params }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const row = Q.deleteSpend(db, Number(params.id));
    if (!row) throw new HttpError(404, 'not_found', 'no such spend row');
    log.info('spend deleted', { brand_id: row.brand_id, day: row.day, campaign: row.campaign, amount: row.spend, currency: row.currency });
    sendJson(res, 200, { ok: true, deleted: row });
  }

  return [
    ['POST', '/api/spend', post],
    ['GET', '/api/spend', list],
    ['DELETE', '/api/spend/:id', del]
  ];
}
