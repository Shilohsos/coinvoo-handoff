import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { nowMs } from './util.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

// BEGIN IMMEDIATE ... COMMIT; rolls back and rethrows on error.
export function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

// Split a migration file into statements. Handles `--` comments and '…' strings.
// Migrations here contain no triggers, so a `;` outside a string always ends a statement.
export function splitSql(text) {
  const out = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (text[i + 1] === "'") { cur += "'"; i++; } else inStr = false;
      }
    } else if (c === "'") {
      inStr = true;
      cur += c;
    } else if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      cur += '\n';
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Apply pending migrations in numeric order, one transaction each. Values are never
// interpolated into SQL: `$NAME` placeholders are bound from `env` (empty -> NULL);
// `$NOW_MS` is bound to the current time.
export function migrate(db, { dir = MIGRATIONS_DIR, env = {}, now = nowMs } = {}) {
  const files = readdirSync(dir).filter((f) => MIGRATION_RE.test(f)).sort();
  const hasTable = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  const done = new Set(hasTable ? db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name) : []);

  let applied = 0;
  for (const file of files) {
    const name = file.replace(/\.sql$/, '');
    if (done.has(name)) continue;
    const statements = splitSql(readFileSync(join(dir, file), 'utf8'));
    const ts = now();
    withTx(db, () => {
      for (const sql of statements) {
        const names = [...new Set([...sql.matchAll(/\$([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))];
        const params = {};
        for (const n of names) {
          if (n === 'NOW_MS') params[n] = ts;
          else params[n] = env[n] === undefined || env[n] === '' ? null : String(env[n]);
        }
        db.prepare(sql).run(params);
      }
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, ts);
    });
    applied++;
  }

  const rows = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all();
  return { newlyApplied: applied, total: rows.length, latest: rows.length ? rows[rows.length - 1].name : null };
}

export function ensureIpSalt(db) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('ip_salt', ?) ON CONFLICT(key) DO NOTHING")
    .run(randomBytes(32).toString('hex'));
  return db.prepare("SELECT value FROM settings WHERE key = 'ip_salt'").get().value;
}
