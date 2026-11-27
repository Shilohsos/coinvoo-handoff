import { HttpError, readJson, sendJson } from '../router.js';
import { log } from '../log.js';
import { TOKEN_RE, nowMs, isLoopback, safeEqual } from '../util.js';
import { withTx } from '../db.js';
import { onMemberSeen } from '../matcher.js';

// Upsert a member on (brand_id, telegram_id). First touch wins on click_id.
// Throws HttpError 422 unknown_click when clickId is set but was never minted.
// Phase 8: with `capi`, a newly created member is queued as a Meta Lead after the commit. A failure there is
// logged and never fails the join.
// `keepNames`: a backfill row that carries no username / first name keeps the stored ones (Phase 10). A live join
// keeps the old rule: the gate bot reports what Telegram says now, so its value (even an empty one) wins.
// `live`: a real join from the channel rewrites joined_at and join_source on a row a backfill created, so the
// member's history starts at the join we actually saw. A backfill never does that.
// `countRejoin` (Phase 12, live joins only): a join for a member whose leave was recorded (left_at) is a rejoin —
// rejoins + 1, left_at cleared, the same member row. A backfill never counts as one.
export function recordJoin(db, { brandId, telegramId, username = null, firstName = null, clickId = null, source, now = nowMs(), capi = null, keepNames = false, countRejoin = false, live = false }) {
  const r = withTx(db, () => {
    if (clickId !== null && !db.prepare('SELECT 1 AS x FROM clicks WHERE click_id = ?').get(clickId)) {
      throw new HttpError(422, 'unknown_click', `click_id ${clickId} does not exist`);
    }
    const before = db.prepare('SELECT id, click_id, left_at FROM members WHERE brand_id = ? AND telegram_id = ?').get(brandId, telegramId);
    const row = db.prepare(
      `INSERT INTO members (brand_id, telegram_id, username, first_name, joined_at, click_id, join_source, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(brand_id, telegram_id) DO UPDATE SET
         username = CASE WHEN ? THEN COALESCE(excluded.username, members.username) ELSE excluded.username END,
         first_name = CASE WHEN ? THEN COALESCE(excluded.first_name, members.first_name) ELSE excluded.first_name END,
         last_seen_at = MAX(COALESCE(members.last_seen_at, 0), excluded.last_seen_at),
         click_id = COALESCE(members.click_id, excluded.click_id),
         joined_at = CASE WHEN ? AND members.join_source LIKE 'backfill%' THEN excluded.joined_at ELSE members.joined_at END,
         join_source = CASE WHEN ? AND members.join_source LIKE 'backfill%' THEN excluded.join_source ELSE members.join_source END
       RETURNING id, click_id`
    ).get(brandId, telegramId, username, firstName, now, clickId, source, now, keepNames ? 1 : 0, keepNames ? 1 : 0,
      live ? 1 : 0, live ? 1 : 0);

    const created = !before;
    const gotClick = row.click_id !== null && (!before || before.click_id === null);
    if (gotClick) {
      db.prepare('UPDATE clicks SET joined_at = ?, member_id = ? WHERE click_id = ?').run(now, row.id, row.click_id);
    }
    const rejoin = !!(countRejoin && before && before.left_at !== null);
    if (rejoin) db.prepare('UPDATE members SET rejoins = rejoins + 1, left_at = NULL WHERE id = ?').run(row.id);
    return { memberId: row.id, created, clickId: row.click_id, rejoin };
  });
  if (capi && r.created) {
    try {
      capi.enqueueJoin(db, { id: r.memberId, brand_id: brandId, telegram_id: telegramId }, nowMs());
    } catch (e) {
      log.error('join meta enqueue', e);
    }
  }
  return r;
}

const MAX_BATCH = 500;
const MAX_BATCH_BODY = 512 * 1024; // 500 rows do not fit the 64 KB limit of the shared JSON reader
const EARLIEST_JOIN_MS = Date.UTC(2020, 0, 1);

async function readBatchJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BATCH_BODY) throw new HttpError(413, 'too_large', 'request body too large');
    chunks.push(c);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'body is not valid JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'bad_json', 'body must be a JSON object');
  return parsed;
}

function optStr(body, name, max) {
  const v = body[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'bad_params', `${name} must be a string`);
  const t = v.trim();
  return t === '' ? null : t.slice(0, max);
}

