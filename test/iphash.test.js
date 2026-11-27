import test from 'node:test';
import assert from 'node:assert/strict';
import { ipHash } from '../src/util.js';
import { startApp } from './helpers.js';

test('ip_hash: stable for the same ip + salt, 32 hex chars', () => {
  const a = ipHash('203.0.113.9', 'salt-one');
  assert.equal(a, ipHash('203.0.113.9', 'salt-one'));
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('ip_hash: differs across salts and across ips', () => {
  assert.notEqual(ipHash('203.0.113.9', 'salt-one'), ipHash('203.0.113.9', 'salt-two'));
  assert.notEqual(ipHash('203.0.113.9', 'salt-one'), ipHash('203.0.113.10', 'salt-one'));
});

test('ip_hash: the raw IP appears only in clicks.ip_raw (Phase 8), never in any other clicks column', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint();
    const r = await fetch(`${app.base}/c/${token}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'test-agent' }
    });
    assert.equal(r.status, 302);
    const row = app.db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(token);
    const salt = app.db.prepare("SELECT value FROM settings WHERE key='ip_salt'").get().value;
    assert.equal(row.ip_hash, ipHash('203.0.113.9', salt));
    assert.equal(row.ip_raw, '203.0.113.9', 'Phase 8: kept for Meta match quality, in this one column');
    for (const [k, v] of Object.entries(row)) {
      if (k === 'ip_raw') continue;
      if (typeof v === 'string') {
        assert.ok(!v.includes('203.0.113.9'), 'raw IP leaked into a clicks column');
        assert.ok(!v.includes('127.0.0.1'), 'raw peer IP leaked into a clicks column');
      }
    }
    assert.equal(salt.length, 64);
  } finally {
    await app.close();
  }
});
