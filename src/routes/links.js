import { HttpError, readJson, sendJson } from '../router.js';
import { log } from '../log.js';
import { newToken, nowMs } from '../util.js';
import { requireAdmin, requireSameOrigin } from '../auth.js';

const FIELDS = ['campaign', 'adset', 'ad', 'creative'];
const MAX_FIELD = 200;

function optString(body, name) {
  const v = body[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'bad_params', `${name} must be a string`);
  const t = v.trim();
  if (t.length > MAX_FIELD) throw new HttpError(400, 'bad_params', `${name} is longer than ${MAX_FIELD} characters`);
  return t === '' ? null : t;
}

// Mint one link row. Returns { token, brand } or null when the brand is unknown/inactive.
export function mintLink(db, { brand, campaign = null, adset = null, ad = null, creative = null, now = nowMs() }) {
  const b = db.prepare('SELECT id, code, bot_username FROM brands WHERE code = ? AND active = 1').get(brand);
  if (!b) return null;
  const insert = db.prepare(
    `INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, creative, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(click_id) DO NOTHING`
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = newToken();
    if (insert.run(token, b.id, campaign, adset, ad, creative, now).changes === 1) {
      return { token, brand: b };
    }
  }
  throw new Error('could not mint a unique token after 5 attempts');
}

export function linkUrls(config, brand, token) {
  return {
    url: `${config.publicBase}/c/${token}`,
    telegram_url: `https://t.me/${String(brand.bot_username).replace(/^@/, '')}?start=c_${token}`
  };
}

// POST /api/links (admin, basic auth)
export function linkRoutes({ db, config }) {
  async function create({ req, res }) {
    requireAdmin(req, config); // the same failed-sign-in limit as every other admin route
    // Browsers resend cached Basic credentials on cross-site posts; a text/plain form can carry JSON.
    requireSameOrigin(req);
    const body = await readJson(req);
    if (typeof body.brand !== 'string' || body.brand.trim() === '') {
      throw new HttpError(400, 'bad_params', 'brand is required');
    }
    const fields = {};
    for (const f of FIELDS) fields[f] = optString(body, f);

    const minted = mintLink(db, { brand: body.brand.trim(), ...fields });
    if (!minted) throw new HttpError(422, 'unknown_brand', `no active brand "${body.brand}"`);

    log.info('link', { token: minted.token, brand: minted.brand.code, campaign: fields.campaign });
    sendJson(res, 200, { ok: true, token: minted.token, ...linkUrls(config, minted.brand, minted.token) });
  }

  return [['POST', '/api/links', create]];
}
