// Shared test harness: in-memory database, real migrations, real HTTP server on an ephemeral port.
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/server.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Build a botdb-snapshot.db like the one the bot host ships.
export function makeSnapshot(rows, syncedAtIso = new Date().toISOString()) {
  const dir = mkdtempSync(join(tmpdir(), 'coinvoo-snap-'));
  const path = join(dir, 'botdb-snapshot.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE user_accounts (telegram_id INTEGER, iq_user_id TEXT, username TEXT, currency TEXT, approval_status TEXT, created_at TEXT);
           CREATE INDEX idx_ua_iq ON user_accounts(iq_user_id);
           CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  const ins = db.prepare('INSERT INTO user_accounts VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.telegram_id, r.iq_user_id, r.username ?? null, r.currency ?? 'USD', r.approval_status ?? 'approved', r.created_at ?? '2026-10-01T10:00:00Z');
  if (syncedAtIso) db.prepare("INSERT INTO meta VALUES ('synced_at', ?)").run(syncedAtIso);
  db.close();
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

export function testEnv(extra = {}) {
  return {
    DB_PATH: ':memory:',
    PUBLIC_BASE: 'https://coinvoo.example',
    ADMIN_USER: 'admin',
    ADMIN_PASS: 'pass',
    BRAND_ONE_BOT_USERNAME: 'coinvoo_test_bot',
    BRAND_TWO_BOT_USERNAME: 'coinvoo_echo_bot',
    BOTDB_SNAPSHOT: '/nonexistent/botdb-snapshot.db',
    // The backup is on by default (/var/backups/coinvoo); tests never write there. test/backup.test.js sets its own.
    BACKUP_DIR: 'off',
    ...extra
  };
}

export async function startApp(extraEnv = {}, opts = {}) {
  const config = loadConfig(testEnv(extraEnv));
  const db = openDb(':memory:');
  migrate(db, { env: config.brandSeed });
  const server = createApp({ config, db, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = 'Basic ' + Buffer.from('admin:pass').toString('base64');
  return {
    config, db, base, auth, deps: server.deps,
    async close() {
      server.deps.snapshot.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      db.close();
    },
    async mint(fields = { brand: 'brand-one', campaign: 'NG_Broad', adset: '18-34', ad: 'vid_03' }) {
      const r = await fetch(`${base}/api/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(fields)
      });
      return r.json();
    },
    // GET a postback with a query string built from an object.
    pb(params) {
      return fetch(`${base}/api/aff?${new URLSearchParams(params)}`).then((r) => r.json());
    },
    member(tgId, brand = 'brand-one') {
      const b = db.prepare('SELECT id FROM brands WHERE code = ?').get(brand);
      db.prepare("INSERT INTO members (brand_id, telegram_id, joined_at, join_source) VALUES (?, ?, ?, 'bot:start') ON CONFLICT DO NOTHING").run(b.id, tgId, Date.now());
      return db.prepare('SELECT id FROM members WHERE brand_id = ? AND telegram_id = ?').get(b.id, tgId).id;
    },
    join(body, headers = {}) {
      return fetch(`${base}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
      });
    }
  };
}

// docs/02-data-model.md §5 invariants. Every value must be 0.
// Invariant 5 is checked as the directive's lifecycle implies it: a confidence-0 attribution
// exists exactly for expired and ignored events (parked events have no attribution at all).
export function invariants(db) {
  const n = (sql) => db.prepare(sql).get().n;
  return {
    accounts_dupes: n('SELECT COUNT(*) AS n FROM (SELECT iq_user_id FROM accounts GROUP BY iq_user_id HAVING COUNT(*) > 1)'),
    matched_without_attribution: n(`SELECT COUNT(*) AS n FROM events e WHERE e.state = 'matched'
      AND (SELECT COUNT(*) FROM attributions a WHERE a.event_id = e.event_id AND a.confidence > 0) <> 1`),
    parked_with_attribution: n("SELECT COUNT(*) AS n FROM events e WHERE e.state = 'parked' AND EXISTS (SELECT 1 FROM attributions a WHERE a.event_id = e.event_id)"),
    parked_bad_forward: n("SELECT COUNT(*) AS n FROM events WHERE state = 'parked' AND forward_state NOT IN ('none', 'pending', 'sent')"),
    zero_confidence_mismatch: Math.abs(
      n('SELECT COUNT(*) AS n FROM attributions WHERE confidence = 0') -
      n("SELECT COUNT(*) AS n FROM events WHERE state IN ('expired', 'ignored')")),
    members_unknown_click: n('SELECT COUNT(*) AS n FROM members WHERE click_id IS NOT NULL AND click_id NOT IN (SELECT click_id FROM clicks)')
  };
}

export function allZero(obj) {
  return Object.values(obj).every((v) => v === 0);
}

// Capture [coinvoo] console output for the duration of fn.
export async function captureLogs(fn) {
  const lines = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(lines); } finally { console.log = ol; console.error = oe; }
  return lines;
}

// ---- dashboard fixtures (Phase 3) ----------------------------------------------------------
// Small, hand-checkable dataset: 6 members, 3 clicks, 9 events across matched/parked/expired/ignored.
// Times are relative to `now` so the default 7-day window always contains them.
export function seedDashFixture(db, now = Date.now()) {
  const H = 3600 * 1000;
  const brand = (code) => db.prepare('SELECT id FROM brands WHERE code = ?').get(code).id;
  const b10 = brand('brand-one');
  const bTwo = brand('brand-two');
  const click = db.prepare(`INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, creative, ttclid, fbclid, ip_hash, created_at, clicked_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  click.run('7K2M9QX4AB', b10, 'NG_Broad', '18-34', 'vid_03', 'v3', 'E.C.P.xxx', null, 'a'.repeat(32), now - 5 * H, now - 2 * H);
  click.run('C2C2C2C2C2', b10, 'NG_Retarget', '25-44', 'img_01', null, null, 'IwAR', 'b'.repeat(32), now - 5 * H, now - 90 * 60000);
  click.run('E3E3E3E3E3', bTwo, 'BrandTwoCamp', 'all', 'ad_9', null, null, null, 'c'.repeat(32), now - 5 * H, now - 3 * H);

  const mem = db.prepare(`INSERT INTO members (brand_id, telegram_id, username, first_name, joined_at, click_id, join_source, last_seen_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  mem.run(b10, 1001, 'xss_user', '<script>alert(1)</script>', now - 4 * H, '7K2M9QX4AB', 'bot:start', now - H);
  mem.run(b10, 1002, 'organic_ola', 'Ola', now - 3 * H, null, 'organic:bot', now - H);
  mem.run(b10, 1003, 'camp_chidi', 'Chidi', now - 2 * H, 'C2C2C2C2C2', 'bot:start', now - H);
  mem.run(b10, 1004, 'chan_ngozi', 'Ngozi', now - 2 * H, null, 'channel:-100123', now - H);
  mem.run(b10, 1005, 'back_femi', 'Femi', now - 20 * 24 * H, null, 'backfill:botdb', null);
  mem.run(bTwo, 2001, 'echo_tester', 'tester', now - H, 'E3E3E3E3E3', 'bot:start', now - 1000);
  const id = (tg) => db.prepare('SELECT id FROM members WHERE telegram_id = ?').get(tg).id;
  const acc = db.prepare("INSERT INTO accounts (member_id, iq_user_id, source, confidence, linked_at) VALUES (?, ?, 'postback', 90, ?)");
  acc.run(id(1001), '197000001', now - 3 * H);
  acc.run(id(1003), '197000003', now - 90 * 60000);
  acc.run(id(1005), '197000005', now - 10 * H);

  const ev = db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, country, click_id, aff_track,
                                             payload_json, received_at, state, ignore_reason, matched_member_id, matched_at, forward_state)
                         VALUES (?, ?, 'affstore', ?, ?, ?, ?, ?, 'NG', NULL, ?, ?, ?, ?, ?, ?, ?, 'skipped')`);
  const attr = db.prepare('INSERT INTO attributions (event_id, member_id, path, confidence, decided_at, note) VALUES (?, ?, ?, ?, ?, ?)');
  const alog = db.prepare('INSERT INTO attribution_log (event_id, candidate, reason, created_at) VALUES (?, ?, ?, ?)');
  const payload = (o) => JSON.stringify({ net: 'affstore', ip: '203.0.113.9', api_token: 'sekret-token', ...o });
  const E = (eid, status, kind, trader, amount, cur, aff, t, state, reason, mid) =>
    ev.run(eid, b10, status, kind, trader, amount, cur, aff, payload({ event_id: eid, status, trader_id: trader }), t, state, reason, mid, mid ? t : null);

  E('e1', 'ftd', 'ftd', '197000001', 100, 'USD', '1001', now - 3 * H, 'matched', null, id(1001)); attr.run('e1', id(1001), 'afftrack', 100, now - 3 * H, null);
  E('e2', 'dep', 'dep', '197000001', 50, 'USD', null, now - 2 * H, 'matched', null, id(1001)); attr.run('e2', id(1001), 'trader_id', 90, now - 2 * H, null);
  E('e3', 'ftd', 'ftd', '197000003', 200, 'USD', null, now - 90 * 60000, 'matched', null, id(1003)); attr.run('e3', id(1003), 'click', 85, now - 90 * 60000, null);
  E('e4', 'reg', 'reg', '197000003', null, 'USD', null, now - 100 * 60000, 'matched', null, id(1003)); attr.run('e4', id(1003), 'trader_id', 90, now - 100 * 60000, null);
  E('e5', 'dep', 'dep', '197999999', 25, 'USD', null, now - 30 * 60000, 'parked', null, null);
  alog.run('e5', null, 'parked:no_member', now - 30 * 60000);
  E('e6', 'ftd', 'ftd', '197888888', 70, 'USD', '9999999999', now - 20 * 60000, 'parked', null, null);
  alog.run('e6', '9999999999', 'afftrack_unknown', now - 20 * 60000); alog.run('e6', null, 'parked:no_member', now - 20 * 60000);
  E('e7', 'ftd', 'ftd', '197777777', 40, 'USD', null, now - 50 * H, 'expired', null, null); attr.run('e7', null, 'none', 0, now - 2 * H, 'expired');
  E('e8', 'ftd', 'ftd', '1', 100, 'USD', 'TEST-RECON-1', now - 10 * 60000, 'ignored', 'stub_guard', null); attr.run('e8', null, 'none', 0, now - 10 * 60000, 'stub_guard');
  E('e9', 'dep', 'dep', '197000005', 150000, 'NGN', null, now - 5 * H, 'matched', null, id(1005)); attr.run('e9', id(1005), 'trader_id', 90, now - 5 * H, null);
  db.prepare("UPDATE events SET forward_state = 'none' WHERE state = 'parked'").run(); // as the receiver leaves them
  syncOpens(db);
  return { b10, bTwo, id };
}

// Volume for the performance bar: n events and m members spread over 30 days.
export function seedBulk(db, { events = 5000, members = 3181, now = Date.now() } = {}) {
  const b10 = db.prepare("SELECT id FROM brands WHERE code = 'brand-one'").get().id;
  const insM = db.prepare("INSERT INTO members (brand_id, telegram_id, username, first_name, joined_at, join_source) VALUES (?, ?, ?, ?, ?, 'backfill:botdb')");
  const insE = db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, country, aff_track, payload_json,
                                               received_at, state, ignore_reason, matched_member_id, matched_at, forward_state)
                           VALUES (?, ?, 'affstore', ?, ?, ?, ?, 'USD', 'NG', NULL, ?, ?, ?, ?, ?, ?, 'skipped')`);
  const insA = db.prepare('INSERT INTO attributions (event_id, member_id, path, confidence, decided_at, note) VALUES (?, ?, ?, ?, ?, NULL)');
  db.exec('BEGIN');
  const ids = [];
  for (let i = 0; i < members; i++) ids.push(Number(insM.run(b10, 5_000_000 + i, `bulk_${i}`, `Bulk ${i}`, now - (i % 30) * 86400000).lastInsertRowid));
  const kinds = ['reg', 'ftd', 'dep', 'dep'];
  for (let i = 0; i < events; i++) {
    const r = i % 20;
    const state = r < 12 ? 'matched' : r < 16 ? 'parked' : r < 19 ? 'expired' : 'ignored';
    const kind = kinds[i % 4];
    const mid = state === 'matched' ? ids[(i * 7) % ids.length] : null;
    const t = now - Math.floor((i / events) * 29 * 86400000);
    const eid = `bulk-${i}`;
    insE.run(eid, b10, kind, kind, String(197500000 + i), kind === 'reg' ? null : 10 + (i % 90),
      JSON.stringify({ event_id: eid, status: kind, trader_id: String(197500000 + i), net: 'affstore', amount: 10 + (i % 90), country_code: 'NG' }),
      t, state, state === 'ignored' ? 'stub_guard' : null, mid, mid ? t : null);
    if (state === 'matched') insA.run(eid, mid, 'trader_id', 90, t);
    else if (state === 'expired' || state === 'ignored') insA.run(eid, null, 'none', 0, t);
  }
  db.exec("UPDATE events SET forward_state = 'none' WHERE state = 'parked'");
  db.exec('COMMIT');
}

// Fixtures that insert `clicks` rows by hand (with clicked_at) get the one open each such link implies,
// exactly as migration 005 backfills existing links. Idempotent: links that already have opens are skipped.
export function syncOpens(db) {
  db.prepare(`INSERT INTO click_opens (click_id, brand_id, opened_at, ip_hash, is_bot)
              SELECT c.click_id, c.brand_id, c.clicked_at, c.ip_hash, 0 FROM clicks c
               WHERE c.clicked_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM click_opens o WHERE o.click_id = c.click_id)`).run();
}