// The shared join key, from X-Coinvoo-Key or the pre-rename X-Tribute-Key the gate bots still send.
// Fires once per join that carries a TikTok click id. Fire-and-forget: the bot must never wait on TikTok.
async function tiktokJoin(config, deps, db, clickId, eventId, req, eventName = 'CompleteRegistration') {
  if (!config.tiktokPixels || !config.tiktokPixels.length || !clickId) return;
  const c = db.prepare('SELECT ttclid FROM clicks WHERE click_id = ?').get(clickId);
  if (!c || !c.ttclid) return;
  const f = deps.fetchImpl || globalThis.fetch;
  const body = JSON.stringify({
    event: eventName, event_id: eventId, ttclid: c.ttclid,
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, user_agent: req.headers['user-agent'],
    properties: eventName === 'Subscribe' ? { content_type: 'channel_join' } : undefined
  });
  // Two tries: a join is worth 30 seconds of a paid click and must not be lost to one slow response.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const r = await f('https://example.com/api/tiktok', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(4000)
      });
      if (r && r.ok) return;
    } catch (e) {
      if (attempt === 2) log.error(`tiktok ${eventName} not sent`, e);
    }
  }
}

// Every header carrying a key is returned, so a stale value in one cannot mask a good one in the other.
export function joinKeyFromHeaders(req) {
  return ['x-coinvoo-key', 'x-tribute-key'].map((h) => req.headers[h]).filter((v) => typeof v === 'string' && v !== '');
}

