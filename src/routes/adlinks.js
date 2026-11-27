// Phase 12 — saved ad links: an ad points at /c/<code>; every visit mints its own click, asks the gate bot for a
// channel invite made for that click, and is sent to it. The join request then names the invite, and /api/join
// resolves the invite back to the click (src/routes/join.js).
//
// /c/:token keeps working exactly as before. Both live under /c/, and the router takes the first route that
// matches, so this module is registered FIRST and hands everything that is not an active ad link — a minted click
// token, an unknown code, an inactive link — to the untouched /c/:token handler. A token always wins.
import { HttpError, readJson, sendJson, sendText } from '../router.js';
import { requireAdmin, requireSameOrigin } from '../auth.js';
import { log } from '../log.js';
import { TOKEN_RE, clientIp, ipHash, newToken } from '../util.js';
import { withTx } from '../db.js';
import { mintLink } from './links.js';
import { clickRoutes, CRAWLER_UA_RE } from './click.js';

const BOT_RE = /^[A-Za-z0-9_]{3,64}$/;
// What a Telegram invite link looks like. Anything else from the bot is ignored, so a broken or compromised bot
// endpoint cannot turn /c/<code> into an open redirect.
export const INVITE_RE = /^https:\/\/t\.me\/(\+|joinchat\/)[A-Za-z0-9_-]{6,64}$/;
const MAX_FIELD = 200;
const MAX_RAW = 256;
const EDITABLE = ['label', 'campaign', 'adset', 'ad'];

