import { sendText } from '../router.js';
import { log } from '../log.js';
import { clientIp, ipHash } from '../util.js';
import { withTx } from '../db.js';
import { mintLink } from './links.js';
import { CRAWLER_UA_RE } from './click.js';

// Same rule as /c/ (click.js keeps its copy private, and /c/ is not to be touched).
const BOT_RE = /^[A-Za-z0-9_]{3,64}$/;
const MAX_FIELD = 200; // the mapped campaign/adset/ad/creative/sub fields
const MAX_RAW = 256;   // click ids and utm values, as on /c/

// Phase 9 Part A.3. The landing pages pass the ad platform's own names; the first non-empty one wins.
const MAP = {
  campaign: ['campaign_name', 'campaign_id', 'campaign', 'utm_campaign'],
  adset: ['adset_name', 'adset_id', 'adset', 'utm_medium'],
  ad: ['ad_name', 'ad_id', 'ad', 'utm_content'],
  creative: ['creative'],
  sub1: ['placement'],
  sub2: ['site_source_name'],
  sub3: ['utm_term']
};

function first(query, names, max) {
  for (const n of names) {
    const v = query.get(n);
    if (v === null) continue;
    const t = v.trim();
    if (t !== '') return t.slice(0, max);
  }
  return null;
}

// GET /go/:brand — the landing-page entry. Unlike /c/:token (one pre-minted link, many opens) every visit
// mints its own click, so each visitor carries their own fbclid, IP and user agent and binds to their own click_id.
export function goRoutes(deps) {
  const { db, config, salt } = deps;

  const findBrand = db.prepare('SELECT id, code, bot_username FROM brands WHERE code = ? AND active = 1');
  // Written once, on the row mint just created: no COALESCE, there is nothing earlier to keep.
  const stamp = db.prepare(
    `UPDATE clicks SET
       fbclid = ?, ttclid = ?, gclid = ?, sub1 = ?, sub2 = ?, sub3 = ?,
       utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_content = ?, utm_term = ?,
       ip_hash = ?, ip_raw = ?, ua = ?, referer = ?, clicked_at = ?
     WHERE click_id = ?`
  );
  const addOpen = db.prepare('INSERT INTO click_opens (click_id, brand_id, opened_at, ip_hash, is_bot) VALUES (?, ?, ?, ?, ?)');

  // Per-IP fixed one-second windows, the same approach as /api/aff. In memory: a restart forgets them.
  const windows = new Map();
  const warned = new Map();
  function overLimit(req) {
    if (!config.goRatePerSec) return false;
    const key = clientIp(req) || 'unknown';
    const now = deps.now();
    const sec = Math.floor(now / 1000);
    let w = windows.get(key);
    if (!w || w.sec !== sec) {
      if (windows.size > 5000) for (const [k, v] of windows) if (v.sec < sec) windows.delete(k);
      w = { sec, n: 0 };
      windows.set(key, w);
    }
    w.n++;
    if (w.n <= config.goRatePerSec) return false;
    if (!warned.has(key) || now - warned.get(key) >= 60000) {
      warned.set(key, now);
      if (warned.size > 5000) warned.clear();
      log.info('rate_limited', { route: '/go', ip: ipHash(key, salt).slice(0, 12), limit: config.goRatePerSec });
    }
    return true;
  }

  async function handler({ req, res, params, query }) {
    if (overLimit(req)) return sendText(res, 429, 'rate limited', { 'retry-after': '1' });

    // Never a default brand: an unknown or inactive code is a 404.
    const brand = findBrand.get(params.brand);
    if (!brand) return sendText(res, 404, 'link not found');
    const bot = String(brand.bot_username).replace(/^@/, '');
    if (!BOT_RE.test(bot)) throw new Error(`brand ${brand.code} has an invalid bot_username`); // before any row is written

    const now = deps.now();
    const ip = clientIp(req);
    const hash = ip ? ipHash(ip, salt) : null;
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 512) : null;
    const referer = req.headers.referer ? String(req.headers.referer).slice(0, 512) : null;
    const campaign = first(query, MAP.campaign, MAX_FIELD);
    const raw = (name) => first(query, [name], MAX_RAW);

    // Mint, stamp and record the open together: a visit leaves one click and one open, or nothing.
    const token = withTx(db, () => {
      const minted = mintLink(db, {
        brand: brand.code, campaign, adset: first(query, MAP.adset, MAX_FIELD), ad: first(query, MAP.ad, MAX_FIELD),
        creative: first(query, MAP.creative, MAX_FIELD), now
      });
      if (!minted) return null;
      stamp.run(
        raw('fbclid'), raw('ttclid'), raw('gclid'),
        first(query, MAP.sub1, MAX_FIELD), first(query, MAP.sub2, MAX_FIELD), first(query, MAP.sub3, MAX_FIELD),
        raw('utm_source'), raw('utm_medium'), raw('utm_campaign'), raw('utm_content'), raw('utm_term'),
        hash, ip || null, ua, referer, now, minted.token
      );
      // No open-dedupe: two visits are two clicks.
      addOpen.run(minted.token, brand.id, now, hash, ua && CRAWLER_UA_RE.test(ua) ? 1 : 0);
      return minted.token;
    });
    if (!token) return sendText(res, 404, 'link not found');

    log.info('go', { token, brand: brand.code, campaign });
    res.writeHead(302, {
      location: `https://t.me/${bot}?start=c_${token}`,
      'cache-control': 'no-store',
      'x-coinvoo-click': token
    });
    res.end();
  }

  // Link checkers (ad platforms, uptime monitors) use HEAD. Answer like GET so the CTA is not flagged as
  // broken, but mint and record nothing: a check is not a click. There is no token, so the bot link carries none.
  function head({ res, params }) {
    const brand = findBrand.get(params.brand);
    const bot = brand ? String(brand.bot_username).replace(/^@/, '') : '';
    if (!brand || !BOT_RE.test(bot)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end();
    }
    res.writeHead(302, { location: `https://t.me/${bot}`, 'cache-control': 'no-store' });
    res.end();
  }

  return [['GET', '/go/:brand', handler], ['HEAD', '/go/:brand', head]];
}