// Auth: the join key when JOIN_KEY is set; otherwise the TCP peer must be loopback.
// Without a key, a request carrying X-Forwarded-For came through the reverse proxy
// (whose own peer address is loopback), so it is refused.
function authorize(req, config) {
  if (config.joinKey) {
    // Compare every candidate (constant time each), so timing does not reveal which header matched.
    const ok = joinKeyFromHeaders(req).map((k) => safeEqual(k, config.joinKey)).includes(true);
    if (ok) return;
    throw new HttpError(401, 'unauthorized', 'missing or invalid X-Coinvoo-Key');
  }
  if (isLoopback(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers.forwarded) return;
  throw new HttpError(401, 'unauthorized', 'loopback only');
}

// POST /api/join (internal, from the gate bots)
export function joinRoutes(deps) {
  const { db, config } = deps;
  async function handler({ req, res }) {
    authorize(req, config);
    const body = await readJson(req);

    if (typeof body.brand !== 'string' || body.brand.trim() === '') throw new HttpError(400, 'bad_params', 'brand is required');
    const tg = body.telegram_id;
    if (typeof tg !== 'number' || !Number.isSafeInteger(tg) || tg <= 0) {
      throw new HttpError(400, 'bad_params', 'telegram_id must be a positive integer');
    }
    const username = optStr(body, 'username', 128);
    const firstName = optStr(body, 'first_name', 256);
    const event = body.event === undefined || body.event === null ? 'join' : body.event;
    if (event !== 'join' && event !== 'leave') throw new HttpError(400, 'bad_params', 'event must be "join" or "leave"');
    let clickId = null;
    if (body.click_id !== undefined && body.click_id !== null) {
      if (typeof body.click_id !== 'string' || !TOKEN_RE.test(body.click_id)) {
        throw new HttpError(422, 'unknown_click', 'click_id is not a valid token');
      }
      clickId = body.click_id;
    }
    const brand = db.prepare('SELECT id, code FROM brands WHERE code = ? AND active = 1').get(body.brand.trim());
    if (!brand) throw new HttpError(422, 'unknown_brand', `no active brand "${body.brand}"`);

    // Phase 12: a leave is recorded on the member (never creates one), so the next join is known to be a rejoin.
    if (event === 'leave') {
      const m = db.prepare('SELECT id FROM members WHERE brand_id = ? AND telegram_id = ?').get(brand.id, tg);
      if (m) db.prepare('UPDATE members SET left_at = ?, last_seen_at = MAX(COALESCE(last_seen_at, 0), ?) WHERE id = ?').run(deps.now(), deps.now(), m.id);
      log.info('leave', { brand: brand.code, tg, known: !!m });
      return sendJson(res, 200, { ok: true, member_id: m ? m.id : null, left: !!m });
    }

    // Phase 12: a channel join request names the invite it used; the invite was made for one click. If that invite
    // was handed to several clicks (re-used while the bot was throttled), the newest click nobody has joined from
    // gets it; when every one of them already has its member, the join is recorded without a click.
    let invite = null;
    if (!clickId && body.invite_link !== undefined && body.invite_link !== null) {
      if (typeof body.invite_link !== 'string' || body.invite_link.length > 200) throw new HttpError(400, 'bad_params', 'invite_link must be a string');
      invite = body.invite_link.trim();
      const hit = db.prepare(
        `SELECT i.click_id FROM invites i
          WHERE i.brand_id = ? AND i.invite_link = ? AND NOT EXISTS (SELECT 1 FROM members m WHERE m.click_id = i.click_id)
          ORDER BY i.id DESC LIMIT 1`
      ).get(brand.id, invite);
      if (hit) clickId = hit.click_id;
    }
    const source = optStr(body, 'source', 64) || (clickId ? 'bot:start' : 'organic:bot');

    const r = recordJoin(db, { brandId: brand.id, telegramId: tg, username, firstName, clickId, source, capi: deps.capi, countRejoin: true, live: true });
    log.info('join', { brand: brand.code, tg, click: r.clickId, created: r.created, rejoin: r.rejoin, invite: invite ? (clickId ? 'matched' : 'unmatched') : null });
    // A join is the registration TikTok should optimise on, so it goes out with the same click id. Awaited:
    // a fire-and-forget send can be cut the moment the response closes.
    if (r.created || r.rejoin) {
      // CompleteRegistration is the accurate name; Subscribe is the one TikTok will let a sales ad set optimise on.
      await tiktokJoin(config, deps, db, r.clickId, `join:${brand.id}:${tg}`, req, 'CompleteRegistration');
      await tiktokJoin(config, deps, db, r.clickId, `join_sub:${brand.id}:${tg}`, req, 'Subscribe');
    }
    sendJson(res, 200, { ok: true, member_id: r.memberId, created: r.created, click_id: r.clickId, rejoin: r.rejoin });

    // Phase 2: the member is now known, so parked events that name them can be decided
    // immediately. After the response, never in the bot's path.
    setImmediate(() => {
      try {
        onMemberSeen(deps, { brandId: brand.id, memberId: r.memberId, telegramId: tg });
      } catch (e) {
        log.error('POST /api/join rematch', e);
      }
    });
  }

  // POST /api/join/batch — backfill of joins the feed missed. Same auth as /api/join. Each row goes through
  // recordJoin with now = joined_at, so a historical join keeps its real time; re-posting is a no-op for
  // joined_at (the upsert never rewrites it) and never duplicates a member.
  async function batch({ req, res }) {
    authorize(req, config);
    const body = await readBatchJson(req);
    if (!Array.isArray(body.joins)) throw new HttpError(400, 'bad_params', 'joins must be an array');
    if (body.joins.length > MAX_BATCH) throw new HttpError(400, 'too_many', `at most ${MAX_BATCH} joins per request, got ${body.joins.length}`);
    const brandCode = typeof body.brand === 'string' && body.brand.trim() ? body.brand.trim() : config.defaultBrand;
    const brand = db.prepare('SELECT id, code FROM brands WHERE code = ? AND active = 1').get(brandCode);
    if (!brand) throw new HttpError(422, 'unknown_brand', `no active brand "${brandCode}"`);

    const now = nowMs();
    let created = 0;
    let updated = 0;
    const errors = [];
    const seen = [];
    body.joins.forEach((row, index) => {
      try {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new HttpError(400, 'bad_params', 'row must be an object');
        const tg = row.telegram_id;
        if (typeof tg !== 'number' || !Number.isSafeInteger(tg) || tg <= 0) throw new HttpError(400, 'bad_params', 'telegram_id must be a positive integer');
        let at = now;
        if (row.joined_at !== undefined && row.joined_at !== null) {
          at = row.joined_at;
          if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < EARLIEST_JOIN_MS || at > now + 5 * 60000) {
            throw new HttpError(400, 'bad_params', 'joined_at must be epoch milliseconds, not in the future');
          }
        }
        let clickId = null;
        if (row.click_id !== undefined && row.click_id !== null) {
          if (typeof row.click_id !== 'string' || !TOKEN_RE.test(row.click_id)) throw new HttpError(422, 'unknown_click', 'click_id is not a valid token');
          clickId = row.click_id;
        }
        const source = optStr(row, 'join_source', 64) || optStr(row, 'source', 64) || 'backfill:batch';
        const r = recordJoin(db, { brandId: brand.id, telegramId: tg, username: optStr(row, 'username', 128), firstName: optStr(row, 'first_name', 256), clickId, source, now: at, capi: deps.capi, keepNames: true });
        if (r.created) created++; else updated++;
        seen.push({ memberId: r.memberId, telegramId: tg });
      } catch (e) {
        if (!(e instanceof HttpError)) log.error('POST /api/join/batch row', e);
        errors.push({ index, error: e instanceof HttpError ? e.message : 'internal error' });
      }
    });
    log.info('join batch', { brand: brand.code, rows: body.joins.length, created, updated, errors: errors.length });
    sendJson(res, 200, { ok: true, created, updated, errors });

    // As for a single join: parked events naming these members can now be decided. After the response.
    setImmediate(() => {
      for (const m of seen) {
        try { onMemberSeen(deps, { brandId: brand.id, ...m }); } catch (e) { log.error('POST /api/join/batch rematch', e); }
      }
    });
  }

  return [['POST', '/api/join', handler], ['POST', '/api/join/batch', batch]];
}
