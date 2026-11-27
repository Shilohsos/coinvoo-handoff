import { sendText } from '../router.js';
import { log } from '../log.js';
import { TOKEN_RE, nowMs, ipHash, clientIp } from '../util.js';
import { withTx } from '../db.js';

const BOT_RE = /^[A-Za-z0-9_]{3,64}$/;

// User agents of link-preview crawlers and declared bots. Their opens are recorded (is_bot = 1) but never
// counted as clicks: a chat app unfurling the ad link is not a person tapping it.
export const CRAWLER_UA_RE = /bot\b|bot\/|crawler|spider|slurp|facebookexternalhit|facebot|preview|whatsapp|embedly|headless|lighthouse/i;
// The same person (same IP hash) opening the same link again within this window is one click.
export const OPEN_DEDUPE_MS = 60 * 1000;

function pick(query, name, max = 256) {
  const v = query.get(name);
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t.slice(0, max);
}

// GET /c/:token — stamp the volatile click data, then redirect to the gate bot.
// The row is minted by POST /api/links; a token that was never minted is never honoured.
export function clickRoutes({ db, salt }) {
  const find = db.prepare(
    `SELECT c.click_id, c.brand_id, c.campaign, b.code AS brand, b.bot_username, b.active
       FROM clicks c JOIN brands b ON b.id = c.brand_id
      WHERE c.click_id = ?`
  );
  // COALESCE(new, old) throughout: a re-open refreshes what it carries and never erases
  // what an earlier open recorded. Fixed context only fills gaps left at mint time.
  const stamp = db.prepare(
    `UPDATE clicks SET
       campaign = COALESCE(campaign, ?), adset = COALESCE(adset, ?),
       ad = COALESCE(ad, ?), creative = COALESCE(creative, ?),
       ttclid = COALESCE(?, ttclid), fbclid = COALESCE(?, fbclid), gclid = COALESCE(?, gclid),
       sub1 = COALESCE(?, sub1), sub2 = COALESCE(?, sub2), sub3 = COALESCE(?, sub3),
       utm_source = COALESCE(?, utm_source), utm_medium = COALESCE(?, utm_medium), utm_campaign = COALESCE(?, utm_campaign),
       utm_content = COALESCE(?, utm_content), utm_term = COALESCE(?, utm_term),
       ip_hash = COALESCE(?, ip_hash), ip_raw = COALESCE(?, ip_raw), ua = COALESCE(?, ua), referer = COALESCE(?, referer),
       clicked_at = ?
     WHERE click_id = ?`
  );

  const recentOpen = db.prepare('SELECT 1 AS x FROM click_opens WHERE click_id = ? AND ip_hash = ? AND opened_at >= ? LIMIT 1');
  const addOpen = db.prepare('INSERT INTO click_opens (click_id, brand_id, opened_at, ip_hash, is_bot) VALUES (?, ?, ?, ?, ?)');

  async function handler({ req, res, params, query }) {
    const token = params.token;
    if (!TOKEN_RE.test(token)) return sendText(res, 404, 'link not found');
    const row = find.get(token);
    if (!row || !row.active) return sendText(res, 404, 'link not found');

    const bot = String(row.bot_username).replace(/^@/, '');
    if (!BOT_RE.test(bot)) throw new Error(`brand ${row.brand} has an invalid bot_username`);

    const ip = clientIp(req);
    const hash = ip ? ipHash(ip, salt) : null;
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 512) : null;
    const now = nowMs();
    withTx(db, () => {
      stamp.run(
        pick(query, 'campaign'), pick(query, 'adset'), pick(query, 'ad'), pick(query, 'creative'),
        pick(query, 'ttclid'), pick(query, 'fbclid'), pick(query, 'gclid'),
        pick(query, 'sub1'), pick(query, 'sub2'), pick(query, 'sub3'),
        pick(query, 'utm_source'), pick(query, 'utm_medium'), pick(query, 'utm_campaign'), pick(query, 'utm_content'), pick(query, 'utm_term'),
        hash, ip || null, ua,
        req.headers.referer ? String(req.headers.referer).slice(0, 512) : null,
        now, token
      );
      if (!(hash && recentOpen.get(token, hash, now - OPEN_DEDUPE_MS))) {
        addOpen.run(token, row.brand_id, now, hash, ua && CRAWLER_UA_RE.test(ua) ? 1 : 0);
      }
    });

    const campaign = row.campaign || pick(query, 'campaign');
    log.info('click', { token, brand: row.brand, campaign });
    res.writeHead(302, {
      location: `https://t.me/${bot}?start=c_${token}`,
      'cache-control': 'no-store',
      'x-coinvoo-click': token
    });
    res.end();
  }

  // Link checkers (ad platforms, uptime monitors) use HEAD. Answer like GET so the ad is not flagged
  // as broken, but record nothing: a check is not a click.
  function head({ res, params }) {
    const token = params.token;
    const row = TOKEN_RE.test(token) ? find.get(token) : null;
    const bot = row ? String(row.bot_username).replace(/^@/, '') : '';
    if (!row || !row.active || !BOT_RE.test(bot)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end();
    }
    res.writeHead(302, { location: `https://t.me/${bot}?start=c_${token}`, 'cache-control': 'no-store', 'x-coinvoo-click': token });
    res.end();
  }

  return [['GET', '/c/:token', handler], ['HEAD', '/c/:token', head]];
}
