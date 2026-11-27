-- Phase 11: dashboard sign-in sessions (a login page instead of the browser's basic-auth prompt). Basic auth keeps
-- working for scripts and bots. The cookie holds a random token; only its SHA-256 is stored here. cred_fp ties a
-- session to the credentials it was issued for, so changing ADMIN_USER or ADMIN_PASS ends every session.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  cred_fp      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_hash      TEXT,
  ua           TEXT
);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