// An unresolved ad macro ({{campaign.name}}) is not a value: a link opened outside the ad platform would
// otherwise store the placeholder as the campaign and poison every report built on it.
const MACRO_RE = /\{\{[^}]*\}\}/;
const ttqIds = (c) => (c && c.tiktokPixels) || [];
// Fire-and-forget: the hop must never wait on TikTok, and a failure must never change the redirect.
function fetchImplSafe(url, body) {
  try {
    const f = (deps.fetchImpl || globalThis.fetch)(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    if (f && f.catch) f.catch((e) => log.error('tiktok click send', e));
  } catch { /* ignore */ }
}

function first(query, names, max) {
  for (const n of names) {
    const v = query.get(n);
    if (v === null) continue;
    const t = v.trim();
    if (t !== '' && !MACRO_RE.test(t)) return t.slice(0, max);
  }
  return null;
}

// Phase 13 — campaign tags. Meta's dynamic parameters, for reference (`tags`), and the ONE compact parameter that is
// actually pasted into the ad's "URL parameters" field (`M_PARAM`). One key means Meta cannot drop or mangle
// separate ones, and nothing is URL-encoded twice. /c/<code> splits it into ad_id | adset_id | campaign_id | placement.
export const TAGS = '{{ad.name}}|{{adset.name}}|{{campaign.name}}|{{placement}}|{{site_source_name}}|{{campaign.id}}|{{adset.id}}|{{ad.id}}';
export const M_PARAM = 'm={{ad.id}}|{{adset.id}}|{{campaign.id}}|{{placement}}';
const M_FIELDS = ['ad_id', 'adset_id', 'campaign_id', 'placement'];

export function adLinkUrls(config, code) {
  const url = `${config.publicBase}/c/${code}`;
  return { url, tags: TAGS, template: `${url}?${M_PARAM}` };
}

// ?m=<ad.id>|<adset.id>|<campaign.id>|<placement> -> { ad_id, adset_id, campaign_id, placement }. Fewer parts store
// what they have; an empty or unresolved ({{…}}) part stores nothing.
export function parseM(raw) {
  const out = { ad_id: null, adset_id: null, campaign_id: null, placement: null };
  if (typeof raw !== 'string' || raw === '') return out;
  raw.split('|').slice(0, M_FIELDS.length).forEach((part, i) => {
    const t = part.trim();
    if (t !== '' && !MACRO_RE.test(t)) out[M_FIELDS[i]] = t.slice(0, MAX_FIELD);
  });
  return out;
}

const LINK_COLS = 'l.id, b.code AS brand, l.code, l.label, l.campaign, l.adset, l.ad, l.active, l.created_at, l.created_by';
const STATS_SQL = `SELECT l.id,
       (SELECT COUNT(*) FROM click_opens o JOIN clicks c ON c.click_id = o.click_id WHERE c.ad_link_id = l.id AND o.is_bot = 0) AS clicks,
       (SELECT COUNT(*) FROM members m JOIN clicks c ON c.click_id = m.click_id WHERE c.ad_link_id = l.id) AS members,
       (SELECT COALESCE(SUM(m.rejoins), 0) FROM members m JOIN clicks c ON c.click_id = m.click_id WHERE c.ad_link_id = l.id) AS rejoins
     FROM ad_links l`;

function shapeLink(config, r, s) {
  return {
    ...r, active: !!r.active, url: `${config.publicBase}/c/${r.code}`,
    // clicks = non-crawler visits; members = people bound to one of its clicks; joins = members plus their rejoins.
    stats: s ? { clicks: s.clicks, joins: s.members + s.rejoins, members: s.members } : undefined
  };
}

// Every ad link, newest first, with its counts (shared by GET /api/ad-links and /dash/ad-links).
export function listAdLinks(deps, { brand = null, activeFirst = true } = {}) {
  const { db, config } = deps;
  const rows = db.prepare(`SELECT ${LINK_COLS} FROM ad_links l JOIN brands b ON b.id = l.brand_id
    WHERE (? IS NULL OR b.code = ?) ORDER BY ${activeFirst ? 'l.active DESC, ' : ''}l.id DESC`).all(brand || null, brand || null);
  const stats = new Map(db.prepare(STATS_SQL).all().map((s) => [s.id, s]));
  return rows.map((r) => shapeLink(config, { ...r }, stats.get(r.id) || { clicks: 0, members: 0, rejoins: 0 }));
}

export function getAdLink(deps, id) {
  const r = Number.isSafeInteger(id) ? deps.db.prepare(`SELECT ${LINK_COLS} FROM ad_links l JOIN brands b ON b.id = l.brand_id WHERE l.id = ?`).get(id) : null;
  return r ? shapeLink(deps.config, { ...r }) : null;
}

// Create one link. A code shares the click tokens' alphabet and the /c/ path, so it must be unused in both tables.
export function createAdLink(deps, { brand: brandCode, label = null, campaign = null, adset = null, ad = null }) {
  const { db, config } = deps;
  const brand = db.prepare('SELECT id, code FROM brands WHERE code = ? AND active = 1').get(String(brandCode || '').trim());
  if (!brand) throw new HttpError(422, 'unknown_brand', `no active brand "${brandCode}"`);
  const taken = db.prepare('SELECT 1 AS x FROM ad_links WHERE code = ? UNION ALL SELECT 1 FROM clicks WHERE click_id = ?');
  let id = null;
  for (let attempt = 0; attempt < 5 && id === null; attempt++) {
    const code = (deps.newToken || newToken)();
    if (!TOKEN_RE.test(code) || taken.get(code, code)) continue;
    const r = db.prepare(`INSERT INTO ad_links (brand_id, code, label, campaign, adset, ad, active, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(code) DO NOTHING`)
      .run(brand.id, code, label, campaign, adset, ad, deps.now(), config.adminUser);
    if (r.changes === 1) id = Number(r.lastInsertRowid); // on a conflict lastInsertRowid is an older row's id
  }
  if (id === null) throw new Error('could not find an unused ad-link code after 5 attempts');
  const row = getAdLink(deps, id);
  log.info('adlink created', { code: row.code, brand: row.brand, campaign: row.campaign });
  return row;
}

// Change label / campaign / adset / ad / active. `changes` holds only the keys to change (already validated).
export function updateAdLink(deps, id, changes) {
  if (!getAdLink(deps, id)) throw new HttpError(404, 'not_found', 'no such ad link');
  const sets = [];
  const vals = [];
  for (const k of [...EDITABLE, 'active']) if (k in changes) { sets.push(`${k} = ?`); vals.push(k === 'active' ? (changes.active ? 1 : 0) : changes[k]); } // k from a fixed list
  if (!sets.length) throw new HttpError(400, 'bad_params', `nothing to change; send any of ${[...EDITABLE, 'active'].join(', ')}`);
  deps.db.prepare(`UPDATE ad_links SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  const row = getAdLink(deps, id);
  log.info('adlink updated', { code: row.code, active: row.active });
  return row;
}

export function optText(body, name) {
  const v = body[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'bad_params', `${name} must be a string`);
  const t = v.trim();
  if (t.length > MAX_FIELD) throw new HttpError(400, 'bad_params', `${name} is longer than ${MAX_FIELD} characters`);
  return t === '' ? null : t;
}

export function adLinkRoutes(deps) {
  const { db, config, salt } = deps;
  const [[, , clickGet], [, , clickHead]] = clickRoutes(deps);

  const isClick = db.prepare('SELECT 1 AS x FROM clicks WHERE click_id = ?');
  const findLink = db.prepare(
    `SELECT l.id, l.code, l.campaign, l.adset, l.ad, b.id AS brand_id, b.code AS brand, b.bot_username, b.invite_link AS brand_invite
       FROM ad_links l JOIN brands b ON b.id = l.brand_id
      WHERE l.code = ? AND l.active = 1 AND b.active = 1`
  );
  // Written once, on the row mint just created (the same columns /go stamps), plus the ad link that made it.
  const stamp = db.prepare(
    `UPDATE clicks SET ad_link_id = ?, ad_id = ?, adset_id = ?, campaign_id = ?, placement = ?, fbclid = ?, ttclid = ?, gclid = ?,
       utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_content = ?, utm_term = ?,
       ip_hash = ?, ip_raw = ?, ua = ?, referer = ?, clicked_at = ?
     WHERE click_id = ?`
  );
  const addOpen = db.prepare('INSERT INTO click_opens (click_id, brand_id, opened_at, ip_hash, is_bot) VALUES (?, ?, ?, ?, ?)');
  const addInvite = db.prepare('INSERT INTO invites (brand_id, click_id, invite_link, created_at) VALUES (?, ?, ?, ?)');
  // Fallback when the bot cannot mint: the newest invite none of whose clicks has a member yet, else the newest.
  const unusedInvite = db.prepare(
    `SELECT i.invite_link FROM invites i
      WHERE i.brand_id = ? AND NOT EXISTS (SELECT 1 FROM members m WHERE m.click_id = i.click_id)
      ORDER BY i.id DESC LIMIT 1`
  );
  const newestInvite = db.prepare('SELECT invite_link FROM invites WHERE brand_id = ? ORDER BY id DESC LIMIT 1');

  // Per-IP fixed one-second windows, the same limit as /go (GO_RATE_PER_SEC).
  const windows = new Map();
  function overLimit(req) {
    if (!config.goRatePerSec) return false;
    const key = clientIp(req) || 'unknown';
    const sec = Math.floor(deps.now() / 1000);
    let w = windows.get(key);
    if (!w || w.sec !== sec) {
      if (windows.size > 5000) for (const [k, v] of windows) if (v.sec < sec) windows.delete(k);
      w = { sec, n: 0 };
      windows.set(key, w);
    }
    w.n++;
    return w.n > config.goRatePerSec;
  }

  // Failures towards the bot: one log line per kind per minute, never the secret.
  const warned = new Map();
  function warn(kind, extra = {}) {
    const t = deps.now();
    if (warned.has(kind) && t - warned.get(kind) < 60000) return;
    warned.set(kind, t);
    log.info('invite fallback', { reason: kind, ...extra });
  }

  // POST {GATE_BOT_API}/invite {brand, click_id} -> { invite_link } | null. Never throws.
  async function requestInvite(brand, clickId) {
    if (!config.gateBotApi) return null;
    try {
      const r = await deps.fetchImpl(`${config.gateBotApi}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-coinvoo-token': config.gateSecret },
        body: JSON.stringify({ brand, click_id: clickId }),
        signal: AbortSignal.timeout(config.gateBotTimeoutMs)
      });
      if (r.status !== 200) { warn('bot_status', { status: r.status }); return null; }
      let j = null;
      try { j = await r.json(); } catch { /* not JSON */ }
      const link = j && typeof j.invite_link === 'string' ? j.invite_link.trim() : '';
      if (!INVITE_RE.test(link)) { warn('bot_bad_link'); return null; }
      return link;
    } catch (e) {
      warn(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'bot_timeout' : 'bot_unreachable');
      return null;
    }
  }

  async function open(ctx) {
    const { req, res, params, query } = ctx;
    const code = params.token;
    if (!TOKEN_RE.test(code) || isClick.get(code)) return clickGet(ctx); // a minted click token always wins
    const link = findLink.get(code);
    if (!link) return clickGet(ctx); // unknown or inactive: exactly what /c/:token does with it (404)
    if (overLimit(req)) return sendText(res, 429, 'rate limited', { 'retry-after': '1' });

    const bot = String(link.bot_username).replace(/^@/, '');
    if (!BOT_RE.test(bot)) throw new Error(`brand ${link.brand} has an invalid bot_username`);
    const now = deps.now();
    const ip = clientIp(req);
    const hash = ip ? ipHash(ip, salt) : null;
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 512) : null;
    const crawler = !!(ua && CRAWLER_UA_RE.test(ua));
    const raw = (name) => first(query, [name], MAX_RAW);

    // The ad's own parameters win; the saved link fills whatever they leave out.
    const token = withTx(db, () => {
      const minted = mintLink(db, {
        brand: link.brand, now,
        campaign: first(query, ['campaign_name', 'campaign'], MAX_FIELD) || link.campaign,
        adset: first(query, ['adset_name', 'adset'], MAX_FIELD) || link.adset,
        ad: first(query, ['ad_name', 'ad'], MAX_FIELD) || link.ad
      });
      if (!minted) return null;
      const m = parseM(query.get('m'));
      stamp.run(link.id, m.ad_id, m.adset_id, m.campaign_id, m.placement, raw('fbclid'), raw('ttclid'), raw('gclid'),
        raw('utm_source'), raw('utm_medium'), raw('utm_campaign'), raw('utm_content'), raw('utm_term'),
        hash, ip || null, ua, req.headers.referer ? String(req.headers.referer).slice(0, 512) : null, now, minted.token);
      addOpen.run(minted.token, link.brand_id, now, hash, crawler ? 1 : 0);
      return minted.token;
    });
    if (!token) return clickGet(ctx);

    // A link-preview crawler gets the click recorded (is_bot = 1) but never costs the bot an invite.
    // Crawlers get the page too now: an ad platform's checker must be able to see the pixel, and a link
    // preview that never redirects is no worse off.
    let invite = await requestInvite(link.brand, token);
    let how = 'minted';
    if (!invite) {
      invite = unusedInvite.get(link.brand_id)?.invite_link || newestInvite.get(link.brand_id)?.invite_link || null;
      how = 'reused';
    }
    if (invite) {
      try { addInvite.run(link.brand_id, token, invite, deps.now()); } catch (e) { log.error('invite record', e); }
    } else if (link.brand_invite) {
      invite = link.brand_invite;
      how = 'brand';
    } else {
      invite = `https://t.me/${bot}?start=c_${token}`; // nothing to join with: the bot start still carries the click
      how = 'bot';
    }
    log.info('adlink', { code, token, brand: link.brand, invite: how });

    // A plain 302 hides the pixel from Meta's event-setup tool ("a pixel wasn't detected"). The hop therefore
    // answers with a page that fires the dataset's PageView and forwards at once: one tap for the visitor, a
    // detectable pixel for Meta. The click is already recorded server-side above.
    // A crawler or checker is shown the page and left on it; only a browser is forwarded on.
    // `?nc=1` holds the page open for a platform checker that follows redirects too fast to read it.
    const preview = crawler || raw('nc') === '1';
    const pixel = config.metaPixel;
    const tiktokId = raw('ttclid');
    // The browser-side ttq is fired by the page, but a 900 ms redirect can cancel it, so the same click is also
    // sent server-side. It carries the ttclid, the visitor's IP and browser so TikTok can match it.
    // The browser-side ttq is fired by the page, but the redirect can cancel a request, so the click is also sent
    // server-side — awaited with a short timeout; reliability matters more than the sub-second saving.
    if (ttqIds(config).length) {
      try {
        await (deps.fetchImpl || globalThis.fetch)('https://example.com/api/tiktok', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: 'ClickButton', event_id: token, ttclid: raw('ttclid') || '', ip, user_agent: ua }),
          signal: AbortSignal.timeout(1500)
        });
      } catch (e) { log.error('tiktok click not sent', e); }
    }
    const ttqPixels = ttqIds(config);
    const ttqSnippet = ttqPixels.length ? `<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];
ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];
ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};
for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);
ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js";
ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=r;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]={};
n=document.createElement("script");n.type="text/javascript";n.async=!0;n.src=r+"?sdkid="+e+"&lib="+t;
var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(n,a)};
${ttqPixels.map((id) => `ttq.load('${id}');`).join('')}
ttq.page();ttq.track('ClickButton');}(window,document,'ttq');</script>
` : '';
    const safeInvite = invite.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening Telegram…</title>
