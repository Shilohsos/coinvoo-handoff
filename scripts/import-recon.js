// Idempotent import of the legacy postback store into `events`.
//   node scripts/import-recon.js [--recon /srv/aff-recon/recon.db] [--dry-run]
// recon.db is opened READ-ONLY and never written. Needs the service environment (DB_PATH, ...).
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_MAP, classify } from '../src/routes/postback.js';
import { withTx } from '../src/db.js';

const TG_RE = /^\d{1,15}$/;

// recon.db stores epoch seconds (REAL); accept milliseconds too.
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n > 1e11 ? n : n * 1000);
}

function str(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// Decide what one recon row becomes. Pure given the member lookup.
export function mapRow(row, findMember, importedAt) {
  const status = str(row.status);
  const trader = str(row.trader_id);
  const aff = str(row.afftrack_in);
  const clickid = str(row.clickid);
  const tg = str(row.tg_id);
  const amount = row.amount === null || row.amount === undefined ? null : Number(row.amount);
  const cls = classify({ status: status || '', trader_id: trader, aff_track: aff, click_id: clickid, amount: amount === null ? null : amount });
  const received = toMs(row.created_at) ?? importedAt;
  const matchedAt = toMs(row.matched_at);

  let state, reason = null, memberId = null, path = 'none', confidence = 0;
  if (!KIND_MAP[String(status || '').toLowerCase()]) {
    state = 'ignored'; reason = 'bad_kind';
  } else if (cls.reason === 'stub_guard') {
    // History is held to the same guard as live traffic: a fake deposit must not become revenue.
    state = 'ignored'; reason = 'stub_guard';
  } else {
    const rs = String(row.state || '').toLowerCase();
    if (rs === 'sent') {
      const m = tg && TG_RE.test(tg) ? findMember(Number(tg)) : null;
      if (m) {
        state = 'matched'; memberId = m.id;
        path = aff === tg ? 'afftrack' : 'trader_id';
        confidence = path === 'afftrack' ? 100 : 90;
      } else {
        // `matched` needs a member row. With none here, park it and let the matcher decide
        // when one appears (the worker expires it if it is old).
        state = tg ? 'parked' : 'expired';
      }
    } else if (rs === 'failed') {
      state = 'expired';
    } else {
      state = 'parked'; // pending | held | anything unrecognised
    }
  }

  return {
    state, reason, memberId, path, confidence, received, matchedAt,
    kind: KIND_MAP[String(status || '').toLowerCase()] || 'ignored',
    // History is not re-forwarded: aff-recon owns what it already sent. An unsent row that is
    // still parked stays 'none' (docs/02 §5.4), so if it expires unattributed the normal
    // 48 h policy forwards it; unsent matched/expired/ignored history is 'skipped'.
    forward_state: row.sent_at ? 'sent' : (state === 'parked' ? 'none' : 'skipped'),
    status, trader, aff, clickid, amount
  };
}

export function importRecon(db, { reconPath, dryRun = false, brandCode = 'brand-one', now = Date.now() }) {
  const brand = db.prepare('SELECT id FROM brands WHERE code = ?').get(brandCode);
  if (!brand) throw new Error(`unknown brand ${brandCode}`);
  const recon = new DatabaseSync(reconPath, { readOnly: true });
  const counts = { source_rows: 0, inserted: 0, already_present: 0, by_state: { matched: 0, parked: 0, expired: 0, ignored: 0 } };
  try {
    const rows = recon.prepare('SELECT * FROM events ORDER BY created_at, event_id').all();
    counts.source_rows = rows.length;
    const findMember = (tg) => db.prepare('SELECT id FROM members WHERE brand_id = ? AND telegram_id = ?').get(brand.id, tg);
    const exists = db.prepare('SELECT 1 AS x FROM events WHERE event_id = ?');
    const insEv = db.prepare(
      `INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, country, click_id, aff_track,
                           payload_json, received_at, state, ignore_reason, matched_member_id, matched_at,
                           forward_state, forward_tries, forward_resp)
       VALUES (?, ?, 'affstore', ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`
    );
    const insAttr = db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at, note) VALUES (?, ?, ?, ?, ?, 'imported:recon') ON CONFLICT(event_id) DO NOTHING");

    const run = () => {
      for (const row of rows) {
        const id = str(row.event_id);
        if (!id) continue;
        const already = !!exists.get(id);
        const m = mapRow(row, findMember, now);
        if (already) { counts.already_present++; continue; }
        counts.by_state[m.state]++;
        if (dryRun) continue;
        const r = insEv.run(id, brand.id, m.status || '', m.kind, m.trader, m.amount, str(row.country), m.clickid, m.aff,
          JSON.stringify({ imported_from: 'recon.db', ...row }), m.received, m.state, m.reason, m.memberId, m.matchedAt,
          m.forward_state, Number(row.tries) || 0, row.resp === null || row.resp === undefined ? null : String(row.resp).slice(0, 500));
        if (r.changes === 1) {
          counts.inserted++;
          if (m.state === 'matched') insAttr.run(id, m.memberId, m.path, m.confidence, m.matchedAt ?? m.received);
          else if (m.state === 'ignored' || m.state === 'expired') insAttr.run(id, null, 'none', 0, m.received);
        }
      }
    };
    if (dryRun) run(); else withTx(db, run);
  } finally {
    recon.close();
  }
  if (dryRun) counts.would_insert = counts.by_state.matched + counts.by_state.parked + counts.by_state.expired + counts.by_state.ignored;
  return counts;
}

async function main() {
  const { loadConfig } = await import('../src/config.js');
  const { openDb, migrate } = await import('../src/db.js');
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const i = args.indexOf('--recon');
  const reconPath = i >= 0 ? args[i + 1] : '/srv/aff-recon/recon.db';
  let config;
  try { config = loadConfig(process.env); } catch (e) { console.error(`[coinvoo] FATAL config: ${e.message}`); process.exit(1); }
  const db = openDb(config.dbPath);
  migrate(db, { env: config.brandSeed });
  try {
    const c = importRecon(db, { reconPath, dryRun, brandCode: config.defaultBrand });
    console.log(`[coinvoo] import-recon dry_run=${dryRun} source_rows=${c.source_rows} inserted=${c.inserted} already_present=${c.already_present}`
      + ` matched=${c.by_state.matched} parked=${c.by_state.parked} expired=${c.by_state.expired} ignored=${c.by_state.ignored}`);
  } catch (e) {
    console.error(`[coinvoo] import-recon failed: ${e.message}`);
    process.exitCode = 1;
  }
  db.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
