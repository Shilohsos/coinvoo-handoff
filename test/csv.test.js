import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, seedBulk, testEnv, syncOpens } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
import { csvField, csvLine, isoLagos } from '../src/routes/export.js';

const H = 3600 * 1000;
const DAY = 24 * H;
const lagosDay = (ms) => new Date(ms + H).toISOString().slice(0, 10);

// RFC 4180 parser, written independently of the writer under test.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const records = (text) => { const [h, ...rest] = parseCsv(text); return rest.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };

async function csv(app, path, { auth = true } = {}) {
  syncOpens(app.db); // fixture links inserted by hand get the open they imply
  const r = await fetch(`${app.base}${path}`, { headers: auth ? { authorization: app.auth } : {} });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const post = (app, path, body) => fetch(`${app.base}${path}`, { method: 'POST', headers: { authorization: app.auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

function seed(app) {
  const db = app.db;
  const now = app.deps.now();
  db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES ('CSVLINK001', 1, 'NG_Broad', '18-34', 'vid_03', ?, ?)").run(now - 5 * H, now - H);
  const mem = db.prepare("INSERT INTO members (brand_id, telegram_id, username, first_name, joined_at, click_id, join_source) VALUES (?, ?, ?, ?, ?, ?, ?)");
  mem.run(1, 8001, 'doe', 'Doe, John', now - 2 * H, 'CSVLINK001', 'bot:start');
  mem.run(1, 8002, 'jj', 'Jane "JJ" Roe', now - 2 * H, null, 'organic:bot');
  mem.run(1, 8003, 'formula', '=HYPERLINK("http://evil.example","x")', now - 2 * H, null, 'channel:-100');
  mem.run(1, 8004, 'old', 'Old Timer', now - 40 * DAY, null, 'backfill:botdb');
  mem.run(1, 8005, null, 'Line\nBreak', now - 3 * H, null, 'organic:bot');
  db.prepare("INSERT INTO accounts (member_id, iq_user_id, source, confidence, linked_at) VALUES (1, '197300001', 'postback', 90, ?)").run(now);
  const id = (tg) => db.prepare('SELECT id FROM members WHERE telegram_id = ?').get(tg).id;
  const ev = db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, country, aff_track, payload_json, received_at, state, ignore_reason, matched_member_id, matched_at, forward_state)
                         VALUES (?, 1, 'affstore', ?, ?, ?, ?, ?, 'NG', ?, ?, ?, ?, ?, ?, ?, 'skipped')`);
  const secret = JSON.stringify({ ip: '203.0.113.9', api_token: 'sekret-token', ssid: 'S-123' });
  ev.run('c1', 'ftd', 'ftd', '197300001', 50, 'USD', '8001', secret, now - H, 'matched', null, id(8001), now - H);
  db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES ('c1', ?, 'afftrack', 100, ?)").run(id(8001), now);
  ev.run('c2', 'dep', 'dep', '197300001', 10, 'USD', null, secret, now - 30 * 60000, 'matched', null, id(8001), now);
  db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES ('c2', ?, 'trader_id', 90, ?)").run(id(8001), now);
  ev.run('c3', 'ftd', 'ftd', '197300555', 25, 'USD', null, secret, now - 20 * 60000, 'parked', null, null, null);
  ev.run('c4', 'ftd', 'ftd', '1', 100, 'USD', 'TEST-RECON-1', secret, now - 10 * 60000, 'ignored', 'stub_guard', null, null);
  ev.run('c5', 'dep', 'dep', '197300002', 150000, 'NGN', null, secret, now - 40 * DAY, 'expired', null, null, null);
  for (const id of ['c4', 'c5']) db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES (?, NULL, 'none', 0, ?)").run(id, now);
  db.prepare("UPDATE events SET forward_state = 'none' WHERE state = 'parked'").run();
}

test('csvField / csvLine: RFC 4180 quoting, doubled quotes, CRLF, formula guard, numbers and nulls', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('Doe, John'), '"Doe, John"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField('cr\rin'), '"cr\rin"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(''), '');
  assert.equal(csvField(0), '0');
  assert.equal(csvField(-5.5), '-5.5', 'a negative number is a number, not a formula');
  assert.equal(csvField(NaN), '');
  assert.equal(csvField('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvField('+1'), "'+1");
  assert.equal(csvField('@x'), "'@x");
  assert.equal(csvField('-x'), "'-x");
  assert.equal(csvLine(['a', 'b,c', 1]), 'a,"b,c",1\r\n');
  assert.equal(isoLagos(Date.parse('2026-11-15T17:29:05Z')), '2026-11-15T18:29:05+01:00');
  assert.equal(isoLagos(null), '');
});

test('headers: type, attachment filename, exact columns, CRLF, chunked (no content-length)', async () => {
  const app = await startApp();
  try {
    seed(app);
    const today = lagosDay(app.deps.now());
    const cols = {
      members: 'joined,telegram,username,first_name,source,broker_id,ftd,re_deposits,total,last_event,path,currency',
      events: 'event_id,received,kind,amount,currency,trader_id,afftrack,country,state,ignore_reason,path,confidence,member,username,note',
      campaigns: 'campaign,ad_set,ad,clicks,joins,clicks_per_join,ftds,revenue,spend,cost_per_ftd,roi,brand,currency'
    };
    for (const [kind, header] of Object.entries(cols)) {
      const r = await csv(app, `/api/export/${kind}.csv`);
      assert.equal(r.status, 200, kind);
      assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.equal(r.headers.get('content-disposition'), `attachment; filename="coinvoo-${kind}-${today}.csv"`);
      assert.equal(r.headers.get('content-length'), null, 'streamed, so no content-length');
      assert.equal(r.text.split('\r\n')[0], header, `${kind} header`);
      assert.ok(r.text.endsWith('\r\n'));
      assert.ok(!r.text.replace(/\r\n/g, '').includes('\n') || kind !== 'campaigns', 'rows end CRLF');
    }
  } finally { await app.close(); }
});

test('members.csv: quoting, formula guard, newline in a name, values, defaults to the last 30 days', async () => {
  const app = await startApp();
  try {
    seed(app);
    const r = await csv(app, '/api/export/members.csv');
    assert.ok(r.text.includes('"Doe, John"'), 'comma field is quoted');
    assert.ok(r.text.includes('"Jane ""JJ"" Roe"'), 'inner quotes are doubled');
    assert.ok(r.text.includes("\"'=HYPERLINK(\"\"http://evil.example\"\",\"\"x\"\")\""), 'formula-looking text is defused and still quoted');
    assert.ok(r.text.includes('"Line\nBreak"'));
    const recs = records(r.text);
    const by = Object.fromEntries(recs.map((x) => [x.telegram, x]));
    assert.equal(by['8001'].first_name, 'Doe, John');
    assert.equal(by['8002'].first_name, 'Jane "JJ" Roe');
    assert.equal(by['8003'].first_name, "'=HYPERLINK(\"http://evil.example\",\"x\")");
    assert.equal(by['8005'].first_name, 'Line\nBreak', 'a newline stays inside one field');
    assert.equal(recs.length, 4, 'one record per member joined in the last 30 days (the 40-day-old member is out)');
    assert.ok(!('8004' in by));
    // values
    assert.deepEqual([by['8001'].ftd, by['8001'].re_deposits, by['8001'].total, by['8001'].path, by['8001'].currency], ['50', '10', '60', 'afftrack', 'USD']);
    assert.equal(by['8002'].path, '', 'no matched events: no path');
    assert.equal(by['8001'].source, 'NG_Broad / vid_03');
    assert.equal(by['8001'].broker_id, '197300001');
    assert.equal(by['8002'].ftd, '', 'no deposits: empty, not 0');
    assert.match(by['8001'].joined, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+01:00$/);
    // period=all includes the old one; explicit ranges and filters
    assert.equal(records((await csv(app, '/api/export/members.csv?period=all')).text).length, 5);
    assert.equal(records((await csv(app, '/api/export/members.csv?period=today')).text).length, 4);
    assert.equal(records((await csv(app, '/api/export/members.csv?ftd=has&period=all')).text).length, 1);
    assert.equal(records((await csv(app, '/api/export/members.csv?brand=brand-two&period=all')).text).length, 0);
    const d = lagosDay(app.deps.now() - 40 * DAY);
    assert.equal(records((await csv(app, `/api/export/members.csv?from=${d}&to=${d}`)).text).length, 1);
  } finally { await app.close(); }
});

test('events.csv: a note containing newlines, commas and quotes stays one field; no payload, IP, ssid or token anywhere', async () => {
  const app = await startApp();
  try {
    seed(app);
    const note = 'confirmed in DM\nline two, with "quotes"';
    const mid = app.db.prepare('SELECT id FROM members WHERE telegram_id = 8002').get().id;
    const a = await post(app, '/api/events/c3/attach', { member_id: mid, note });
    assert.equal(a.status, 200);
    const r = await csv(app, '/api/export/events.csv?period=7d');
    const recs = records(r.text);
    const by = Object.fromEntries(recs.map((x) => [x.event_id, x]));
    assert.equal(by.c3.note, note, 'the whole note survives in one field');
    assert.equal(by.c3.path, 'manual');
    assert.equal(by.c3.confidence, '100');
    assert.equal(by.c3.member, '8002');
    assert.equal(recs.length, 4, 'c5 (40 days old) is outside the default window');
    assert.equal(parseCsv(r.text).length, 5, 'header + 4 records: the embedded newlines did not split rows');
    assert.deepEqual([by.c1.kind, by.c1.amount, by.c1.currency, by.c1.state, by.c1.path, by.c1.afftrack, by.c1.country], ['ftd', '50', 'USD', 'matched', 'afftrack', '8001', 'NG']);
    assert.deepEqual([by.c4.state, by.c4.ignore_reason, by.c4.path], ['ignored', 'stub_guard', 'none'], 'ignored events stay visible');
    for (const kind of ['members', 'events', 'campaigns']) {
      const t = (await csv(app, `/api/export/${kind}.csv?period=all`)).text;
      for (const bad of ['203.0.113.9', 'sekret-token', 'S-123', 'payload', 'ip_hash', 'ssid', 'api_token']) assert.ok(!t.includes(bad), `${kind} leaks ${bad}`);
    }
    // filters pass through
    assert.equal(records((await csv(app, '/api/export/events.csv?period=all&state=expired')).text).length, 1);
    assert.equal(records((await csv(app, '/api/export/events.csv?period=all&kind=dep')).text).length, 2);
    assert.equal(records((await csv(app, '/api/export/events.csv?period=all&q=197300001')).text).length, 2);
    assert.equal((await csv(app, '/api/export/events.csv?state=bogus')).status, 400, 'a bad filter is a JSON 400 before any CSV is started');
  } finally { await app.close(); }
});

test('row counts equal the dashboard counts (members, events, campaigns)', async () => {
  const app = await startApp();
  try {
    seed(app);
    const now = app.deps.now();
    const from = lagosDay(now - 6 * DAY);
    const to = lagosDay(now);
    const j = async (p) => JSON.parse((await csv(app, p)).text);
    const mem = await j(`/api/members?from=${from}&to=${to}&limit=200`);
    assert.equal(records((await csv(app, `/api/export/members.csv?from=${from}&to=${to}`)).text).length, mem.total);
    const evs = await j(`/api/events?from=${from}&to=${to}&limit=200`);
    assert.equal(records((await csv(app, `/api/export/events.csv?from=${from}&to=${to}`)).text).length, evs.total);
    const page = (await csv(app, `/dash/campaigns?from=${from}&to=${to}`)).text;
    const screenRows = (page.match(/<tr data-row="/g) || []).length - 1; // minus the totals row
    assert.equal(records((await csv(app, `/api/export/campaigns.csv?from=${from}&to=${to}`)).text).length, screenRows);
    assert.ok(screenRows >= 2);
    // the HTML members page agrees with the same filter
    const html = (await csv(app, `/dash/members?from=${from}&to=${to}`)).text;
    assert.match(html, new RegExp(`${mem.total} found`));
  } finally { await app.close(); }
});

test('campaigns.csv: the (none) row, blanks for not-computable cells, rounded ratios, no totals row', async () => {
  const app = await startApp();
  try {
    const now = app.deps.now();
    const click = app.db.prepare('INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES (?, 1, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= 3; i++) click.run(`CA${i}`.padEnd(10, '0'), 'NG_A', 'a1', 'ad_a', now - H, now - H);
    click.run('CN1'.padEnd(10, '0'), null, null, null, now - H, now - H);
    app.db.prepare("INSERT INTO members (brand_id, telegram_id, joined_at, click_id, join_source) VALUES (1, 9100, ?, ?, 'bot:start')").run(now - H, 'CA1'.padEnd(10, '0'));
    app.db.prepare("INSERT INTO members (brand_id, telegram_id, joined_at, click_id, join_source) VALUES (1, 9101, ?, ?, 'bot:start')").run(now - H, 'CA2'.padEnd(10, '0'));
    app.db.prepare("INSERT INTO members (brand_id, telegram_id, joined_at, click_id, join_source) VALUES (1, 9102, ?, ?, 'bot:start')").run(now - H, 'CA3'.padEnd(10, '0'));
    const recs = records((await csv(app, '/api/export/campaigns.csv?period=7d&brand=brand-one')).text);
    assert.equal(recs.length, 2);
    const a = recs.find((r) => r.campaign === 'NG_A');
    assert.deepEqual([a.ad_set, a.ad, a.clicks, a.joins, a.clicks_per_join, a.ftds, a.revenue, a.spend, a.cost_per_ftd, a.roi, a.brand, a.currency],
      ['a1', 'ad_a', '3', '3', '1', '0', '0', '', '', '', 'brand-one', 'USD']);
    const n = recs.find((r) => r.campaign === '(none)');
    assert.deepEqual([n.clicks, n.joins, n.clicks_per_join, n.ad_set, n.ad], ['1', '0', '', '', '']);
    assert.ok(!recs.some((r) => r.campaign === 'Total'));
    await post(app, '/api/spend', { brand: 'brand-one', day: lagosDay(now), campaign: 'NG_A', adset: 'a1', ad: 'ad_a', spend: 100 });
    const a2 = records((await csv(app, '/api/export/campaigns.csv?period=7d&brand=brand-one')).text).find((r) => r.campaign === 'NG_A');
    assert.deepEqual([a2.spend, a2.roi, a2.cost_per_ftd], ['100', '-100', ''], 'spend 100, revenue 0: ROI -100; no FTDs: blank');
  } finally { await app.close(); }
});

test('exports need credentials and reject bad periods before streaming', async () => {
  const app = await startApp();
  try {
    for (const k of ['members', 'events', 'campaigns']) {
      assert.equal((await csv(app, `/api/export/${k}.csv`, { auth: false })).status, 401);
      assert.equal((await csv(app, `/api/export/${k}.csv?period=1y`)).status, 400);
      assert.equal((await csv(app, `/api/export/${k}.csv?brand=nope`)).status, 400);
      assert.equal((await csv(app, `/api/export/${k}.csv?from=2026-13-01&to=2026-13-02`)).status, 400);
    }
    const bad = await csv(app, '/api/export/members.csv?period=1y');
    assert.match(bad.headers.get('content-type'), /application\/json/);
  } finally { await app.close(); }
});

test('streaming: a 5,000-row export is chunked and the server process peaks well under 150 MB RSS', { skip: !existsSync('/proc/self/status') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinvoo-stream-'));
  const dbPath = join(dir, 'stream.db');
  const cfg = loadConfig(testEnv({ DB_PATH: dbPath }));
  const db = openDb(dbPath);
  migrate(db, { env: cfg.brandSeed });
  seedBulk(db, { events: 5000, members: 5000 });
  db.close();

  const child = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { PATH: process.env.PATH, DB_PATH: dbPath, PORT: '0', PUBLIC_BASE: 'https://coinvoo.example', ADMIN_USER: 'admin', ADMIN_PASS: 'pass',
      BRAND_ONE_BOT_USERNAME: 'test_bot', BOTDB_SNAPSHOT: '/nonexistent/snap.db', BACKUP_DIR: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 8000);
      child.stdout.on('data', (d) => { buf += d; const m = /listening port=(\d+)/.exec(buf); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.on('exit', (c) => reject(new Error(`server exited ${c}: ${buf}`)));
    });
    const hwm = () => Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))[1]) / 1024;
    const before = hwm();
    const auth = 'Basic ' + Buffer.from('admin:pass').toString('base64');

    const fetchStream = (path) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, headers: { authorization: auth } }, (res) => {
        let chunks = 0; let bytes = 0; let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks++; bytes += c.length; text += c; });
        res.on('end', () => resolve({ headers: res.headers, chunks, bytes, rows: text.split('\r\n').length - 2, status: res.statusCode }));
        res.on('error', reject);
      }).on('error', reject);
    });

    const out = {};
    for (const kind of ['members', 'events']) {
      const r = await fetchStream(`/api/export/${kind}.csv?period=all`);
      assert.equal(r.status, 200);
      assert.equal(r.headers['transfer-encoding'], 'chunked', `${kind}: streamed`);
      assert.equal(r.headers['content-length'], undefined);
      assert.ok(r.chunks > 1, `${kind}: delivered in several chunks (${r.chunks})`);
      assert.equal(r.rows, 5000, `${kind}: 5,000 rows`);
      out[kind] = { chunks: r.chunks, kb: Math.round(r.bytes / 1024) };
    }
    const peak = hwm();
    console.log(`# stream rss_before=${before.toFixed(0)}MB peak=${peak.toFixed(0)}MB growth=${(peak - before).toFixed(0)}MB members=${JSON.stringify(out.members)} events=${JSON.stringify(out.events)}`);
    assert.ok(peak < 150, `peak RSS ${peak.toFixed(0)} MB`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
});
