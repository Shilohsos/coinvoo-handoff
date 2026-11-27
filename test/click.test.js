// Phase 8 Part E — the raw client IP is kept on the click (clicks.ip_raw) for Meta match quality, beside the hash,
// and is shown nowhere: not on the dashboard, in the CSV exports, in the read API, or in a log line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, captureLogs } from './helpers.js';

const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

test('E ip_raw = clientIp(req) on open, beside ip_hash; the response is unchanged', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint({ brand: 'brand-one', campaign: 'META_LAUNCH' });
    const r = await fetch(`${app.base}/c/${token}`, { redirect: 'manual', headers: { 'user-agent': CHROME, 'x-forwarded-for': '203.0.113.45' } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `https://t.me/coinvoo_test_bot?start=c_${token}`);
    const row = app.db.prepare('SELECT ip_raw, ip_hash FROM clicks WHERE click_id = ?').get(token);
    assert.equal(row.ip_raw, '203.0.113.45');
    assert.match(row.ip_hash, /^[0-9a-f]{32,64}$/);
    // no proxy header: the socket peer, exactly as clientIp reports it
    const { token: t2 } = await app.mint({ brand: 'brand-one', campaign: 'DIRECT' });
    await fetch(`${app.base}/c/${t2}`, { redirect: 'manual', headers: { 'user-agent': CHROME } });
    assert.equal(app.db.prepare('SELECT ip_raw FROM clicks WHERE click_id = ?').get(t2).ip_raw, '127.0.0.1');
    // a link never opened has no IP at all
    const { token: t3 } = await app.mint({ brand: 'brand-one', campaign: 'UNOPENED' });
    assert.equal(app.db.prepare('SELECT ip_raw FROM clicks WHERE click_id = ?').get(t3).ip_raw, null);
  } finally { await app.close(); }
});

test('E ip_raw appears in no dashboard page, CSV export, read/admin API response, or log line', async () => {
  const app = await startApp();
  try {
    const RAW = '198.51.100.201';
    const lines = await captureLogs(async () => {
      const { token } = await app.mint({ brand: 'brand-one', campaign: 'META_LAUNCH', adset: 'broad', ad: 'v1' });
      await fetch(`${app.base}/c/${token}?fbclid=IwAR0x`, { redirect: 'manual', headers: { 'user-agent': CHROME, 'x-forwarded-for': RAW } });
      await app.join({ brand: 'brand-one', telegram_id: 7000000001, click_id: token });
      await app.pb({ status: 'ftd', trader_id: '197000501', amount: '50', afftrack: '7000000001', event_id: 'ev-1' });
      const member = app.db.prepare('SELECT id FROM members WHERE telegram_id = 7000000001').get().id;
      const paths = ['/dash', '/dash/members', `/dash/members/${member}`, '/dash/events', '/dash/campaigns', '/dash/links',
        '/api/export/members.csv?period=all', '/api/export/events.csv?period=all', '/api/export/campaigns.csv?period=all',
        '/api/members', `/api/members/${member}`, '/api/events', '/api/events/ev-1', '/api/clicks', '/api/summary?period=7d',
        '/api/report/daily', '/api/member/7000000001', '/api/aff/stats', '/api/aff/health', '/api/health/ready'];
      for (const p of paths) {
        const res = await fetch(`${app.base}${p}`, { headers: { authorization: app.auth } });
        const body = await res.text();
        // Phase 10: a path that 404s proves nothing, so every path must actually answer.
        // (/api/health/ready is 503 here: the test environment has no bot snapshot. It still returns its body.)
        assert.ok((p === '/api/health/ready' ? [200, 503] : [200]).includes(res.status), `${p} answered ${res.status}`);
        assert.ok(!body.includes(RAW), `${p} shows the raw IP`);
        assert.ok(!/ip_raw/.test(body), `${p} names ip_raw`);
      }
    });
    assert.equal(app.db.prepare('SELECT ip_raw FROM clicks').get().ip_raw, RAW, 'it is stored');
    assert.ok(!lines.join('\n').includes(RAW), 'no log line carries it');
  } finally { await app.close(); }
});