${preview ? '' : `<meta http-equiv="refresh" content="0;url=${safeInvite}">`}
<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');</script>
${pixel ? `<script>fbq('init','${pixel}');fbq('track','PageView',{},{eventID:'${token}'});</script>` : ''}
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;
font:400 16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#fff;
background:#0b1520;background-image:radial-gradient(circle at 50% 0%,#1d68c9 0%,#0e4fa8 38%,#0b1520 100%);
background-attachment:fixed}
.wrap{text-align:center;padding:32px 24px;max-width:420px}
.mark{width:96px;height:96px;margin:0 auto 26px;border-radius:50%;
background:linear-gradient(180deg,#5cb3ff,#229ed9 55%,#1376b5);
display:flex;align-items:center;justify-content:center;
box-shadow:0 12px 26px rgba(0,0,0,.38),inset 0 2px 0 rgba(255,255,255,.55),inset 0 -6px 12px rgba(0,0,0,.22)}
.mark svg{width:52px;height:52px;margin-left:4px;filter:drop-shadow(0 2px 2px rgba(0,0,0,.28))}
h1{margin:0 0 8px;font-size:21px;font-weight:600;letter-spacing:.2px}
p{margin:0 0 26px;font-size:14px;color:rgba(255,255,255,.72)}
.btn{display:inline-flex;align-items:center;gap:10px;text-decoration:none;
padding:15px 30px;border-radius:14px;font-size:16px;font-weight:600;color:#06304f;
background:linear-gradient(180deg,#ffffff,#dfeaf5);
box-shadow:0 8px 0 #9fb8cc,0 14px 22px rgba(0,0,0,.32);
transition:transform .08s ease,box-shadow .08s ease}
.btn:active{transform:translateY(5px);box-shadow:0 3px 0 #9fb8cc,0 6px 12px rgba(0,0,0,.3)}
.btn svg{width:20px;height:20px}
.foot{margin-top:26px;font-size:12px;color:rgba(255,255,255,.45);letter-spacing:.3px}
</style></head><body><div class="wrap">
<div class="mark"><svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
<path d="M9.04 15.5l-.37 4.1c.53 0 .76-.23 1.04-.5l2.5-2.4 5.18 3.78c.95.53 1.63.25 1.87-.87l3.4-15.9.01-.01c.28-1.4-.51-1.95-1.44-1.6L1.7 9.55c-1.36.53-1.34 1.28-.23 1.62l4.68 1.46 10.9-6.87c.51-.34.98-.15.6.19L9.04 15.5z"/>
</svg></div>
<h1>Opening Telegram</h1>
<p>Taking you to the channel…</p>
<a class="btn" id="go" href="${safeInvite}">
<svg viewBox="0 0 24 24" fill="#229ed9" aria-hidden="true"><path d="M9.04 15.5l-.37 4.1c.53 0 .76-.23 1.04-.5l2.5-2.4 5.18 3.78c.95.53 1.63.25 1.87-.87l3.4-15.9.01-.01c.28-1.4-.51-1.95-1.44-1.6L1.7 9.55c-1.36.53-1.34 1.28-.23 1.62l4.68 1.46 10.9-6.87c.51-.34.98-.15.6.19L9.04 15.5z"/></svg>
Continue to Telegram</a>
<div class="foot">Powered by brand-one</div>
${ttqSnippet}
</div>
${preview ? '' : `<script>setTimeout(function(){location.replace(${JSON.stringify(invite)})},900);</script>`}
</body></html>`;
    // A real browser is sent on at once: an interstitial is a tap and a slow webview prompt that costs
    // joins. Only a crawler or ?nc=1 (platform checkers) gets the page. The pixels are already fired
    // server-side above, so nothing is lost by skipping the HTML.
    if (!preview) {
      res.writeHead(302, { location: invite, 'cache-control': 'no-store', 'x-coinvoo-click': token, 'x-coinvoo-invite': invite });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-coinvoo-click': token, 'x-coinvoo-invite': invite });
    res.end(body);
  }

  // HEAD: link checkers. Answer like GET would, but mint, record and ask for nothing.
  function head(ctx) {
    const { res, params } = ctx;
    const code = params.token;
    if (!TOKEN_RE.test(code) || isClick.get(code)) return clickHead(ctx);
    const link = findLink.get(code);
    if (!link) return clickHead(ctx);
    const to = newestInvite.get(link.brand_id)?.invite_link || link.brand_invite || `https://t.me/${String(link.bot_username).replace(/^@/, '')}`;
    res.writeHead(302, { location: to, 'cache-control': 'no-store' });
    res.end();
  }

  // ---------- admin ----------
  function list({ req, res, query }) {
    requireAdmin(req, config);
    sendJson(res, 200, { ok: true, ad_links: listAdLinks(deps, { brand: query.get('brand') }) });
  }

  async function create({ req, res }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const body = await readJson(req);
    if (typeof body.brand !== 'string' || !body.brand.trim()) throw new HttpError(400, 'bad_params', 'brand is required');
    const fields = Object.fromEntries(EDITABLE.map((k) => [k, optText(body, k)]));
    sendJson(res, 200, { ok: true, ad_link: createAdLink(deps, { brand: body.brand, ...fields }) });
  }

  async function patch({ req, res, params }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const id = Number(params.id);
    if (!getAdLink(deps, id)) throw new HttpError(404, 'not_found', 'no such ad link');
    const body = await readJson(req);
    const changes = {};
    for (const k of EDITABLE) if (k in body) changes[k] = optText(body, k);
    if ('active' in body) {
      if (typeof body.active !== 'boolean') throw new HttpError(400, 'bad_params', 'active must be true or false');
      changes.active = body.active;
    }
    sendJson(res, 200, { ok: true, ad_link: updateAdLink(deps, id, changes) });
  }

  function stats({ req, res, params }) {
    requireAdmin(req, config);
    const id = Number(params.id);
    const s = Number.isSafeInteger(id) ? db.prepare(`${STATS_SQL} WHERE l.id = ?`).get(id) : null;
    if (!s) throw new HttpError(404, 'not_found', 'no such ad link');
    // clicks = non-crawler visits; members = people bound to one of its clicks; joins = members plus their rejoins.
    sendJson(res, 200, { ok: true, clicks: s.clicks, joins: s.members + s.rejoins, members: s.members });
  }

  // GET /api/ad-links/:id/url[?tags=1] — the link to put in the ad; with tags=1 also the tag string and the full
  // template (the link with the compact `m` parameter Meta fills in).
  function urlOf({ req, res, params, query }) {
    requireAdmin(req, config);
    const link = getAdLink(deps, Number(params.id));
    if (!link) throw new HttpError(404, 'not_found', 'no such ad link');
    const u = adLinkUrls(config, link.code);
    sendJson(res, 200, query.get('tags') === '1' ? { ok: true, ...u } : { ok: true, url: u.url });
  }

  return [
    ['GET', '/c/:token', open],
    ['HEAD', '/c/:token', head],
    ['GET', '/api/ad-links', list],
    ['POST', '/api/ad-links', create],
    ['PATCH', '/api/ad-links/:id', patch],
    ['GET', '/api/ad-links/:id/stats', stats],
    ['GET', '/api/ad-links/:id/url', urlOf]
  ];
}
