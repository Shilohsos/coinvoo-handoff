// env -> frozen config. Fail fast, naming every missing variable at once.

export const VERSION = '1.0.0';
export const DEFAULT_BACKUP_DIR = '/srv/coinvoo/backups'; // Phase 7 Part C

export function loadConfig(env = process.env) {
  const missing = [];
  const need = (name) => {
    const v = env[name];
    if (v === undefined || String(v).trim() === '') {
      missing.push(name);
      return '';
    }
    return String(v).trim();
  };

  const dbPath = need('DB_PATH');
  const publicBase = need('PUBLIC_BASE');
  const adminUser = need('ADMIN_USER');
  const adminPass = need('ADMIN_PASS');
  // The brand-one gate bot is the launch brand; brand-two is seeded only when its bot is configured.
  need('BRAND_ONE_BOT_USERNAME');

  const errors = [];
  if (missing.length) errors.push(`missing required environment variable(s): ${missing.join(', ')}`);

  const port = env.PORT === undefined || env.PORT === '' ? 8770 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push(`PORT must be an integer 0-65535, got "${env.PORT}"`);

  if (publicBase && !/^https?:\/\/[^\s/]+/.test(publicBase)) errors.push('PUBLIC_BASE must start with http:// or https://');

  // Brand seed values reach migration 002 as bound parameters; only BRAND_* names are exposed.
  const brandSeed = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^BRAND_[A-Z0-9_]+$/.test(k)) brandSeed[k] = v;
  }

  const intEnv = (name, dflt, min) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) errors.push(`${name} must be a number >= ${min}, got "${raw}"`);
    return n;
  };
  // An unmatched event waits a week before it expires: a registration can take days to reach the bot, and the
  // join is what makes the deposit attributable. PARK_HOURS overrides it.
  const parkHours = intEnv('PARK_HOURS', 168, 0.001);
  const workerIntervalMs = intEnv('WORKER_INTERVAL_MS', 60000, 10);
  // docs/05 §9: postbacks beyond this many per second from one IP get 429. 0 switches the limit off.
  const affRatePerSec = intEnv('AFF_RATE_LIMIT_PER_SEC', 100, 0);
  // Phase 9: GET /go/<brand> visits per second from one IP before 429. 0 switches the limit off.
  const goRatePerSec = intEnv('GO_RATE_PER_SEC', 20, 0);
  // Phase 10: the shared secret Affstore appends to the postback URL (?key=...). Unset = every postback is
  // accepted, exactly as before. AFF_KEY_ENFORCE=0 checks and counts the key but still accepts (rollout mode).
  const affKey = env.AFF_KEY !== undefined && String(env.AFF_KEY).trim() !== '' ? String(env.AFF_KEY).trim() : null;
  if (affKey && (affKey.length < 16 || /\s/.test(affKey))) errors.push('AFF_KEY must be at least 16 characters, with no spaces');
  const enforceRaw = env.AFF_KEY_ENFORCE === undefined ? '' : String(env.AFF_KEY_ENFORCE).trim();
  if (!['', '0', '1'].includes(enforceRaw)) errors.push(`AFF_KEY_ENFORCE must be 0 or 1, got "${env.AFF_KEY_ENFORCE}"`);
  const affKeyEnforce = !!affKey && enforceRaw !== '0';
  // Phase 10: clicks.ip_raw is kept only for Meta matching; after this many days it is blanked. 0 = keep forever.
  const ipRawRetentionDays = intEnv('IP_RAW_RETENTION_DAYS', 90, 0);
  // Phase 12: the gate bot's local invite endpoint (POST {GATE_BOT_API}/invite) and the secret it checks. Unset = no
  // per-click invites; /c/<code> falls back to the newest stored invite, then to the brand's invite link.
  const gateBotApi = env.GATE_BOT_API !== undefined && String(env.GATE_BOT_API).trim() !== '' ? String(env.GATE_BOT_API).trim().replace(/\/+$/, '') : null;
  const gateSecret = env.GATE_SHARED_SECRET !== undefined && String(env.GATE_SHARED_SECRET).trim() !== '' ? String(env.GATE_SHARED_SECRET).trim() : null;
  if (gateBotApi && !/^https?:\/\/[^\s/]+/.test(gateBotApi)) errors.push('GATE_BOT_API must start with http:// or https://');
  if (gateBotApi && !gateSecret) errors.push('GATE_BOT_API requires GATE_SHARED_SECRET');
  if (gateSecret && (gateSecret.length < 16 || /\s/.test(gateSecret))) errors.push('GATE_SHARED_SECRET must be at least 16 characters, with no spaces');
  const gateBotTimeoutMs = intEnv('GATE_BOT_TIMEOUT_MS', 3000, 50);
  // Nightly backup into this directory (docs/07 §6), on by default. BACKUP_DIR=off is the only way to
  // switch it off (the test suite does). Keeps the newest BACKUP_KEEP files.
  const backupRaw = env.BACKUP_DIR && String(env.BACKUP_DIR).trim() ? String(env.BACKUP_DIR).trim() : DEFAULT_BACKUP_DIR;
  const backupDir = backupRaw.toLowerCase() === 'off' ? null : backupRaw;
  const backupKeep = intEnv('BACKUP_KEEP', 14, 1);
  // The bot snapshot counts as stale (health, alert, Overview strip) when older than this.
  // SNAPSHOT_STALE_MIN is the Phase 7 name; SNAPSHOT_STALE_MINUTES (Phase 6) is still read when it is unset.
  const staleVar = env.SNAPSHOT_STALE_MIN !== undefined && String(env.SNAPSHOT_STALE_MIN).trim() !== '' ? 'SNAPSHOT_STALE_MIN' : 'SNAPSHOT_STALE_MINUTES';
  const snapshotStaleMinutes = intEnv(staleVar, 30, 1);

  let backoffMin = [1, 2, 4, 8, 15, 30, 60];
  if (env.FORWARD_BACKOFF_MIN && String(env.FORWARD_BACKOFF_MIN).trim()) {
    backoffMin = String(env.FORWARD_BACKOFF_MIN).split(',').map((x) => Number(x.trim()));
    if (!backoffMin.length || backoffMin.some((n) => !Number.isFinite(n) || n <= 0)) {
      errors.push('FORWARD_BACKOFF_MIN must be a comma list of positive numbers (minutes)');
      backoffMin = [1];
    }
  }

  const joinvooPb = env.JOINVOO_PB && String(env.JOINVOO_PB).trim() ? String(env.JOINVOO_PB).trim() : null;
  if (joinvooPb && !/^https?:\/\/[^\s/]+/.test(joinvooPb)) errors.push('JOINVOO_PB must start with http:// or https://');
  const parallelForward = String(env.PARALLEL_FORWARD || '0').trim() === '1';
  if (parallelForward && !joinvooPb) errors.push('PARALLEL_FORWARD=1 requires JOINVOO_PB');

  // Phase 8: Meta Conversions API. Off unless META_CAPI_ENABLED=1; when off nothing below is required, and the
  // token is not even copied into config (the sender can neither read it nor build a URL).
  const metaEnabled = String(env.META_CAPI_ENABLED || '0').trim() === '1';
  if (env.META_CAPI_ENABLED !== undefined && !['', '0', '1'].includes(String(env.META_CAPI_ENABLED).trim())) {
    errors.push(`META_CAPI_ENABLED must be 0 or 1, got "${env.META_CAPI_ENABLED}"`);
  }
  const metaStr = (name) => (env[name] !== undefined && String(env[name]).trim() !== '' ? String(env[name]).trim() : null);
  const metaVersion = metaStr('META_API_VERSION') || 'v22.0';
  if (!/^v\d+\.\d+$/.test(metaVersion)) errors.push(`META_API_VERSION must look like v22.0, got "${metaVersion}"`);
  const metaInt = (name, dflt, min, max) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) errors.push(`${name} must be an integer ${min}-${max === Infinity ? '' : max}${max === Infinity ? ' or more' : ''}, got "${raw}"`.replace(`${min}- or more`, `>= ${min}`));
    return n;
  };
  const metaTimeoutMs = metaInt('META_CAPI_TIMEOUT_MS', 8000, 1000, Infinity);
  const metaMaxTries = metaInt('META_CAPI_MAX_TRIES', 5, 1, Infinity);
  const metaBatch = metaInt('META_CAPI_BATCH', 50, 1, 1000);
  const metaDataset = metaStr('META_DATASET_ID');
  const metaToken = metaStr('META_CAPI_TOKEN');
  if (metaEnabled) {
    const metaMissing = [!metaDataset && 'META_DATASET_ID', !metaToken && 'META_CAPI_TOKEN'].filter(Boolean);
    if (metaMissing.length) errors.push(`META_CAPI_ENABLED=1 requires ${metaMissing.join(', ')}`);
    if (metaDataset && !/^\d+$/.test(metaDataset)) errors.push('META_DATASET_ID must be digits');
  }

  if (errors.length) throw new Error(errors.join('; '));

  const meta = Object.freeze({
    enabled: metaEnabled,
    datasetId: metaEnabled ? metaDataset : null,
    token: metaEnabled ? metaToken : null,
    version: metaVersion,
    testEventCode: metaEnabled ? metaStr('META_TEST_EVENT_CODE') : null,
    timeoutMs: metaTimeoutMs,
    maxTries: metaMaxTries,
    batch: metaBatch
  });

  const joinKey = env.JOIN_KEY && String(env.JOIN_KEY).trim() ? String(env.JOIN_KEY).trim() : null;

  return Object.freeze({
    version: VERSION,
    host: '127.0.0.1',
    port,
    dbPath,
    publicBase: publicBase.replace(/\/+$/, ''),
    adminUser,
    adminPass,
    metaPixel: metaDataset, // the hop page fires the browser pixel for the same dataset
    // Browsers see the TikTok pixels through the hop page; the same ids are mirrored in the TikTok Events API tracker.
    tiktokPixels: String(env.TIKTOK_PIXELS || 'DC06S4RC77UBDHSP2UVG').split(',').map((s) => s.trim()).filter(Boolean),
    joinKey,
    defaultBrand: (env.DEFAULT_BRAND && String(env.DEFAULT_BRAND).trim()) || 'brand-one',
    // Read-only copy of the trading-bot user table, refreshed every 5 minutes by ops/sync-botdb.sh.
    snapshotPath: (env.BOTDB_SNAPSHOT && String(env.BOTDB_SNAPSHOT).trim()) || '/srv/coinvoo/botdb-snapshot.db',
    snapshotStaleMinutes,
    joinvooPb,
    parallelForward,
    parkHours,
    backoffMin: Object.freeze(backoffMin),
    workerIntervalMs,
    affRatePerSec: Math.floor(affRatePerSec),
    goRatePerSec: Math.floor(goRatePerSec),
    affKey,
    affKeyEnforce,
    ipRawRetentionDays: Math.floor(ipRawRetentionDays),
    gateBotApi,
    gateSecret,
    gateBotTimeoutMs: Math.floor(gateBotTimeoutMs),
    backupDir,
    backupKeep: Math.floor(backupKeep),
    brandSeed: Object.freeze(brandSeed),
    meta
  });
}
