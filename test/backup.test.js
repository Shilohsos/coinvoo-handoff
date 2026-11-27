import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp, seedDashFixture, captureLogs } from './helpers.js';
import { createWorker } from '../src/worker.js';
import { loadReportConfig } from '../src/report.js';

const AT_0305 = Date.parse('2026-11-15T02:05:00Z'); // 03:05 Lagos

async function backupApp(env, now = AT_0305) {
  const clock = { now };
  const app = await startApp(env, { now: () => clock.now });
  seedDashFixture(app.db, now);
  app.deps.reportConfig = loadReportConfig({});
  return { app, clock, worker: createWorker(app.deps) };
}

test('backup: the daily maintenance writes a consistent copy that opens and holds the same rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinvoo-bk-'));
  const { app, worker } = await backupApp({ BACKUP_DIR: join(dir, 'nightly') }); // created if missing
  try {
    const lines = await captureLogs(async () => { await worker.tick(); await worker.flush(); });
    const files = readdirSync(join(dir, 'nightly'));
    assert.deepEqual(files, ['coinvoo-2026-11-15.db']);
    const copy = new DatabaseSync(join(dir, 'nightly', files[0]), { readOnly: true });
    for (const t of ['members', 'events', 'attributions', 'clicks', 'click_opens', 'settings']) {
      assert.equal(copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, app.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, t);
    }
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    copy.close();
    assert.ok(lines.some((l) => /^\[coinvoo\] backup file=coinvoo-2026-11-15\.db bytes=\d+ kept=1 removed=0$/.test(l)), lines.join('|'));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backup: keeps the newest BACKUP_KEEP copies, deletes older ones, never touches other files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinvoo-bk-'));
  for (let d = 1; d <= 16; d++) writeFileSync(join(dir, `coinvoo-2026-10-${String(d).padStart(2, '0')}.db`), 'old');
  writeFileSync(join(dir, 'notes.txt'), 'keep me');
  writeFileSync(join(dir, 'coinvoo-manual.db'), 'keep me too');
  const { app, worker } = await backupApp({ BACKUP_DIR: dir, BACKUP_KEEP: '3' });
  try {
    await worker.tick(); await worker.flush();
    assert.deepEqual(readdirSync(dir).sort(), ['coinvoo-2026-10-15.db', 'coinvoo-2026-10-16.db', 'coinvoo-2026-11-15.db', 'coinvoo-manual.db', 'notes.txt']);
    assert.equal(worker.lastMaintenance.backup.removed, 14, '16 old + today = 17 files, keep 3');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backup: once a day; an existing file for the day is not overwritten; off only with BACKUP_DIR=off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinvoo-bk-'));
  writeFileSync(join(dir, 'coinvoo-2026-11-15.db'), 'already there');
  const { app, clock, worker } = await backupApp({ BACKUP_DIR: dir });
  try {
    const lines = await captureLogs(async () => { await worker.tick(); await worker.flush(); });
    assert.ok(lines.some((l) => l.includes('backup skipped file=coinvoo-2026-11-15.db reason=exists')));
    clock.now += 3600000;
    await worker.tick(); await worker.flush();
    assert.deepEqual(readdirSync(dir), ['coinvoo-2026-11-15.db'], 'maintenance runs once a day');
    clock.now += 24 * 3600000;
    await worker.tick(); await worker.flush();
    assert.deepEqual(readdirSync(dir).sort(), ['coinvoo-2026-11-15.db', 'coinvoo-2026-11-16.db']);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }

  const off = await backupApp({ BACKUP_DIR: 'off' });
  try {
    const lines = await captureLogs(async () => { off.worker.start(); await off.worker.tick(); await off.worker.flush(); off.worker.stop(); });
    assert.ok(lines.includes('[coinvoo] backup disabled BACKUP_DIR=off'));
    assert.equal(off.worker.lastMaintenance.backup, null);
  } finally { await off.app.close(); }
});

test('backup: a failure is logged, never thrown, and the rest of the maintenance still happens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinvoo-bk-'));
  const notADir = join(dir, 'a-file');
  writeFileSync(notADir, 'x');
  const { app, worker } = await backupApp({ BACKUP_DIR: notADir });
  try {
    const lines = await captureLogs(async () => { await worker.tick(); await worker.flush(); });
    assert.ok(lines.some((l) => l.startsWith('[coinvoo] ERROR backup:')), 'logged');
    assert.ok(lines.some((l) => l.startsWith('[coinvoo] maintenance day=2026-11-15')), 'prune and rollup still ran');
    assert.ok(worker.lastMaintenance.backup.error);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
