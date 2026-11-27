// One-line logger. Format: [coinvoo] <verb> key=value ...
// No emoji, no colour codes. Values are flattened to a single token.

function val(v) {
  if (v === null || v === undefined || v === '') return '-';
  return String(v).replace(/\s+/g, '_').replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
}

export function fmt(verb, kv = {}) {
  const parts = Object.entries(kv).map(([k, v]) => `${k}=${val(v)}`);
  return `[coinvoo] ${verb}${parts.length ? ' ' + parts.join(' ') : ''}`;
}

export const log = {
  info(verb, kv) {
    console.log(fmt(verb, kv));
  },
  // The one multi-line exception (CLAUDE.md §3.2): errors carry their stack.
  error(route, err) {
    const detail = err && err.stack ? err.stack : String(err);
    console.error(`[coinvoo] ERROR ${route}: ${detail}`);
  }
};
