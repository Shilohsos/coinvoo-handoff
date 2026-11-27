// Manual repair: re-run the matcher for one trader_id or one event_id.
//   node scripts/rematch.js <trader_id|event_id>
// Only `new` and `parked` events are eligible (an expired event was already forwarded unattributed).
// Forwarding is left to the service's worker: a matched event is marked pending and the next tick sends it.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchEvent } from '../src/matcher.js';

export function rematch(deps, key) {
  const ids = deps.db.prepare(
    "SELECT event_id FROM events WHERE state IN ('new', 'parked') AND (event_id = ? OR trader_id = ?) ORDER BY received_at"
  ).all(key, key).map((r) => r.event_id);
  const out = { considered: ids.length, matched: 0, parked: 0 };
  for (const id of ids) {
    const r = matchEvent(deps, id);
    if (r && r.state === 'matched') out.matched++;
    else if (r) out.parked++;
  }
  return out;
}

async function main() {
  const { loadConfig } = await import('../src/config.js');
  const { openDb, migrate } = await import('../src/db.js');
  const { createSnapshot } = await import('../src/botdb.js');
  const key = process.argv[2];
  if (!key) { console.error('usage: node scripts/rematch.js <trader_id|event_id>'); process.exit(2); }
  let config;
  try { config = loadConfig(process.env); } catch (e) { console.error(`[coinvoo] FATAL config: ${e.message}`); process.exit(1); }
  const db = openDb(config.dbPath);
  migrate(db, { env: config.brandSeed });
  const snapshot = createSnapshot({ path: config.snapshotPath });
  const r = rematch({ db, config, now: Date.now, snapshot, forwarder: null }, key);
  console.log(`[coinvoo] rematch key=${key} considered=${r.considered} matched=${r.matched} parked=${r.parked}`);
  snapshot.close();
  db.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
