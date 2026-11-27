// HTML building blocks for the dashboard. Every interpolated value goes through esc(); functions here return
// finished (already escaped) HTML strings. Phase 11: the app shell, components and charts of dashboard v2.
// The formatters at the top are shared with the daily card (report.js) and the alerts, and are unchanged.
import { esc } from './util.js';
import { icon } from './ui/icons.js';
import { assetHref } from './ui/assets.js';

export { esc, icon };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LAGOS_OFFSET_MS = 3600000;
const pad = (n) => String(n).padStart(2, '0');

export const DASH = '—';

// Africa/Lagos is UTC+1 all year, so a fixed offset is exact. 'DD MMM HH:mm'.
export function fmtTime(ms) {
  if (ms === null || ms === undefined) return DASH;
  const d = new Date(ms + LAGOS_OFFSET_MS);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function fmtClock(ms) {
  const d = new Date(ms + LAGOS_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// 'DD MMM YYYY' in Lagos time.
export function fmtDate(ms) {
  if (ms === null || ms === undefined) return DASH;
  const d = new Date(ms + LAGOS_OFFSET_MS);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// A Lagos day label 'YYYY-MM-DD' as 'DD MMM'.
export function fmtDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]}` : DASH;
}

export function fmtAgo(ms, now) {
  if (ms === null || ms === undefined) return 'never';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtInt(n) {
  return n === null || n === undefined ? DASH : nf0.format(n);
}

// $1,204.50 · ₦1,204,500 · any other ISO code as `CODE 1,204.50`.
export function fmtMoney(amount, currency = 'USD') {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return DASH;
  if (currency === 'USD') return `${amount < 0 ? '-' : ''}$${nf2.format(Math.abs(amount))}`;
  if (currency === 'NGN') return `${amount < 0 ? '-' : ''}₦${nf0.format(Math.abs(amount))}`;
  return `${currency} ${nf2.format(amount)}`;
}

// $0 · $45 · $1.2k · $12k · $1.4M — chart axes only; tables and tiles always show the exact amount.
export function fmtCompactMoney(v) {
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`;
  return `${s}$${Number.isInteger(a) ? a : a.toFixed(a < 10 ? 1 : 0)}`;
}

export function fmtCompact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// One decimal, always (docs/06 §7.4).
export function fmtPct(p) {
  return p === null || p === undefined || !Number.isFinite(p) ? DASH : `${p.toFixed(1)} %`;
}

// Period-over-period change; `—` when the previous period is 0 (not computable).
export function fmtDelta(cur, prev) {
  if (!prev) return DASH;
  const p = ((cur - prev) / prev) * 100;
  return `${p >= 0 ? '+' : '-'}${Math.abs(p).toFixed(1)} %`;
}

// '/dash/events' + {tab:'parked', page:2} -> '/dash/events?tab=parked&page=2' (empty values dropped).
export function url(path, params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

// ---------------------------------------------------------------------------------------------------------------
// Small components

export function pagination({ path, params, page, limit, total }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  const link = (p, label, rel) => (p < 1 || p > pages ? `<span class="pg off" aria-disabled="true">${label}</span>`
    : `<a class="pg" rel="${rel}" href="${esc(url(path, { ...params, page: p === 1 ? '' : p }))}">${label}</a>`);
  return `<nav class="pager" aria-label="pagination">${link(page - 1, `${icon('left')}Prev`, 'prev')}`
    + `<span class="muted">${esc(fmtInt(from))}&ndash;${esc(fmtInt(to))} of ${esc(fmtInt(total))} &middot; page ${esc(page)} / ${esc(pages)}</span>`
    + `${link(page + 1, `Next${icon('right')}`, 'next')}</nav>`;
}

export function emptyState({ ico = 'inbox', title = '', text = '', action = '' } = {}) {
  return `<div class="empty"><div class="ico">${icon(ico)}</div>${title ? `<b>${esc(title)}</b>` : ''}`
    + `${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
}

// A table in a card-like frame. `rowsHtml` empty -> an empty state carrying `empty` as its text.
export function table(headHtml, rowsHtml, empty = 'Nothing to show.', { cls = '' } = {}) {
  if (!rowsHtml.length) return `<div class="tw${cls ? ` ${cls}` : ''}"><div class="muted empty"><div class="ico">${icon('inbox')}</div><p>${esc(empty)}</p></div></div>`;
  return `<div class="tw${cls ? ` ${cls}` : ''}"><table><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml.join('')}</tbody></table></div>`;
}

// A KPI tile. The label/value markup (.tl then .tv) is a contract the tests read; `opts.spark` adds a sparkline.
export function tile(label, valueHtml, sub, metric, opts = {}) {
  const attr = metric ? ` data-metric="${esc(metric.name)}" data-value="${esc(metric.value)}"` : '';
  return `<div class="tile${opts.cls ? ` ${opts.cls}` : ''}"${attr}><div class="tl">${esc(label)}</div><div class="tv">${valueHtml}</div>`
    + `<div class="ts">${sub === undefined || sub === '' ? '&nbsp;' : sub}</div>${opts.spark || ''}</div>`;
}

export function card({ title = '', sub = '', actions = '', body = '', foot = '', cls = '', id = '', flush = false, headingTag = 'h2' }) {
  const head = title || actions
    ? `<div class="card-head"><div>${title ? `<${headingTag}>${esc(title)}</${headingTag}>` : ''}${sub ? `<p class="muted">${sub}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>` : '';
  return `<section class="card${cls ? ` ${cls}` : ''}"${id ? ` id="${esc(id)}"` : ''}>${head}${flush ? body : `<div class="card-body">${body}</div>`}${foot ? `<div class="card-foot">${foot}</div>` : ''}</section>`;
}

export function pageHead({ title, sub = '', actions = '', crumbs = null }) {
  const c = crumbs ? `<nav class="crumbs" aria-label="breadcrumb">${crumbs.map(([label, href]) => (href ? `<a href="${esc(href)}">${esc(label)}</a>` : `<span>${esc(label)}</span>`)).join(icon('right', 'sep'))}</nav>` : '';
  return `<div class="page-head"><div>${c}<h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
}

// Segmented links: [[key, label, href, extraHtml?]].
export function seg(items, current, ariaLabel) {
  return `<div class="seg" role="group" aria-label="${esc(ariaLabel)}">${items.map(([k, label, href, extra]) =>
    `<a href="${esc(href)}"${k === current ? ' class="on" aria-current="true"' : ''}>${esc(label)}${extra || ''}</a>`).join('')}</div>`;
}

// A copy-to-clipboard control that degrades to a readonly field with JS off.
export function copyField(value, label = 'Copy') {
  return `<span class="copy"><input readonly value="${esc(value)}" aria-label="${esc(label)}"> `
    + `<button type="button" class="btn sm" data-copy="${esc(value)}">${icon('copy')}<span>${esc(label)}</span></button></span>`;
}

// A short value (an id) with an icon-only copy button beside it, for key/value lists.
export function copyInline(value, label = 'Copy') {
  return `<span class="copy-inline"><span class="mono">${esc(value)}</span><button type="button" class="btn icon sm ghost" data-copy="${esc(value)}" title="${esc(label)}">${icon('copy')}<span class="sr">${esc(label)}</span></button></span>`;
}

export function tag(state, text) {
  return `<span class="tag t-${esc(state)}">${esc(text ?? state)}</span>`;
}

export function kindBadge(kind) {
  const label = { reg: 'REG', ftd: 'FTD', dep: 'DEP', ignored: '—' }[kind] || String(kind || '').toUpperCase();
  return `<span class="kind ${esc(kind)}">${esc(label)}</span>`;
}

export function flash(kind, text) {
  return `<div class="flash ${kind === 'ok' ? 'ok' : 'err'}" role="status">${icon(kind === 'ok' ? 'ok' : 'alert')}<span>${esc(text)}</span></div>`;
}

// Initials avatar with a colour picked from the id, so the same person keeps the same colour.
export function avatar(seed, name, cls = '') {
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const clean = String(name || '').replace(/^@/, '').trim();
  const initials = (clean.match(/[A-Za-z0-9]/g) || ['#']).slice(0, 2).join('').toUpperCase();
  return `<span class="avatar h${h % 8}${cls ? ` ${cls}` : ''}" aria-hidden="true">${esc(initials)}</span>`;
}

export function deltaHtml(cur, prev, { invert = false } = {}) {
  if (!prev) return `<span class="muted">${DASH} vs prev</span>`;
  const good = invert ? cur <= prev : cur >= prev;
  return `<span class="delta ${good ? 'pos' : 'neg'}">${icon(cur >= prev ? 'up' : 'down')}${esc(fmtDelta(cur, prev))}</span> <span class="muted">vs prev</span>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Charts — inline SVG for the geometry, HTML for every piece of text, so labels stay legible at phone width.

export function sparkline(values) {
  const n = values.length;
  const max = Math.max(0, ...values);
  if (n < 2 || max <= 0) return '<svg class="spark flat" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path class="line" d="M0 29H100"/></svg>';
  const pts = values.map((v, i) => [(i / (n - 1)) * 100, 28 - (Math.max(0, v) / max) * 25]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join('');
  return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${line}L100 30L0 30Z"/><path class="line" d="${line}"/></svg>`;
}

// The smallest "nice" number >= v: 1, 2, 4, 5, 8 or 10 times a power of ten. Counts round up to a multiple of 4.
export function niceMax(v, { integer = false } = {}) {
  if (!(v > 0)) return integer ? 4 : 1;
  if (integer) return Math.max(4, Math.ceil(v / 4) * 4);
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 4, 5, 8, 10]) if (v <= m * mag + 1e-9) return m * mag;
  return 10 * mag;
}

// Revenue bars (left axis) and a count line (right axis) over equal buckets.
//   buckets: [{ label, tip, bar, line }]   barFmt/lineFmt: axis label formatters
export function trendChart({ buckets, barFmt = fmtCompactMoney, lineFmt = fmtCompact, ariaLabel = 'chart' }) {
  const n = buckets.length;
  const maxBar = niceMax(Math.max(0, ...buckets.map((b) => b.bar)));
  const maxLine = niceMax(Math.max(0, ...buckets.map((b) => b.line)), { integer: true });
  const W = 1000;
  const H = 1000;
  const band = W / n;
  const bw = Math.max(2, Math.min(band * 0.58, 46));
  const grid = [0, 0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${f * H}" y2="${f * H}"/>`).join('');
  const bars = buckets.map((b, i) => {
    const h = (b.bar / maxBar) * H;
    return h > 0 ? `<rect class="bar" x="${(i * band + (band - bw) / 2).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>` : '';
  }).join('');
  const pts = buckets.map((b, i) => `${i ? 'L' : 'M'}${(i * band + band / 2).toFixed(1)} ${(H - (b.line / maxLine) * H * 0.96).toFixed(1)}`).join('');
  const line = n > 1 ? `<path class="line" d="${pts}"/>` : '';
  const ticks = (max, fmt) => [1, 0.75, 0.5, 0.25, 0].map((f) => `<span>${esc(fmt(max * f))}</span>`).join('');
  const every = Math.max(1, Math.ceil(n / 8));
  // Every `every`-th bucket is labelled; on a phone every other one of those is hidden (class "odd").
  const xl = buckets.map((b, i) => (i % every === 0 ? `<span${(i / every) % 2 ? ' class="odd"' : ''}>${esc(b.label)}</span>` : '<span></span>')).join('');
  const hits = buckets.map((b) => `<span data-tip="${esc(b.tip)}"></span>`).join('');
  // The same numbers for screen readers (the bars and the line are decorative to them).
  const srRows = buckets.map((b) => `<li>${esc(b.tip.replace(/\n/g, ' · '))}</li>`).join('');
  return `<div class="chart" role="img" aria-label="${esc(ariaLabel)}"><div class="yax">${ticks(maxBar, barFmt)}</div>`
    + `<div class="plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><g class="grid">${grid}</g>${bars}${line}</svg><div class="hits">${hits}</div></div>`
    + `<div class="yax r">${ticks(maxLine, lineFmt)}</div><div class="xax">${xl}</div><ul class="sr">${srRows}</ul></div>`;
}

// A proportional bar (0..max) as a tiny SVG; for table cells, funnels and ranked lists.
export function bar(value, max, cls = '') {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="0" width="${w.toFixed(2)}" height="10"/></svg>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Page shells

const NAV = [
  ['Analytics', [['overview', '/dash', 'Overview', 'home'], ['members', '/dash/members', 'Members', 'users'], ['events', '/dash/events', 'Events', 'activity'], ['campaigns', '/dash/campaigns', 'Campaigns', 'chart']]],
  ['Operations', [['adlinks', '/dash/ad-links', 'Ad links', 'target'], ['spend', '/dash/spend', 'Spend', 'wallet'], ['links', '/dash/links', 'Links', 'link'], ['system', '/dash/system', 'System', 'server']]]
];

const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7B8CFF"/><stop offset="1" stop-color="#A07BFF"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><path d="M20 12.6a4.8 4.8 0 1 0 0 6.8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>')}`;

// Runs before the stylesheet paints, so a light-theme user never sees a dark flash. Constant text.
const THEME_BOOT = "(function(){try{var t=localStorage.getItem('cv-theme');if(!t&&window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)t='light';if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}})();";

function head(title, nonce) {
  return '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="dark light"><title>${esc(title)} · Coinvoo</title>`
    + `<link rel="icon" href="${FAVICON}"><link rel="stylesheet" href="${assetHref.css}"><script nonce="${esc(nonce)}">${THEME_BOOT}</script></head>`;
}

const brandMark = () => `<span class="mark">${icon('logo')}</span>`;

// The signed-in app: sidebar, mobile top bar, content. `counts` = { events, system } nav badges.
export function layout({ title, active, body, nonce, user = 'admin', counts = {} }) {
  const navHtml = NAV.map(([label, items]) => `<div class="nav-label">${esc(label)}</div>${items.map(([k, href, text, ico]) => {
    const on = k === active;
    const n = k === 'events' ? counts.events : k === 'system' ? counts.system : 0;
    const badge = n ? `<span class="count ${k === 'system' ? 'neg' : 'warn'}" title="${k === 'system' ? 'issues' : 'parked events'}">${esc(fmtInt(n))}</span>` : '';
    return `<a href="${href}"${on ? ' class="on" aria-current="page"' : ''}>${icon(ico)}<span>${esc(text)}</span>${badge}</a>`;
  }).join('')}`).join('');
  return `${head(title, nonce)}<body><a class="skip" href="#main">Skip to content</a><div class="app">`
    + '<aside class="side" id="side" aria-label="Sidebar">'
    + `<a class="brand" href="/dash">${brandMark()}<span>Coinvoo<small>Attribution</small></span></a>`
    + `<button class="search-btn" type="button" data-cmdk>${icon('search')}<span>Search</span><kbd>⌘K</kbd></button>`
    + `<nav class="side-nav" aria-label="Primary">${navHtml}</nav>`
    + '<div class="side-foot">'
    + `<div class="who">${avatar(user, user)}<div class="meta"><b>${esc(user)}</b><span>Owner · Africa/Lagos</span></div></div>`
    + '<div class="side-actions">'
    + `<button type="button" class="btn sm" data-theme-toggle aria-pressed="false" title="Switch theme">${icon('moon', 'dark-only')}${icon('sun', 'light-only')}<span>Theme</span></button>`
    + `<form method="post" action="/dash/logout"><button class="btn sm" type="submit">${icon('logout')}<span>Sign out</span></button></form>`
    + '</div></div></aside><div class="backdrop" aria-hidden="true"></div>'
    + '<div class="main"><header class="topbar">'
    + `<button type="button" class="btn icon ghost" data-menu aria-label="Open menu" aria-controls="side">${icon('menu')}</button>`
    + `<a class="brand" href="/dash">${brandMark()}<span>Coinvoo</span></a><span class="grow"></span>`
    + `<button type="button" class="btn icon ghost" data-cmdk aria-label="Search">${icon('search')}</button></header>`
    + `<main id="main" class="content">${body}</main></div></div>`
    + `<script nonce="${esc(nonce)}" src="${assetHref.js}"></script></body></html>`;
}

// A page without the app shell: sign-in and the signed-out error pages.
export function solo({ title, body, nonce }) {
  return `${head(title, nonce)}<body><main class="solo" id="main">${body}</main>`
    + `<script nonce="${esc(nonce)}" src="${assetHref.js}"></script></body></html>`;
}

export { brandMark };
