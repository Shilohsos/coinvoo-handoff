import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb, migrate, ensureIpSalt } from './db.js';
import { createRouter } from './router.js';
import { log } from './log.js';
import { clickRoutes } from './routes/click.js';
import { adLinkRoutes } from './routes/adlinks.js';
import { goRoutes } from './routes/go.js';
import { joinRoutes } from './routes/join.js';
import { linkRoutes } from './routes/links.js';
import { healthRoutes } from './routes/health.js';
import { postbackRoutes } from './routes/postback.js';
import { dashRoutes } from './routes/dash.js';
import { adminRoutes } from './routes/admin.js';
import { readApiRoutes } from './routes/readapi.js';
import { createSnapshot } from './botdb.js';
import { createForwarder } from './forward.js';
import { createCapi } from './capi.js';
import { createWorker } from './worker.js';
import { createSessionStore } from './session.js';
import { useSessions } from './auth.js';

// Build the HTTP server around an open, migrated database. No listening here.
// `now`, `fetchImpl` and `snapshot` are injectable so tests can mock the clock, the network
// and the bot snapshot. The server exposes its `deps` for the worker and for tests.
export function createApp({ config, db, now = Date.now, fetchImpl = globalThis.fetch, snapshot = null }) {
  const deps = {
    db, config, now, fetchImpl,
    salt: ensureIpSalt(db),
    startedAt: Date.now(),
    snapshot: snapshot || createSnapshot({ path: config.snapshotPath, now, staleMinutes: config.snapshotStaleMinutes }),
    workerState: { lastRunAt: null }
  };
  deps.forwarder = createForwarder(deps);
  deps.capi = createCapi(deps); // Phase 8: Meta Conversions API (inert unless META_CAPI_ENABLED=1)
  // Phase 11: dashboard sign-in sessions; requireAdmin accepts a live session cookie as well as basic auth.
  deps.sessions = createSessionStore(db, { config, now, salt: deps.salt });
  useSessions(config, deps.sessions);
  const router = createRouter();
  // adLinkRoutes before clickRoutes: both serve GET /c/:x and the router takes the first match. Ad-link routing hands
  // every click token and every unknown code to the /c/:token handler unchanged (src/routes/adlinks.js).
  for (const make of [adLinkRoutes, clickRoutes, goRoutes, joinRoutes, linkRoutes, healthRoutes, postbackRoutes, dashRoutes, adminRoutes, readApiRoutes]) {
    for (const [method, pattern, handler] of make(deps)) router.add(method, pattern, handler);
  }
  const server = http.createServer((req, res) => { router.dispatch(req, res); });
  server.deps = deps;
  return server;
}

export function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    console.error(`[coinvoo] FATAL config: ${e.message}`);
    process.exit(1);
  }

  const db = openDb(config.dbPath);
  log.info('boot', { version: config.version, db: config.dbPath });

  const m = migrate(db, { env: config.brandSeed });
  log.info('migrations', { applied: m.total, latest: m.latest, new: m.newlyApplied });

  const server = createApp({ config, db });
  // Never the token: only whether it is on, the dataset and the API version.
  if (config.meta.enabled) log.info('meta capi enabled', { dataset: config.meta.datasetId, version: config.meta.version });
  else log.info('meta capi disabled');
  const worker = createWorker(server.deps);
  server.listen(config.port, config.host, () => {
    log.info('listening', { port: server.address().port });
    worker.start();
  });

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    log.info('shutdown', { signal: sig });
    worker.stop();
    server.close(() => {
      server.deps.snapshot.close();
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    server.closeAllConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Last-resort guards: log and keep serving (CLAUDE.md §3.2).
  process.on('uncaughtException', (e) => log.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

  server.on('error', (e) => {
    console.error(`[coinvoo] FATAL listen: ${e.message}`);
    process.exit(1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
