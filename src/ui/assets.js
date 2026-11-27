// The dashboard's static assets: one stylesheet and one script, built once at startup and served from memory under
// a content-hashed name (/dash/assets/app-<hash>.css), so a browser can keep them forever and a deploy that changes
// either one changes its URL. Public: they contain no data, only presentation.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CSS } from './styles.js';
import { ICON_PATHS } from './icons.js';

const CLIENT = readFileSync(new URL('./client.browser.js', import.meta.url), 'utf8');
// The palette rows draw a few icons; ship exactly those paths (constants) ahead of the script.
const PALETTE_ICONS = ['search', 'right', 'home', 'users', 'activity', 'inbox', 'chart', 'wallet', 'link', 'server', 'plus', 'download', 'user', 'hash', 'layers'];
const JS = `window.CV_ICONS=${JSON.stringify(Object.fromEntries(PALETTE_ICONS.map((k) => [k, ICON_PATHS[k]])))};\n${CLIENT}`;

function build(name, ext, body, type) {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
  return { file: `${name}-${hash}.${ext}`, body: Buffer.from(body, 'utf8'), type, etag: `"${hash}"` };
}

const ASSETS = [build('app', 'css', CSS, 'text/css; charset=utf-8'), build('app', 'js', JS, 'text/javascript; charset=utf-8')];
const BY_FILE = new Map(ASSETS.map((a) => [a.file, a]));

export const assetHref = {
  css: `/dash/assets/${ASSETS[0].file}`,
  js: `/dash/assets/${ASSETS[1].file}`
};

// GET /dash/assets/:file — immutable, long-cached. An unknown or stale name is a plain 404.
export function serveAsset(req, res, file) {
  const a = BY_FILE.get(file);
  if (!a) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('not found');
  }
  if (req.headers['if-none-match'] === a.etag) {
    res.writeHead(304, { etag: a.etag, 'cache-control': 'public, max-age=31536000, immutable' });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': a.type,
    'content-length': a.body.length,
    'cache-control': 'public, max-age=31536000, immutable',
    etag: a.etag,
    'x-content-type-options': 'nosniff'
  });
  res.end(req.method === 'HEAD' ? undefined : a.body);
}
