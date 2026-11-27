import { log } from './log.js';
import { esc } from './util.js';

// An error a handler throws on purpose; becomes a JSON error response, not an ERROR log.
export class HttpError extends Error {
  constructor(status, code, detail, headers = null) {
    super(detail || code);
    this.status = status;
    this.code = code;
    this.detail = detail || code;
    this.headers = headers; // extra response headers, e.g. retry-after on a 429
  }
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
    ...headers
  });
  res.end(data);
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers
  });
  res.end(text);
}

export function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html)
  });
  res.end(html);
}

const MAX_BODY = 64 * 1024;

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'request body too large');
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad_json', 'body must be a JSON object');
  }
  return parsed;
}

function compile(pattern) {
  return pattern.split('/').map((seg) => (seg.startsWith(':') ? { param: seg.slice(1) } : { lit: seg }));
}

function match(segs, pathParts) {
  if (segs.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].param) {
      try { params[segs[i].param] = decodeURIComponent(pathParts[i]); } catch { return null; }
    } else if (segs[i].lit !== pathParts[i]) return null;
  }
  return params;
}

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    routes.push({ method, pattern, segs: compile(pattern), handler, name: `${method} ${pattern}` });
  }

  async function dispatch(req, res) {
    let route = null;
    try {
      let url;
      try {
        url = new URL(req.url, 'http://coinvoo.local');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'bad_request', detail: 'malformed URL' });
      }
      const parts = url.pathname.split('/');
      let params = null;
      const allowed = [];
      for (const r of routes) {
        const p = match(r.segs, parts);
        if (!p) continue;
        if (r.method === req.method) { route = r; params = p; break; }
        allowed.push(r.method);
      }
      if (!route) {
        if (allowed.length) {
          return sendJson(res, 405, { ok: false, error: 'method_not_allowed', detail: `allowed: ${allowed.join(', ')}` }, { allow: allowed.join(', ') });
        }
        if (url.pathname === '/dash' || url.pathname.startsWith('/dash/')) {
          return sendHtml(res, 404, `<!doctype html><title>Not found</title><h1>Not found</h1><p>${esc(url.pathname)}</p>`);
        }
        return sendJson(res, 404, { ok: false, error: 'not_found', detail: 'no such route' });
      }
      await route.handler({ req, res, params, url, query: url.searchParams });
    } catch (e) {
      if (e instanceof HttpError) {
        if (!res.headersSent) {
          const extra = { ...(e.status === 401 ? { 'www-authenticate': 'Basic realm="coinvoo"' } : {}), ...(e.headers || {}) };
          return sendJson(res, e.status, { ok: false, error: e.code, detail: e.detail }, extra);
        }
        return res.end();
      }
      log.error(route ? route.name : `${req.method} ${req.url}`, e);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal', detail: 'internal error' });
      else res.end();
    }
  }

  return { add, dispatch };
}
