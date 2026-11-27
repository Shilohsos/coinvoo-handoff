// Seed `members` from the bot snapshot and, optionally, a gate-bot `users` table.
//   node scripts/backfill-members.js [--snapshot <path>] [--gate-db <path>] [--dry-run]
// Both sources are opened READ-ONLY. Existing members are never touched (ON CONFLICT DO NOTHING),
// so it is safe to run repeatedly. Backfilled members have no click_id.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTx } from '../src/db.js';

function parseTime(v, fallback) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : fallback;
}

function seed(db, brandId, people, source, dryRun) {
  const exists = db.prepare('SELECT 1 AS x FROM members WHERE brand_id = ? AND telegram_id = ?');
  const ins = db.prepare(
    `INSERT INTO members (brand_id, telegram_id, username, first_name, joined_at, click_id, join_source, last_seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(brand_id, telegram_id) DO NOTHING`
  );
  const out = { source_rows: people.length, inserted: 0, already_present: 0 };
  for (const p of people) {
    if (exists.get(brandId, p.telegram_id)) { out.already_present++; continue; }
    if (dryRun) { out.inserted++; continue; }
    if (ins.run(brandId, p.telegram_id, p.username, p.first_name, p.joined_at, source, p.last_seen_at).changes === 1) out.inserted++;
    else out.already_present++;
  }
  return out;
}

export function backfillMembers(db, { snapshotPath = null, gateDbPath = null, brandCode = 'brand-one', dryRun = false, now = Date.now() }) {
  const brand = db.prepare('SELECT id FROM brands WHERE code = ?').get(brandCode);
  if (!brand) throw new Error(`unknown brand ${brandCode}`);
  const result = {};

  const run = () => {
    if (snapshotPath) {
      const snap = new DatabaseSync(snapshotPath, { readOnly: true });
      try {
        // user_accounts holds one row per broker account; collapse to one person per Telegram id.
        const rows = snap.prepare(
          `SELECT telegram_id, MAX(username) AS username, MIN(created_at) AS created_at
             FROM user_accounts WHERE telegram_id IS NOT NULL GROUP BY telegram_id ORDER BY telegram_id`
        ).all();
        result.botdb = seed(db, brand.id, rows.map((r) => ({
          telegram_id: Number(r.telegram_id), username: r.username || null, first_name: null,
          joined_at: parseTime(r.created_at, now), last_seen_at: null
        })), 'backfill:botdb', dryRun);
      } finally {
        snap.close();
      }
    }
    if (gateDbPath) {
      const gate = new DatabaseSync(gateDbPath, { readOnly: true });
      try {
        const rows = gate.prepare('SELECT telegram_id, first_name, username, joined_at, last_msg FROM users WHERE telegram_id IS NOT NULL ORDER BY telegram_id').all();
        result.gate = seed(db, brand.id, rows.map((r) => ({
          telegram_id: Number(r.telegram_id), username: r.username || null, first_name: r.first_name || null,
          joined_at: parseTime(r.joined_at, now), last_seen_at: r.last_msg ? parseTime(r.last_msg, null) : null
        })), 'backfill:gate', dryRun);
      } finally {
        gate.close();
      }
    }
  };
  if (dryRun) run(); else withTx(db, run);
  return result;
}

async function main() {
  const { loadConfig } = await import('../src/config.js');
  const { openDb, migrate } = await import('../src/db.js');
  const args = process.argv.slice(2);
  const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  let config;
  try { config = loadConfig(process.env); } catch (e) { console.error(`[coinvoo] FATAL config: ${e.message}`); process.exit(1); }
  const db = openDb(config.dbPath);
  migrate(db, { env: config.brandSeed });
  const dryRun = args.includes('--dry-run');
  try {
    const r = backfillMembers(db, {
      snapshotPath: val('--snapshot') || config.snapshotPath, gateDbPath: val('--gate-db'),
      brandCode: config.defaultBrand, dryRun
    });
    for (const [k, v] of Object.entries(r)) {
      console.log(`[coinvoo] backfill-members dry_run=${dryRun} source=${k} source_rows=${v.source_rows} inserted=${v.inserted} already_present=${v.already_present}`);
    }
  } catch (e) {
    console.error(`[coinvoo] backfill-members failed: ${e.message}`);
    process.exitCode = 1;
  }
  db.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
