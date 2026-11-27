import { randomBytes } from 'node:crypto';
import { HttpError, sendJson } from '../router.js';
import { requireAdmin, requireSameOrigin, checkPassword, sessionsFor, adminAuthState } from '../auth.js';
import { log } from '../log.js';
import { mintLink, linkUrls } from './links.js';
import { listAdLinks, getAdLink, createAdLink, updateAdLink, adLinkUrls, M_PARAM } from './adlinks.js';
import * as Q from '../queries.js';
import { saveSpend, spendRoutes } from './spend.js';
import { exportRoutes } from './export.js';
import { lagosDayLabel, lagosDayStart } from '../worker.js';
import { summarize } from '../report.js';
import { snapshotHealth, fmtAge } from '../botdb.js';
import { systemStatus } from '../system.js';
import { serveAsset } from '../ui/assets.js';
import {
  esc, icon, layout, solo, table, tile, card, pageHead, seg, tag, kindBadge, flash, avatar, deltaHtml, url, pagination,
  copyField, copyInline, emptyState, sparkline, trendChart, bar, brandMark,
  fmtTime, fmtDate, fmtDay, fmtAgo, fmtMoney, fmtInt, fmtPct, fmtCompact, DASH
} from '../render.js';

const PAGE = 50;
const DAY = 86400000;
const EVENT_TABS = [['all', 'All', null], ['matched', 'Matched', 'matched'], ['parked', 'Parked', 'parked'], ['expired', 'Expired', 'expired'], ['ignored', 'Ignored', 'ignored']];

// Operator-facing messages for the redirect-after-POST banners. Only these codes are ever shown.
const NOTICES = {
  attached: ['ok', 'Event attached. It is now matched with path "manual".'],
  note_required: ['err', 'A note is required to attach an event.'],
  no_member: ['err', 'No member found for that Telegram id or username in this event\'s brand.'],
  ambiguous_member: ['err', 'More than one member matched that search; use the Telegram id.'],
  not_parked: ['err', 'That event is no longer parked.'],
  not_found: ['err', 'No such event.'],
  brand_mismatch: ['err', 'That member belongs to another brand.'],
  bad_params: ['err', 'The request was not valid.'],
  attached_linked: ['ok', 'Event attached, and its broker id is now linked to that member: the trader\'s other parked events were re-matched.'],
  account_claimed: ['err', 'That broker id already belongs to another member. Nothing was changed.'],
  no_trader_id: ['err', 'This event has no broker id to link. Attach it without linking.'],
  spend_saved: ['ok', 'Spend saved. Entering the same day/campaign/ad set/ad again replaces the amount.'],
  spend_negative: ['err', 'Spend cannot be negative.'],
  spend_brand: ['err', 'Unknown or inactive brand.'],
  spend_bad: ['err', 'The spend entry was not valid: check the date (YYYY-MM-DD), the amount and the currency.'],
  spend_deleted: ['ok', 'Spend row deleted.'],
  spend_missing: ['err', 'That spend row no longer exists.'],
  sessions_revoked: ['ok', 'Every other session has been signed out.'],
  adlink_created: ['ok', 'Ad link created. Copy the link into the ad, and the tags into its URL parameters.'],
  adlink_saved: ['ok', 'Ad link saved.'],
  adlink_on: ['ok', 'Ad link switched on.'],
  adlink_off: ['ok', 'Ad link switched off. Anyone who opens it now gets the not-found page.'],
  adlink_label: ['err', 'A label is required.'],
  adlink_bad: ['err', 'That ad link was not saved: each field is at most 200 characters.'],
  adlink_missing: ['err', 'No such ad link.']
};

const KEY_REDACT = /(^ip$|ip_?addr|user_?ip|client_?ip|token|secret|passw|api_?key|apikey|signature)/i;

export function redactPayload(v) {
  if (Array.isArray(v)) return v.map(redactPayload);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = KEY_REDACT.test(k) ? '[redacted]' : redactPayload(x);
    return o;
  }
  return v;
}

export function prettyPayload(json) {
  try { return JSON.stringify(redactPayload(JSON.parse(json)), null, 2); } catch { return '[unreadable payload]'; }
}

// The redirect after a form POST. `back` comes from the form, so it is resolved first (dot segments, backslashes)
// and used only when the result is still a same-site path under `prefix`; anything else falls back.
export function safeBack(back, prefix, fallback) {
  try {
    const u = new URL(String(back || ''), 'http://coinvoo.local');
    if (u.origin === 'http://coinvoo.local' && !u.pathname.startsWith('//') && (u.pathname === prefix || u.pathname.startsWith(`${prefix}/`))) {
      return `${u.pathname}${u.search}`;
    }
  } catch { /* fall back */ }
  return fallback;
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'too_large', 'request body too large');
    chunks.push(c);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export const memberSource = Q.memberSource;

const kindLabel = (k) => ({ reg: 'REG', ftd: 'FTD', dep: 'DEP', ignored: 'ignored' }[k] || k);
const memberLabel = (r) => (r.username ? `@${r.username}` : String(r.telegram_id));
const wantsHtml = (req) => /text\/html/.test(String(req.headers.accept || ''));

function money(amount, currency) {
  return amount === null || amount === undefined ? DASH : fmtMoney(amount, currency);
}

function otherMoney(list) {
  return list.map((o) => ` <span class="muted">+${esc(fmtMoney(o.amount, o.currency))}</span>`).join('');
}

const roiText = (v) => (v === null ? DASH : `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(1)} %`);
const roiHtml = (v) => (v === null ? DASH : `<span class="${v >= 0 ? 'pos' : 'neg'}">${esc(roiText(v))}</span>`);

// Attribution quality (docs/03 §8): ignored events are outside the denominator. Always rendered. The row markup
// (label, then percentage, then count) is what the tests read.
function qualityHtml(st) {
  const denom = st.matched + st.parked + st.expired;
  const pct = (n) => (denom > 0 ? (n / denom) * 100 : null);
  const qrow = (label, key, n, extra = '') => `<div class="row" data-metric="${key}" data-value="${n}"><i class="dot ${key}"></i><span class="lab">${esc(label)}</span>`
    + `<span class="pc">${esc(fmtPct(pct(n)))}</span><span class="muted">(${esc(fmtInt(n))}${extra})</span></div>`;
  const qbar = denom > 0
    ? '<svg class="qbar" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="matched, parked, expired share">'
      + `<rect class="m" x="0" y="0" width="${(st.matched / denom) * 100}" height="4"/>`
      + `<rect class="p" x="${(st.matched / denom) * 100}" y="0" width="${(st.parked / denom) * 100}" height="4"/>`
      + `<rect class="x" x="${((st.matched + st.parked) / denom) * 100}" y="0" width="${(st.expired / denom) * 100}" height="4"/></svg>`
    : '<svg class="qbar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"></svg>';
  return `<div class="q">${qbar}`
    + qrow('Matched', 'matched', st.matched, ` / ${esc(fmtInt(denom))}`)
    + qrow('Parked', 'parked', st.parked)
    + qrow('Expired', 'expired', st.expired)
    + `<div class="row" data-metric="ignored" data-value="${st.ignored}"><i class="dot ignored"></i><span class="lab">Ignored</span><span class="pc">${esc(fmtInt(st.ignored))}</span>`
    + '<span class="muted">stub, duplicate or unknown status — excluded from the percentages above</span></div></div>';
}

// Buckets for a period: hours for one day, days up to ~3 months, weeks beyond.
function bucketsFor(range) {
  const len = range.end - range.start;
  const hour = (s) => `${String(new Date(s + 3600000).getUTCHours()).padStart(2, '0')}:00`;
  if (len <= DAY) return { ms: 3600000, unit: 'hour', label: hour, long: (s) => `${fmtDate(s)} ${hour(s)}` };
  if (len <= 92 * DAY) return { ms: DAY, unit: 'day', label: (s) => fmtDay(lagosDayLabel(s)), long: (s) => fmtDate(s) };
  return { ms: 7 * DAY, unit: 'week', label: (s) => fmtDay(lagosDayLabel(s)), long: (s) => `Week of ${fmtDate(s)}` };
}

export function dashRoutes(deps) {
  const { db, config } = deps;

  function send(res, html, nonce, status = 200, headers = {}) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(html),
      // Phase 11: the stylesheet and the script come from /dash/assets (same origin); no inline style is used.
      'content-security-policy': `default-src 'none'; style-src 'self'; script-src 'nonce-${nonce}' 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers
    });
    res.end(html);
  }

  function redirect(res, location, headers = {}) {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
    res.end();
  }

  const nonceOf = () => randomBytes(16).toString('base64');

  // One page of the signed-in app. The System read feeds the nav badges. It is kept for NAV_CACHE_MS, so an
  // ordinary screen costs no extra queries; Overview and System read it fresh anyway and refresh the cache.
  const NAV_CACHE_MS = 15000;
  let navCache = { at: 0, status: null };
  function navStatus(fresh) {
    if (fresh) navCache = { at: Date.now(), status: fresh };
    else if (!navCache.status || Date.now() - navCache.at > NAV_CACHE_MS) {
      try { navCache = { at: Date.now(), status: systemStatus(deps) }; } catch (e) { log.error('system status', e); }
    }
    return navCache.status;
  }

  function page(res, { title, active, body, status = null, code = 200 }) {
    const s = navStatus(status);
    const counts = s ? { events: s.parked, system: s.issues.filter((i) => i.level !== 'info').length } : {};
    const nonce = nonceOf();
    send(res, layout({ title, active, body, nonce, user: config.adminUser, counts }), nonce, code);
  }

  function soloPage(res, { title, body, code = 200, headers = {} }) {
    const nonce = nonceOf();
    send(res, solo({ title, body, nonce }), nonce, code, headers);
  }

  function noticeHtml(code) {
    const n = NOTICES[code];
    return n ? flash(n[0], n[1]) : '';
  }

  function errorCard(codeNum, title, text, inApp = false) {
    return `<div class="solo-card${inApp ? ' in-app' : ''}">${inApp ? '' : `<a class="brand" href="/dash">${brandMark()}<span>Coinvoo</span></a>`}`
      + `<div class="err-code">${esc(codeNum)}</div><h1>${esc(title)}</h1><p class="lead">${esc(text || '')}</p>`
      + `<a class="btn primary block" href="/dash">${icon('home')}Back to the overview</a></div>`;
  }

  // HTML error pages for browsers; API clients and scripts keep the JSON the router writes. A signed-out browser
  // goes to the sign-in page and comes back to where it was afterwards.
  const htmlRoute = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (e) {
      const { req, res } = ctx;
      if (res.headersSent || !wantsHtml(req)) throw e;
      if (e instanceof HttpError) {
        if (e.status === 401) {
          const next = `${ctx.url.pathname}${ctx.url.search}`;
          return redirect(res, url('/dash/login', { next: req.method === 'GET' && next !== '/dash' ? next : '' }));
        }
        if (e.status === 429) {
          return soloPage(res, { title: 'Too many attempts', code: 429, headers: e.headers || {}, body: errorCard(429, 'Too many sign-in attempts', 'This address is blocked for a few minutes after repeated wrong passwords. Wait, then try again.') });
        }
        const title = e.status === 404 ? 'Not found' : e.status === 403 ? 'Request refused' : 'That request was not valid';
        const text = e.status === 404 ? 'It may have been removed, or the link is wrong.' : e.detail;
        if (adminAuthState(req, config) === 'ok') return page(res, { title, active: '', code: e.status, body: errorCard(e.status, title, text, true) });
        return soloPage(res, { title, code: e.status, body: errorCard(e.status, title, text) });
      }
      log.error(`${req.method} ${ctx.url.pathname}`, e);
      return soloPage(res, { title: 'Error', code: 500, body: errorCard(500, 'Something went wrong', 'The error was logged and nothing was lost. Try again in a moment.') });
    }
  };

  // ---------- shared controls ----------
  function brandSeg(path, params) {
    const items = [['all', 'All'], ...Q.listBrands(db).map((b) => [b.code, b.code === 'brand-two' ? 'brand-two' : b.code])];
    const cur = params.brand || 'all';
    return seg(items.map(([k, label]) => [k, label, url(path, { ...params, brand: k === 'all' ? '' : k, page: '' })]), cur, 'Brand');
  }

  function periodSeg(path, params, range) {
    const base = { ...params, from: '', to: '', page: '' };
    const items = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']].map(([k, label]) => [k, label, url(path, { ...base, period: k })]);
    const custom = range.key === 'custom';
    const hidden = Object.entries(params).filter(([k, v]) => v && !['period', 'from', 'to', 'page'].includes(k))
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    const pop = `<details class="pop seg"><summary${custom ? ' class="on"' : ''}>${icon('calendar')}${custom ? `${esc(fmtDay(range.fromDay))} – ${esc(fmtDay(range.toDay))}` : 'Custom'}</summary>`
      + `<div class="pop-body"><form method="get" action="${esc(path)}"><div class="form-grid">`
      + `<label class="field"><span>From</span><input type="date" name="from" value="${esc(range.fromDay)}" required></label>`
      + `<label class="field"><span>To</span><input type="date" name="to" value="${esc(range.toDay)}" required></label></div>${hidden}`
      + '<div class="form-actions"><button class="btn primary" type="submit">Apply range</button></div></form></div></details>';
    return `${seg(items, range.key, 'Period')}${pop}`;
  }

  const rangeSub = (range) => `${esc(fmtDay(range.fromDay))} → ${esc(fmtDay(range.toDay))} ${esc(range.toDay.slice(0, 4))}<span class="dot"></span>Africa/Lagos`;

  // ---------- sign in / out ----------
  function loginPage({ res, error = '', notice = '', next = '', code = 200, headers = {} }) {
    const body = `<div class="solo-card"><a class="brand" href="/dash/login">${brandMark()}<span>Coinvoo</span></a>`
      + '<h1>Sign in</h1><p class="lead">Attribution for every Telegram member and deposit.</p>'
      + `<form method="post" action="/dash/login">${error ? flash('err', error) : ''}${notice ? flash('ok', notice) : ''}`
      + '<label class="field"><span>Username</span><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>'
      + '<label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>'
      + `<input type="hidden" name="next" value="${esc(next)}">`
      + `<button class="btn primary block" type="submit">Sign in${icon('right')}</button></form>`
      + '<p class="solo-foot">Ten wrong passwords lock this address for 15 minutes.</p></div>';
    soloPage(res, { title: 'Sign in', body, code, headers });
  }

  function loginGet({ req, res, query }) {
    const store = sessionsFor(config);
    if (store && store.check(req)) return redirect(res, '/dash');
    loginPage({ res, next: safeBack(query.get('next'), '/dash', ''), notice: query.get('bye') ? 'You have been signed out.' : '' });
  }

  async function loginPost({ req, res }) {
    requireSameOrigin(req);
    const form = await readForm(req);
    const next = safeBack(form.get('next'), '/dash', '/dash');
    const r = checkPassword(req, config, form.get('username'), form.get('password'));
    if (r === 'blocked') return loginPage({ res, code: 429, next, error: 'Too many wrong passwords from this address. Try again in 15 minutes.', headers: { 'retry-after': '900' } });
    if (r !== 'ok') return loginPage({ res, code: 401, next, error: 'Wrong username or password.' });
    const cookie = sessionsFor(config).create(req);
    log.info('signed_in', { via: 'form' });
    redirect(res, next.startsWith('/dash/login') ? '/dash' : next, { 'set-cookie': cookie });
  }

  async function logout({ req, res }) {
    requireSameOrigin(req);
    const store = sessionsFor(config);
    const cookie = store ? store.destroy(req) : null;
    redirect(res, '/dash/login?bye=1', cookie ? { 'set-cookie': cookie } : {});
  }

  // ---------- /dash ----------
  function overview({ req, res, query }) {
    requireAdmin(req, config);
    const now = deps.now();
    const brandCode = query.get('brand') || 'all';
    const brandId = Q.resolveBrandId(db, brandCode);
    const range = Q.periodRange({ period: query.get('period'), from: query.get('from'), to: query.get('to') }, now);
    const status = systemStatus(deps);

    // One implementation of the Overview numbers, shared with the daily card and /api/summary.
    const cur = summarize(db, { brandId, start: range.start, end: range.end, fromDay: range.fromDay, toDay: range.toDay });
    const prev = Q.funnel(db, { brandId, start: range.prevStart, end: range.prevEnd });
    const rev = cur.revenue;
    const prevRev = prev.revenue.USD || 0;
    const otherRev = Object.entries(cur.revenue_other);
    const unattr = cur.unattributed;
    const otherUnattr = Object.entries(cur.unattributed_other);
    const bk = bucketsFor(range);
    const ser = Q.series(db, { brandId, start: range.start, end: range.end, bucketMs: bk.ms });

    const params = { brand: brandCode === 'all' ? '' : brandCode, period: range.key === 'custom' ? '' : range.key, from: range.key === 'custom' ? range.fromDay : '', to: range.key === 'custom' ? range.toDay : '' };
    const lastAt = Q.lastEventAt(db, brandId);
    const m = (name, value) => ({ name, value });

    const funnelTiles = [
      tile('Clicks', esc(fmtInt(cur.clicks)), deltaHtml(cur.clicks, prev.clicks), m('clicks', cur.clicks), { spark: sparkline(ser.clicks) }),
      tile('Joins', esc(fmtInt(cur.joins)), `${deltaHtml(cur.joins, prev.joins)}<br><span class="muted">${esc(fmtInt(cur.ad_joins))} via ad link</span>`, m('joins', cur.joins), { spark: sparkline(ser.joins) }),
      tile('Registrations', esc(fmtInt(cur.regs)), deltaHtml(cur.regs, prev.regs), m('regs', cur.regs), { spark: sparkline(ser.regs) }),
      tile('FTDs', esc(fmtInt(cur.ftds)), deltaHtml(cur.ftds, prev.ftds), m('ftds', cur.ftds), { spark: sparkline(ser.ftds) }),
      tile('Re-deposits', esc(fmtInt(cur.redeps)), deltaHtml(cur.redeps, prev.redeps), m('redeps', cur.redeps), { spark: sparkline(ser.redeps) }),
      tile('Revenue', esc(fmtMoney(rev)), `${deltaHtml(rev, prevRev)}${otherRev.map(([c, a]) => `<br><span class="muted">+${esc(fmtMoney(a, c))}</span>`).join('')}`, m('revenue', rev), { spark: sparkline(ser.revenue), cls: 'money' })
    ].join('');

    const roi = cur.roi;
    const orDash = (v) => (v === null ? DASH : fmtMoney(v));
    const moneyTiles = [
      tile('Spend', esc(orDash(cur.spend)), cur.spend === null ? 'none entered' : '', m('spend', cur.spend ?? ''), { spark: cur.spend === null ? '' : sparkline(ser.spend) }),
      tile('Cost / join', esc(orDash(cur.cost_per_join)), '', m('cost_per_join', cur.cost_per_join ?? '')),
      tile('Cost / FTD', esc(orDash(cur.cost_per_ftd)), 'USD spend ÷ USD FTDs', m('cost_per_ftd', cur.cost_per_ftd ?? '')),
      tile('Revenue', esc(fmtMoney(rev)), 'matched ftd + dep', m('revenue_money', rev)),
      tile('ROI', roi === null ? DASH : `<span class="${roi >= 0 ? 'pos' : 'neg'}">${esc(roiText(roi))}</span>`, '(revenue − spend) / spend', m('roi', roi === null ? '' : roi)),
      tile('Unattributed revenue', esc(fmtMoney(unattr)), `parked + expired${otherUnattr.map(([c, a]) => `<br>+${esc(fmtMoney(a, c))}`).join('')}`, m('unattributed', unattr))
    ].join('');

    // Revenue bars and the FTD line per bucket.
    const buckets = ser.revenue.map((v, i) => {
      const s = range.start + i * bk.ms;
      return {
        label: bk.label(s), bar: v, line: ser.ftds[i],
        tip: `${bk.long(s)}\nRevenue ${fmtMoney(v)} · ${fmtInt(ser.ftds[i])} FTD${ser.ftds[i] === 1 ? '' : 's'}\nClicks ${fmtInt(ser.clicks[i])} · Joins ${fmtInt(ser.joins[i])} · Regs ${fmtInt(ser.regs[i])}`
      };
    });
    const anyChart = buckets.some((b) => b.bar > 0 || b.line > 0);
    const chartCard = card({
      title: 'Performance', sub: `Matched revenue (USD) and FTDs per ${bk.unit}`, cls: 'fill',
      actions: '<div class="legend"><span><i class="rev"></i>Revenue</span><span><i class="ftd"></i>FTDs</span></div>',
      body: anyChart ? trendChart({ buckets, ariaLabel: 'Revenue and FTDs over the period' }) : `<div class="chart-empty">${esc('No revenue or FTDs in this period yet.')}</div>`
    });

    // Needs attention: parked events first (the operator can act on them), then the system issues.
    const attnItems = [];
    if (status.parked) attnItems.push({ level: 'warn', title: `${fmtInt(status.parked)} parked event${status.parked === 1 ? '' : 's'} waiting for a member`, text: 'Matched automatically when the member appears, or attach one by hand.', href: '/dash/events?tab=parked', ico: 'inbox' });
    for (const i of status.issues) attnItems.push({ ...i, ico: i.level === 'info' ? 'info' : 'alert' });
    const attnHtml = attnItems.length
      ? `<div class="attn">${attnItems.slice(0, 6).map((i) => `<a href="${esc(i.href)}"><span class="ico ${i.level === 'info' ? 'info' : i.level}">${icon(i.ico)}</span><span class="t">${esc(i.title)}<small>${esc(i.text || '')}</small></span>${icon('right', 'chev')}</a>`).join('')}</div>`
      : emptyState({ ico: 'ok', title: 'All clear', text: 'Nothing needs your attention right now.' });
    const attnCard = card({ title: 'Needs attention', flush: true, body: attnHtml });
    const qualityCard = card({ title: 'Attribution quality', sub: 'Share of decided events in the period', body: qualityHtml(cur.states) });

    // Funnel for the period (all sources): each step against the one before it.
    const steps = [['Clicks', cur.clicks], ['Joins', cur.joins], ['Registrations', cur.regs], ['FTDs', cur.ftds], ['Re-deposits', cur.redeps]];
    const fmax = Math.max(1, ...steps.map((s) => s[1]));
    const funnelHtml = `<div class="funnel">${steps.map(([label, v], i) => {
      const prevV = i ? steps[i - 1][1] : null;
      const rate = i && prevV > 0 ? `${((v / prevV) * 100).toFixed(1)}% of ${steps[i - 1][0].toLowerCase()}` : i ? DASH : 'link opens';
      return `<div class="fstep"><div class="fhead"><span class="fl">${esc(label)}</span><span class="fv">${esc(fmtInt(v))}</span></div><div class="fbar">${bar(v, fmax)}</div><div class="frate">${esc(rate)}</div></div>`;
    }).join('')}</div>`;
    const funnelCard = card({ title: 'Funnel', sub: 'This period, all sources', body: funnelHtml });

    const perf = Q.campaignPerf(db, { brandId, start: range.start, end: range.end, fromDay: range.fromDay, toDay: range.toDay });
    const top = perf.rows.filter((r) => !r.is_none && (r.revenue > 0 || r.ftds > 0)).sort((a, b) => (b.revenue - a.revenue) || (b.ftds - a.ftds)).slice(0, 5);
    const tmax = Math.max(0, ...top.map((r) => r.revenue));
    const topCard = card({
      title: 'Top campaigns', sub: 'By matched revenue', actions: `<a class="btn sm ghost" href="${esc(url('/dash/campaigns', params))}">All${icon('right')}</a>`,
      body: top.length
        ? `<div class="rank">${top.map((r) => `<div class="r"><span class="name">${esc([r.campaign, r.ad].filter(Boolean).join(' / '))}</span><span class="val">${esc(fmtMoney(r.revenue))}<small>${esc(fmtInt(r.ftds))} FTD${r.ftds === 1 ? '' : 's'}</small></span>${bar(r.revenue, tmax)}</div>`).join('')}</div>`
        : emptyState({ ico: 'chart', text: 'No campaign revenue in this period.' })
    });

    const events = Q.lastEvents(db, { brandId, limit: 8 });
    const feed = events.length
      ? `<div class="feed">${events.map((e) => {
        const amt = e.amount !== null && e.kind !== 'reg' && e.kind !== 'ignored' ? fmtMoney(e.amount, e.currency) : '';
        const st2 = e.state === 'matched' ? `matched · ${e.path || ''}` : e.state === 'ignored' ? `ignored · ${e.ignore_reason || ''}` : e.state;
        const what = amt || (e.kind === 'reg' ? 'Registration' : e.kind === 'ignored' ? 'Ignored' : kindLabel(e.kind));
        return `<a href="/dash/events/${esc(encodeURIComponent(e.event_id))}">${kindBadge(e.kind)}<span class="t"><b>${esc(what)}</b> <span class="muted">${esc(e.trader_id || DASH)}</span>`
          + `<small>${esc(st2)}${e.username ? ` · @${esc(e.username)}` : ''}</small></span><time title="${esc(fmtTime(e.received_at))}">${esc(fmtAgo(e.received_at, now))}</time></a>`;
      }).join('')}</div>`
      : emptyState({ ico: 'activity', text: 'No events yet.' });
    const feedCard = card({ title: 'Latest events', actions: `<a class="btn sm ghost" href="/dash/events">All${icon('right')}</a>`, flush: true, body: feed });

    // Phase 6: the bot snapshot behind trader-id matching is stale — say so here, and only here.
    let snap = null;
    try { snap = snapshotHealth(deps.snapshot, now, config.snapshotStaleMinutes); } catch { snap = { stale: true, available: false, age_s: null }; }
    const staleStrip = !snap.stale ? ''
      : `<div class="banner warn">${icon('alert')}<div><span data-snapshot-stale="1">${esc(!snap.available
        ? `Bot snapshot unavailable${snap.age_s === null ? '' : ` — last sync ${fmtAge(snap.age_s)} ago`}. Broker-id matching cannot see new accounts, so their postbacks park.`
        : snap.age_s === null ? 'Bot snapshot has no sync time. Broker-id matching may be using old data.'
          : `Bot snapshot is ${fmtAge(snap.age_s)} old (limit ${config.snapshotStaleMinutes} min). Broker-id matching cannot see newer accounts, so their postbacks park.`)}</span> `
        + '<span class="muted">Check the sync timer (docs/07 §5).</span></div></div>';

    const empty = !Q.hasAnyTraffic(db, brandId)
      ? `<div class="banner">${icon('info')}<div><span>No traffic recorded yet. Create a link on the Links screen.</span></div><span class="grow"></span><a class="btn sm primary" href="/dash/links#new-link">${icon('plus')}Create link</a></div>` : '';

    const live = lastAt !== null && now - lastAt < 3600000;
    const sub = `${rangeSub(range)}<span class="dot"></span><span class="live${live ? '' : ' idle'}">last event ${esc(fmtAgo(lastAt, now))}</span>`;
    const body = pageHead({ title: 'Overview', sub, actions: `${brandSeg('/dash', params)}${periodSeg('/dash', params, range)}` })
      + staleStrip + empty
      + `<div class="tiles">${funnelTiles}</div>`
      + `<div class="grid g-main section">${chartCard}<div class="stack">${attnCard}${qualityCard}</div></div>`
      + `<div class="section"><div class="section-head"><h2>Money</h2><span class="muted">USD; other currencies are listed, never added in</span></div><div class="tiles">${moneyTiles}</div></div>`
      + `<div class="grid g3 section">${funnelCard}${topCard}${feedCard}</div>`;
    page(res, { title: 'Overview', active: 'overview', body, status });
  }

  // ---------- /dash/members ----------
  function members({ req, res, query }) {
    requireAdmin(req, config);
    const now = deps.now();
    const brandCode = query.get('brand') || 'all';
    const f = {
      q: (query.get('q') || '').slice(0, 100), brandId: Q.resolveBrandId(db, brandCode),
      ftd: query.get('ftd') === 'has' || query.get('ftd') === 'no' ? query.get('ftd') : '',
      sort: query.get('sort') || 'total', dir: query.get('dir') === 'asc' ? 'asc' : 'desc',
      from: query.get('from') || '', to: query.get('to') || ''
    };
    const fromMs = f.from ? Q.dayStartMs(f.from) : null;
    const toDay = f.to ? Q.dayStartMs(f.to) : null;
    if ((f.from && fromMs === null) || (f.to && toDay === null)) throw new HttpError(400, 'bad_params', 'from/to must be YYYY-MM-DD');
    const r = Q.listMembers(db, {
      ...f, fromMs, toMs: toDay === null ? null : toDay + 86400000, page: Q.parsePage(query.get('page')), limit: PAGE, snapshot: deps.snapshot
    });
    const base = { q: f.q, brand: brandCode === 'all' ? '' : brandCode, ftd: f.ftd, from: f.from, to: f.to };
    const sortLink = (key, label, cls = '') => {
      const on = r.sort === key;
      const nextDir = on && r.dir === 'desc' ? 'asc' : 'desc';
      return `<th class="${cls}"${on ? ` aria-sort="${r.dir === 'desc' ? 'descending' : 'ascending'}"` : ''}><a${on ? ' class="on"' : ''} href="${esc(url('/dash/members', { ...base, sort: key, dir: nextDir }))}">${esc(label)}${on ? (r.dir === 'desc' ? ' ↓' : ' ↑') : ''}</a></th>`;
    };
    const head = `${sortLink('joined', 'Joined')}<th>Member</th><th>Source</th><th>Broker id</th>`
      + `<th class="n">FTD</th><th class="n">Re-deposits</th>${sortLink('total', 'Total', 'n')}${sortLink('last_event', 'Last event')}<th>Path</th>`;
    const rows = r.rows.map((mm) => `<tr data-href="/dash/members/${esc(mm.id)}"><td class="muted">${esc(fmtTime(mm.joined_at))}</td>`
      + `<td><div class="cell-member">${avatar(mm.telegram_id, mm.username || mm.first_name || String(mm.telegram_id))}<span class="t">`
      + (mm.username || mm.first_name
        ? `<a class="link" href="/dash/members/${esc(mm.id)}">${mm.username ? `@${esc(mm.username)}` : esc(mm.first_name)}</a><small>${esc(mm.telegram_id)}</small>`
        : `<a class="link" href="/dash/members/${esc(mm.id)}">${esc(mm.telegram_id)}</a><small>no username</small>`)
      + '</span></div></td>'
      + `<td><span class="chip">${esc(memberSource(mm))}</span></td><td class="mono">${esc(mm.iq_user_id || DASH)}</td>`
      + `<td class="n">${mm.ftd_count ? esc(fmtMoney(mm.ftd)) : DASH}</td>`
      + `<td class="n">${mm.dep_count ? `${esc(fmtMoney(mm.redep))} <span class="muted">×${esc(mm.dep_count)}</span>` : DASH}</td>`
      + `<td class="n"><b>${mm.total ? esc(fmtMoney(mm.total)) : (mm.ftd_count || mm.dep_count ? esc(fmtMoney(0)) : DASH)}</b>${otherMoney(mm.other_currencies)}</td>`
      + `<td title="${esc(mm.last_event_at ? fmtTime(mm.last_event_at) : '')}">${esc(mm.last_event_at ? fmtAgo(mm.last_event_at, now) : DASH)}</td>`
      + `<td>${mm.path && mm.path !== 'none' ? `<span class="chip path">${esc(mm.path)}</span>` : DASH}</td></tr>`);
    const brandOpts = ['all', ...Q.listBrands(db).map((b) => b.code)].map((c) => `<option value="${esc(c)}"${c === brandCode ? ' selected' : ''}>${esc(c === 'all' ? 'All brands' : c)}</option>`).join('');
    const filtered = !!(f.q || f.ftd || f.from || f.to || brandCode !== 'all');
    const filters = '<form class="toolbar" method="get" action="/dash/members">'
      + `<label class="field q"><span>Search</span><span class="search">${icon('search')}<input type="search" name="q" value="${esc(f.q)}" placeholder="Telegram id, @username, name or broker id"></span></label>`
      + `<label class="field"><span>Brand</span><select name="brand" data-autosubmit>${brandOpts}</select></label>`
      + `<label class="field"><span>Deposits</span><select name="ftd" data-autosubmit><option value="">Anyone</option><option value="has"${f.ftd === 'has' ? ' selected' : ''}>Has an FTD</option><option value="no"${f.ftd === 'no' ? ' selected' : ''}>No FTD yet</option></select></label>`
      + `<label class="field"><span>Joined from</span><input type="date" name="from" value="${esc(f.from)}"></label><label class="field"><span>to</span><input type="date" name="to" value="${esc(f.to)}"></label>`
      + `<input type="hidden" name="sort" value="${esc(r.sort)}"><input type="hidden" name="dir" value="${esc(r.dir)}">`
      + `<button class="btn primary" type="submit">${icon('filter')}Filter</button>${filtered ? '<a class="btn ghost" href="/dash/members">Clear</a>' : ''}</form>`;
    const exportBtn = `<a class="btn" href="${esc(url('/api/export/members.csv', { brand: base.brand, period: 'all' }))}">${icon('download')}Export CSV</a>`;
    const sortName = { joined: 'join time', total: 'total deposits', last_event: 'last event' }[r.sort];
    const body = pageHead({ title: 'Members', sub: `${esc(fmtInt(r.total))} found<span class="dot"></span>sorted by ${esc(sortName)}`, actions: exportBtn })
      + filters
      + table(head, rows, filtered ? 'No members match these filters.' : 'No members yet. They appear here as the gate bots report joins.')
      + pagination({ path: '/dash/members', params: { ...base, sort: r.sort, dir: r.dir }, page: r.page, limit: PAGE, total: r.total });
    page(res, { title: 'Members', active: 'members', body });
  }

  // ---------- /dash/members/:id ----------
  function memberPage({ req, res, params }) {
    requireAdmin(req, config);
    const now = deps.now();
    const id = Number(params.id);
    const d = Number.isSafeInteger(id) && id > 0 ? Q.memberDetail(db, id) : null;
    if (!d) throw new HttpError(404, 'not_found', 'no such member');
    const mm = d.member;
    const kv = (k, v) => `<div class="k">${esc(k)}</div><div>${v}</div>`;
    const accounts = d.accounts.length ? d.accounts.map((a) => `<span class="mono">${esc(a.iq_user_id)}</span> <span class="faint">${esc(a.source)}</span>`).join('<br>') : DASH;
    const sum = (k) => d.value.map((v) => esc(fmtMoney(v[k], v.currency))).join(' · ') || esc(fmtMoney(0));
    const eventCount = d.value.reduce((a, v) => a + v.events, 0);
    const lastEv = d.value.reduce((a, v) => Math.max(a, v.last_event_at || 0), 0);
    const offer = mm.offer_link_tpl ? mm.offer_link_tpl.replace(/\{AFFTRACK\}/g, String(mm.telegram_id)) : null;

    const profile = `<section class="card profile">${avatar(mm.telegram_id, mm.first_name || mm.username || String(mm.telegram_id), 'lg')}`
      + `<div class="who-big"><h1>${esc(mm.first_name || memberLabel(mm))}</h1><div class="meta">${mm.first_name && mm.username ? `<span>@${esc(mm.username)}</span>` : ''}`
      + `${copyInline(mm.telegram_id, 'Copy Telegram id')}${tag('on', mm.brand_code)}<span>Joined ${esc(fmtTime(mm.joined_at))}</span><span class="chip">${esc(memberSource(mm))}</span></div></div>`
      + `<div class="actions"><a class="btn" href="${esc(url('/dash/events', { member: mm.id }))}">${icon('activity')}Open raw events</a></div></section>`;

    const tiles = `<div class="tiles section">${[
      tile('Lifetime total', d.value.some((v) => v.total) ? sum('total') : DASH, 'matched ftd + dep'),
      tile('FTD total', d.value.some((v) => v.ftd) ? sum('ftd') : DASH, ''),
      tile('Re-deposit total', d.value.some((v) => v.redep) ? sum('redep') : DASH, ''),
      tile('Events', esc(fmtInt(eventCount)), 'matched'),
      tile('Last event', esc(lastEv ? fmtAgo(lastEv, now) : DASH), esc(lastEv ? fmtTime(lastEv) : '')),
      tile('Broker accounts', esc(fmtInt(d.accounts.length)), d.accounts.length ? '' : 'none linked yet')
    ].join('')}</div>`;

    const identity = card({ title: 'Identity', body: '<div class="kv">'
      + kv('Telegram id', copyInline(mm.telegram_id, 'Copy Telegram id'))
      + kv('Username', mm.username ? `@${esc(mm.username)}` : DASH)
      + kv('First name', mm.first_name ? esc(mm.first_name) : DASH)
      + kv('Brand', esc(mm.brand_code))
      + kv('Joined', esc(fmtTime(mm.joined_at)))
      + kv('Join source', `<span class="mono">${esc(mm.join_source)}</span>`)
      + kv('Last seen', esc(mm.last_seen_at ? fmtTime(mm.last_seen_at) : DASH))
      + kv('Broker id', accounts)
      + '</div>' });

    const clickBlock = mm.click_id
      ? `<div class="kv">${kv('Campaign', esc(mm.campaign || DASH))}${kv('Ad set', esc(mm.adset || DASH))}${kv('Ad', esc(mm.ad || DASH))}${kv('Creative', esc(mm.creative || DASH))}`
        + kv('Link token', `<code>${esc(mm.click_id)}</code>`)
        + kv('Click ids', esc(`ttclid ${mm.has_ttclid ? 'yes' : 'no'} · fbclid ${mm.has_fbclid ? 'yes' : 'no'} · gclid ${mm.has_gclid ? 'yes' : 'no'}`))
        + kv('Last opened', esc(mm.clicked_at ? fmtTime(mm.clicked_at) : DASH)) + '</div>'
        + '<p class="notes">The token is per ad, not per person: other members can carry it too.</p>'
      : `<p class="muted">${esc(memberSource({ ...mm }))} — no ad link on this member.</p>`;
    const clickCard = card({ title: 'Click context', body: clickBlock });

    const offerCard = card({ title: 'Offer link', sub: 'Their Telegram id filled in as afftrack', body: offer
      ? copyField(offer, 'Copy offer link') : '<p class="muted">no offer link template for this brand</p>' });

    const trail = d.trail.length
      ? `<ul class="timeline">${d.trail.map((e) => `<li class="${esc(e.kind)}">${kindBadge(e.kind)}<div class="t">`
        + `<b>${e.kind === 'reg' ? 'Registration' : esc(money(e.amount, e.currency))}</b> <span class="muted">via</span> <span class="chip path">${esc(e.path || DASH)}</span>`
        + `${e.confidence === null || e.confidence === undefined ? '' : ` <span class="faint">confidence ${esc(e.confidence)}</span>`}`
        + `<small>${e.note ? `${esc(e.note)} · ` : ''}<a href="/dash/events/${esc(encodeURIComponent(e.event_id))}">raw event</a></small></div>`
        + `<time>${esc(fmtTime(e.received_at))}</time></li>`).join('')}</ul>`
      : emptyState({ ico: 'activity', text: 'No events for this member.' });
    const trailCard = card({ title: 'Event trail', sub: d.trail.length >= 200 ? 'Showing the latest 200' : 'Newest first', flush: true, body: trail });

    const body = `<nav class="crumbs" aria-label="breadcrumb"><a href="/dash/members">Members</a>${icon('right', 'sep')}<span>${esc(memberLabel(mm))}</span></nav>`
      + profile + tiles
      + `<div class="grid g-side top section"><div class="stack">${trailCard}</div><div class="stack">${identity}${clickCard}${offerCard}</div></div>`;
    page(res, { title: `Member ${mm.telegram_id}`, active: 'members', body });
  }

  // ---------- /dash/events ----------
  function attachForm(e, back, { open = false } = {}) {
    return `<details class="disclose"${open ? ' open' : ''}><summary>${icon('right')}Attach to a member</summary>`
      + `<form class="attach" method="post" action="/dash/events/${esc(encodeURIComponent(e.event_id))}/attach"><div class="form-grid">`
      + '<label class="field"><span>Member</span><input name="member" placeholder="Telegram id or @username" required></label>'
      + '<label class="field wide"><span>Note <span class="hint">(required, kept in the log)</span></span><input name="note" placeholder="Why this member" required></label></div>'
      + (e.trader_id ? `<label class="check"><input type="checkbox" name="link" value="1"> also link broker id ${esc(e.trader_id)} to this member</label>` : '')
      + `<input type="hidden" name="back" value="${esc(back)}"><div class="form-actions"><button class="btn primary sm" type="submit">${icon('check')}Attach</button>`
      + '<span class="faint">Path becomes <code>manual</code> at confidence 100.</span></div></form></details>';
  }

  function logText(lines) {
    return lines.length ? lines.map((l) => `${fmtTime(l.created_at)}  ${l.reason}${l.candidate ? `  [${l.candidate}]` : ''}`).join('\n') : '(no log lines)';
  }

  function eventsPage({ req, res, query }) {
    requireAdmin(req, config);
    const now = deps.now();
    const tab = EVENT_TABS.some((t) => t[0] === query.get('tab')) ? query.get('tab') : 'all';
    const state = EVENT_TABS.find((t) => t[0] === tab)[2];
    const brandCode = query.get('brand') || 'all';
    const brandId = Q.resolveBrandId(db, brandCode);
    const memberId = Number(query.get('member')) || null;
    const q = (query.get('q') || '').slice(0, 100);
    const r = Q.listEvents(db, { state, brandId, memberId, q, page: Q.parsePage(query.get('page')), limit: PAGE });
    const counts = Q.eventStateCounts(db, { brandId, memberId, q });
    const base = { tab: tab === 'all' ? '' : tab, brand: brandCode === 'all' ? '' : brandCode, member: memberId, q };
    const tabs = seg(EVENT_TABS.map(([k, label]) => [k, label, url('/dash/events', { ...base, tab: k === 'all' ? '' : k, page: '' }),
      ` <span class="n">${esc(fmtCompact(k === 'all' ? counts.all : counts[k] || 0))}</span>`]), tab, 'State');

    const head = '<th>Received</th><th>Kind</th><th class="n">Amount</th><th>Trader id</th><th>Afftrack</th><th>Country</th><th>State</th><th>Path</th><th>Member</th>';
    const back = url('/dash/events', { ...base, page: r.page === 1 ? '' : r.page });
    const rows = [];
    for (const e of r.rows) {
      const pathCell = e.state === 'parked' ? `<span class="muted">${esc(Q.parkedReasons(e).join(' · '))}</span>`
        : e.state === 'ignored' ? `<span class="muted">${esc(e.ignore_reason || DASH)}</span>`
          : e.state === 'expired' ? '<span class="muted">expired</span>' : e.path ? `<span class="chip path">${esc(e.path)}</span>` : DASH;
      rows.push(`<tr id="ev-${esc(e.event_id)}" data-href="/dash/events/${esc(encodeURIComponent(e.event_id))}"><td class="muted" title="${esc(fmtAgo(e.received_at, now))}">${esc(fmtTime(e.received_at))}</td><td>${kindBadge(e.kind)}</td>`
        + `<td class="n"><b>${esc(money(e.amount, e.currency))}</b></td>`
        + `<td class="mono">${esc(e.trader_id || DASH)}</td><td class="mono">${esc(e.aff_track || DASH)}</td><td>${esc(e.country || DASH)}</td>`
        + `<td>${tag(e.state)}</td><td>${pathCell}</td>`
        + `<td>${e.matched_member_id ? `<a class="link" href="/dash/members/${esc(e.matched_member_id)}">${esc(memberLabel(e))}</a>` : DASH}</td></tr>`);
      // A parked event can be acted on from the list: attach it, with its payload and log at hand. Every other row
      // opens the event page, which shows the same payload and log.
      if (e.state === 'parked') {
        rows.push(`<tr class="detail"><td colspan="9"><div class="row-actions">${attachForm(e, back)}`
          + `<details class="disclose"><summary>${icon('right')}Raw payload &amp; log (${esc(e.log.length)})</summary><div class="detail-grid">`
          + `<div><h4>Payload</h4><pre>${esc(prettyPayload(e.payload_json))}</pre></div><div><h4>Attribution log</h4><pre>${esc(logText(e.log))}</pre></div></div></details></div></td></tr>`);
      }
    }
    const filter = `<form class="toolbar" method="get" action="/dash/events"><input type="hidden" name="tab" value="${esc(base.tab)}">`
      + `${base.brand ? `<input type="hidden" name="brand" value="${esc(base.brand)}">` : ''}${memberId ? `<input type="hidden" name="member" value="${esc(memberId)}">` : ''}`
      + `<label class="field q"><span>Search</span><span class="search">${icon('search')}<input type="search" name="q" value="${esc(q)}" placeholder="Trader id, afftrack or event id"></span></label>`
      + `<button class="btn primary" type="submit">Search</button>${q || memberId ? `<a class="btn ghost" href="${esc(url('/dash/events', { tab: base.tab, brand: base.brand }))}">Clear</a>` : ''}</form>`;
    const exportBtn = `<a class="btn" href="${esc(url('/api/export/events.csv', { brand: base.brand, period: '30d' }))}">${icon('download')}Export CSV <span class="faint">30 days</span></a>`;
    const sub = `${esc(fmtInt(r.total))} events${memberId ? `<span class="dot"></span>member ${esc(memberId)}` : ''}${tab === 'parked' ? '<span class="dot"></span>waiting for a member; matched automatically when one appears' : ''}`;
    const empty = { all: 'No events yet. Postbacks from the network appear here.', parked: 'Nothing parked. Every recent postback found its member.', matched: 'No matched events.', expired: 'No expired events.', ignored: 'No ignored events.' }[tab];
    const body = `${noticeHtml(query.get('notice'))}`
      + pageHead({ title: 'Events', sub, actions: `${brandSeg('/dash/events', base)}${exportBtn}` })
      + `<div class="toolbar">${tabs}</div>${filter}`
      + table(head, rows, q ? 'No events match that search.' : empty)
      + pagination({ path: '/dash/events', params: base, page: r.page, limit: PAGE, total: r.total });
    page(res, { title: 'Events', active: 'events', body });
  }

  function eventPage({ req, res, params, query }) {
    requireAdmin(req, config);
    const now = deps.now();
    const e = Q.eventDetail(db, params.id);
    if (!e) throw new HttpError(404, 'not_found', 'no such event');
    const kv = (k, v) => `<div class="k">${esc(k)}</div><div>${v}</div>`;
    const info = card({ title: 'Details', body: `<div class="kv">${kv('Event id', copyInline(e.event_id, 'Copy event id'))}${kv('Received', `${esc(fmtTime(e.received_at))} <span class="faint">${esc(fmtAgo(e.received_at, now))}</span>`)}${kv('Kind', kindBadge(e.kind))}`
      + kv('Amount', e.amount === null ? DASH : `<b>${esc(fmtMoney(e.amount, e.currency))}</b>`) + kv('Trader id', `<span class="mono">${esc(e.trader_id || DASH)}</span>`) + kv('Afftrack', `<span class="mono">${esc(e.aff_track || DASH)}</span>`)
      + kv('Click id', e.click_id ? `<code>${esc(e.click_id)}</code>` : DASH) + kv('Country', esc(e.country || DASH))
      + kv('State', `${tag(e.state)}${e.ignore_reason ? ` <span class="muted">${esc(e.ignore_reason)}</span>` : ''}`)
      + kv('Path', e.path ? `<span class="chip path">${esc(e.path)}</span> <span class="faint">confidence ${esc(e.confidence)}</span>` : DASH) + (e.attribution_note ? kv('Note', esc(e.attribution_note)) : '')
      + kv('Member', e.matched_member_id ? `<a class="link" href="/dash/members/${esc(e.matched_member_id)}">${esc(memberLabel(e))}</a>` : DASH)
      + kv('Joinvoo forward', esc(`${e.forward_state}${e.forward_tries ? ` · ${e.forward_tries} tries` : ''}`)) + '</div>' });
    const reasons = e.state === 'parked' ? `<div class="banner warn">${icon('inbox')}<div><b>Parked</b> — ${esc(Q.parkedReasons(e).join(' · '))}. <span class="muted">Re-tried every minute for ${esc(config.parkHours)} h; attach it by hand if you know the member.</span></div></div>` : '';
    const attach = e.state === 'parked' ? card({ title: 'Attach to a member', body: attachForm(e, `/dash/events/${encodeURIComponent(e.event_id)}`, { open: true }) }) : '';
    const title = `${kindLabel(e.kind)}${e.amount !== null && e.kind !== 'reg' && e.kind !== 'ignored' ? ` · ${fmtMoney(e.amount, e.currency)}` : ''}`;
    const body = `${noticeHtml(query.get('notice'))}<nav class="crumbs" aria-label="breadcrumb"><a href="/dash/events">Events</a>${icon('right', 'sep')}<span class="mono">${esc(e.event_id)}</span></nav>`
      + pageHead({ title, sub: `${tag(e.state)}<span class="dot"></span>${esc(fmtTime(e.received_at))}` })
      + reasons
      + `<div class="grid g2 top">${info}<div class="stack">${attach}${card({ title: 'Attribution log', body: `<pre>${esc(logText(e.log))}</pre>` })}`
      + `${card({ title: 'Raw payload', sub: 'Keys that look like IPs or secrets are redacted', body: `<pre>${esc(prettyPayload(e.payload_json))}</pre>` })}</div></div>`;
    page(res, { title: 'Event', active: 'events', body });
  }

  // POST /dash/events/:id/attach — the form path of POST /api/events/:id/attach.
  async function attachPost({ req, res, params }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const form = await readForm(req);
    const back = form.get('back') || '';
    const dest = (code) => {
      const u = new URL(safeBack(back, '/dash/events', '/dash/events?tab=parked'), 'http://x');
      u.searchParams.set('notice', code);
      return `${u.pathname}${u.search}`;
    };
    const ev = db.prepare('SELECT brand_id FROM events WHERE event_id = ?').get(params.id);
    if (!ev) return redirect(res, dest('not_found'));
    const cands = Q.findMemberCandidates(db, { q: form.get('member'), brandId: ev.brand_id });
    if (cands.length === 0) return redirect(res, dest('no_member'));
    if (cands.length > 1) return redirect(res, dest('ambiguous_member'));
    try {
      const r = Q.attachEvent(deps, { eventId: params.id, memberId: cands[0].id, note: form.get('note'), link: form.get('link') === '1' });
      if (r.linked) return redirect(res, dest('attached_linked'));
    } catch (e) {
      if (e instanceof HttpError) {
        const noteProblem = e.code === 'bad_params' && /note/.test(e.detail);
        return redirect(res, dest(noteProblem ? 'note_required' : (NOTICES[e.code] ? e.code : 'bad_params')));
      }
      throw e;
    }
    return redirect(res, dest('attached'));
  }

  // ---------- /dash/links ----------
  function linksPage({ req, res, query }) {
    requireAdmin(req, config);
    const now = deps.now();
    const brandCode = query.get('brand') || 'all';
    const q = (query.get('q') || '').slice(0, 100);
    const r = Q.listClicks(db, { brandId: Q.resolveBrandId(db, brandCode), campaign: query.get('campaign') || '', q, page: Q.parsePage(query.get('page')), limit: PAGE });
    let minted = '';
    const token = query.get('minted');
    if (token) {
      const row = db.prepare('SELECT c.click_id, b.bot_username, b.code FROM clicks c JOIN brands b ON b.id = c.brand_id WHERE c.click_id = ?').get(token);
      if (row) {
        const u = linkUrls(config, { bot_username: row.bot_username }, row.click_id);
        minted = `<div class="flash ok" role="status">${icon('ok')}<div><b>Link created</b> <span class="muted">(${esc(row.code)})</span>`
          + `<div class="copy-row"><span class="copy-label">Short link — put this in the ad</span>${copyField(u.url)}</div>`
          + `<div class="copy-row"><span class="copy-label">Destination</span>${copyField(u.telegram_url)}</div></div></div>`;
      }
    }
    const brands = Q.listBrands(db).filter((b) => b.active);
    const form = '<form method="post" action="/dash/links"><div class="form-grid">'
      + `<label class="field"><span>Brand</span><select name="brand">${brands.map((b) => `<option value="${esc(b.code)}">${esc(b.code)}</option>`).join('')}</select></label>`
      + '<label class="field"><span>Campaign</span><input name="campaign" maxlength="200" placeholder="NG_Broad"></label><label class="field"><span>Ad set</span><input name="adset" maxlength="200" placeholder="18-34"></label>'
      + '<label class="field"><span>Ad</span><input name="ad" maxlength="200" placeholder="vid_03"></label><label class="field"><span>Creative</span><input name="creative" maxlength="200" placeholder="v3"></label></div>'
      + `<div class="form-actions"><button class="btn primary" type="submit">${icon('plus')}Create link</button><span class="faint">One link per ad; every open is counted.</span></div></form>`;
    const goParams = 'campaign_name={{campaign.name}}&adset_name={{adset.name}}&ad_name={{ad.name}}&placement={{placement}}&site_source_name={{site_source_name}}';
    const goBody = brands.map((b) => `<div class="copy-row"><span class="copy-label">${esc(b.code)} — CTA base URL</span>${copyField(`${config.publicBase}/go/${b.code}`)}</div>`).join('')
      + `<div class="copy-row"><span class="copy-label">Meta URL parameters (Ads Manager → Tracking → URL parameters)</span>${copyField(goParams)}</div>`
      + '<p class="notes">The landing page passes its own query string on to the CTA link. Every visit to <code>/go</code> mints its own click, so each visitor keeps their own fbclid.</p>';
    const head = '<th>Created</th><th>Token</th><th>Campaign / ad set / ad</th><th>Click ids</th><th>Last opened</th><th class="n">Opens</th><th class="n">Joins</th>';
    const rows = r.rows.map((c) => `<tr><td class="muted">${esc(fmtTime(c.created_at))}</td><td><code>${esc(c.click_id)}</code></td>`
      + `<td>${esc([c.campaign, c.adset, c.ad].filter(Boolean).join(' / ') || DASH)}</td>`
      + `<td>${[c.has_ttclid && 'ttclid', c.has_fbclid && 'fbclid', c.has_gclid && 'gclid'].filter(Boolean).map((x) => `<span class="chip">${esc(x)}</span>`).join(' ') || DASH}</td>`
      + `<td title="${esc(c.clicked_at ? fmtTime(c.clicked_at) : '')}">${esc(c.clicked_at ? fmtAgo(c.clicked_at, now) : 'never')}</td><td class="n">${esc(fmtInt(c.opens))}</td><td class="n">${esc(fmtInt(c.joins))}</td></tr>`);
    const search = `<form class="toolbar" method="get" action="/dash/links">${brandCode !== 'all' ? `<input type="hidden" name="brand" value="${esc(brandCode)}">` : ''}`
      + `<label class="field q"><span>Search links</span><span class="search">${icon('search')}<input type="search" name="q" value="${esc(q)}" placeholder="Token, campaign, ad set or ad"></span></label>`
      + `<button class="btn primary" type="submit">Search</button>${q ? `<a class="btn ghost" href="${esc(url('/dash/links', { brand: brandCode === 'all' ? '' : brandCode }))}">Clear</a>` : ''}</form>`;
    const body = minted
      + pageHead({ title: 'Links', sub: `${esc(fmtInt(r.total))} links<span class="dot"></span>ad links and the landing-page entry`, actions: brandSeg('/dash/links', { brand: brandCode === 'all' ? '' : brandCode, q }) })
      + `<div class="grid g2">${card({ title: 'Create an ad link', sub: 'For an ad that sends people straight to the bot', body: form, id: 'new-link' })}`
      + `${card({ title: 'Landing-page CTA', sub: 'For landing pages: one click minted per visit', body: goBody })}</div>`
      + `<div class="section"><div class="section-head"><h2>Links</h2></div>${search}`
      + table(head, rows, q ? 'No links match that search.' : 'No links yet.')
      + pagination({ path: '/dash/links', params: { brand: brandCode === 'all' ? '' : brandCode, q }, page: r.page, limit: PAGE, total: r.total }) + '</div>';
    page(res, { title: 'Links', active: 'links', body });
  }

  async function linksCreate({ req, res }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const form = await readForm(req);
    const field = (k) => {
      const v = (form.get(k) || '').trim();
      if (v.length > 200) throw new HttpError(400, 'bad_params', `${k} is longer than 200 characters`);
      return v === '' ? null : v;
    };
    const brand = (form.get('brand') || '').trim();
    const minted = mintLink(db, { brand, campaign: field('campaign'), adset: field('adset'), ad: field('ad'), creative: field('creative') });
    if (!minted) throw new HttpError(422, 'unknown_brand', `no active brand "${brand}"`);
    log.info('link', { token: minted.token, brand: minted.brand.code, campaign: form.get('campaign') });
    redirect(res, `/dash/links?minted=${encodeURIComponent(minted.token)}`);
  }

  // ---------- /dash/ad-links (Phase 13) ----------
  // Saved ad links: create, copy the link and the tags, edit, switch on and off. Plain forms throughout, so the
  // screen works with JavaScript off; the copy buttons are a convenience over fields that can be selected by hand.
  function adLinksPage({ req, res, query }) {
    requireAdmin(req, config);
    const links = listAdLinks(deps, { activeFirst: false });
    const brands = Q.listBrands(db).filter((b) => b.active);
    const brandField = brands.length > 1
      ? `<label class="field"><span>Brand</span><select name="brand">${brands.map((b) => `<option value="${esc(b.code)}">${esc(b.code)}</option>`).join('')}</select></label>`
      : `<input type="hidden" name="brand" value="${esc(brands[0] ? brands[0].code : config.defaultBrand)}">`;
    const fields = (l = {}) => `<label class="field wide"><span>Label</span><input name="label" required maxlength="200" value="${esc(l.label || '')}" placeholder="Lagos broad — video 3"></label>`
      + `<label class="field"><span>Campaign <span class="hint">optional</span></span><input name="campaign" maxlength="200" value="${esc(l.campaign || '')}" placeholder="NG_Broad"></label>`
      + `<label class="field"><span>Ad set <span class="hint">optional</span></span><input name="adset" maxlength="200" value="${esc(l.adset || '')}" placeholder="18-34"></label>`
      + `<label class="field"><span>Ad <span class="hint">optional</span></span><input name="ad" maxlength="200" value="${esc(l.ad || '')}" placeholder="vid_03"></label>`;
    const createForm = `<form method="post" action="/dash/ad-links"><div class="form-grid">${brandField}${fields()}</div>`
      + `<div class="form-actions"><button class="btn primary" type="submit">${icon('plus')}Create link</button></div></form>`;

    const head = '<th>Code</th><th>Label</th><th>Campaign</th><th>Active</th><th class="n">Clicks</th><th class="n">Joins</th><th>Link</th><th class="n"><span class="sr">Actions</span></th>';
    const rows = [];
    for (const l of links) {
      const u = adLinkUrls(config, l.code);
      const toggle = `<form class="inline-form" method="post" action="/dash/ad-links/${esc(l.id)}/toggle"${l.active ? ' data-confirm="Switch this link off? Anyone who opens it (a running ad) will get the not-found page."' : ''}>`
        + `<input type="hidden" name="active" value="${l.active ? '0' : '1'}"><button class="btn sm" type="submit">${l.active ? 'Switch off' : 'Switch on'}</button></form>`;
      rows.push(`<tr data-adlink="${esc(l.code)}"><td><code>${esc(l.code)}</code></td><td>${esc(l.label || DASH)}</td><td>${esc(l.campaign || DASH)}</td>`
        + `<td>${l.active ? tag('on', 'on') : tag('off', 'off')}</td>`
        + `<td class="n" data-col="clicks">${esc(fmtInt(l.stats.clicks))}</td><td class="n" data-col="joins">${esc(fmtInt(l.stats.joins))}</td>`
        + `<td>${copyField(u.url, 'Copy link')}</td>`
        + `<td class="n"><button type="button" class="btn sm" data-copy="${esc(M_PARAM)}">${icon('copy')}<span>Copy tags</span></button>${toggle}</td></tr>`);
      rows.push(`<tr class="detail"><td colspan="8"><details class="disclose"><summary>${icon('right')}Edit · tags</summary><div class="detail-grid">`
        + `<form method="post" action="/dash/ad-links/${esc(l.id)}"><div class="form-grid">${fields(l)}</div>`
        + `<div class="form-actions"><button class="btn primary sm" type="submit">${icon('check')}Save</button><span class="faint">The code and the link never change.</span></div></form>`
        + `<div><h4>URL parameters</h4><code class="tagblock">${esc(M_PARAM)}</code><h4>The link as Meta will open it</h4><code class="tagblock">${esc(u.template)}</code></div>`
        + '</div></details></td></tr>');
    }
    const tagsCard = card({ title: 'Tags for Meta', sub: 'The same for every link: Meta fills in the ids per ad', body:
      `<code class="tagblock">${esc(M_PARAM)}</code><div class="form-actions"><button type="button" class="btn sm" data-copy="${esc(M_PARAM)}">${icon('copy')}<span>Copy tags</span></button></div>`
      + '<p class="notes">Each visit records the ad id, ad set id, campaign id and placement on its click. Campaign, ad set and ad names come from the link above (or from the ad, when it sends them).</p>' });
    const body = `${noticeHtml(query.get('notice'))}`
      + pageHead({ title: 'Ad links', sub: `${esc(fmtInt(links.length))} link${links.length === 1 ? '' : 's'}<span class="dot"></span>every visit gets its own channel invite` })
      + `<div class="grid g2 top">${card({ title: 'New ad link', id: 'new-ad-link', body: createForm })}${tagsCard}</div>`
      + `<div class="section">${table(head, rows, 'No ad links yet. Create the first one above.', { cls: 'adlinks' })}`
      + '<p class="notes">Paste the link into the ad\'s destination, and the tags into URL parameters.</p></div>';
    page(res, { title: 'Ad links', active: 'adlinks', body });
  }

  // The form fields of an ad link: trimmed, at most 200 characters, the label required.
  function adLinkFields(form) {
    const out = {};
    for (const k of ['label', 'campaign', 'adset', 'ad']) {
      const v = (form.get(k) || '').trim();
      if (v.length > 200) return { error: 'adlink_bad' };
      out[k] = v === '' ? null : v;
    }
    if (!out.label) return { error: 'adlink_label' };
    return { fields: out };
  }

  async function adLinkCreate({ req, res }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const form = await readForm(req);
    const f = adLinkFields(form);
    if (f.error) return redirect(res, `/dash/ad-links?notice=${f.error}`);
    try {
      createAdLink(deps, { brand: form.get('brand') || config.defaultBrand, ...f.fields });
    } catch (e) {
      if (e instanceof HttpError) return redirect(res, '/dash/ad-links?notice=adlink_bad');
      throw e;
    }
    redirect(res, '/dash/ad-links?notice=adlink_created');
  }

  async function adLinkEdit({ req, res, params }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const id = Number(params.id);
    const form = await readForm(req);
    if (!getAdLink(deps, id)) return redirect(res, '/dash/ad-links?notice=adlink_missing');
    const f = adLinkFields(form);
    if (f.error) return redirect(res, `/dash/ad-links?notice=${f.error}`);
    updateAdLink(deps, id, f.fields);
    redirect(res, '/dash/ad-links?notice=adlink_saved');
  }

  async function adLinkToggle({ req, res, params }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const id = Number(params.id);
    const form = await readForm(req);
    if (!getAdLink(deps, id)) return redirect(res, '/dash/ad-links?notice=adlink_missing');
    const on = form.get('active') === '1';
    updateAdLink(deps, id, { active: on });
    redirect(res, `/dash/ad-links?notice=${on ? 'adlink_on' : 'adlink_off'}`);
  }

  // ---------- spend (shared by /dash/campaigns and /dash/spend) ----------
  function spendForm(params, back) {
    const today = lagosDayLabel(lagosDayStart(deps.now()));
    const brandCode = params.brand || '';
    const brandOptions = Q.listBrands(db).filter((b) => b.active).map((b) =>
      `<option value="${esc(b.code)}"${b.code === brandCode ? ' selected' : ''}>${esc(b.code)}</option>`).join('');
    return '<form method="post" action="/dash/spend"><div class="form-grid">'
      + `<label class="field"><span>Brand</span><select name="brand">${brandOptions}</select></label>`
      + `<label class="field"><span>Day</span><input type="date" name="day" value="${esc(today)}" required></label>`
      + '<label class="field"><span>Spend</span><input name="spend" type="number" step="0.01" min="0" required placeholder="0.00"></label>'
      + '<label class="field"><span>Currency</span><input name="currency" value="USD" maxlength="3"></label>'
      + '<label class="field"><span>Campaign</span><input name="campaign" maxlength="200" placeholder="NG_Broad"></label><label class="field"><span>Ad set</span><input name="adset" maxlength="200" placeholder="18-34"></label>'
      + '<label class="field"><span>Ad</span><input name="ad" maxlength="200" placeholder="vid_03"></label><label class="field"><span>Note</span><input name="note" maxlength="500" placeholder="TikTok"></label></div>'
      + `<input type="hidden" name="back" value="${esc(back)}"><div class="form-actions"><button class="btn primary" type="submit">${icon('plus')}Save spend</button></div>`
      + '<p class="notes">One row per day and ad. Saving the same brand / day / campaign / ad set / ad again <strong>replaces</strong> the amount; it is not added. Leave campaign empty for spend with no campaign (shown on the (none) row).</p></form>';
  }

  function spendTable(rows, { back = '', deletable = false, grouped = false } = {}) {
    const head = `<th>Day</th><th>Brand</th><th>Campaign</th><th>Ad set</th><th>Ad</th><th class="n">Spend</th><th>Note</th>${deletable ? '<th class="n"><span class="sr">Actions</span></th>' : ''}`;
    const cols = deletable ? 8 : 7;
    const totals = new Map();
    if (grouped) for (const s of rows) { const t = totals.get(s.day) || {}; t[s.currency] = (t[s.currency] || 0) + s.spend; totals.set(s.day, t); }
    let lastDay = null;
    const groupRow = (s) => {
      if (!grouped || s.day === lastDay) return '';
      lastDay = s.day;
      const t = Object.entries(totals.get(s.day)).map(([c, a]) => `<b>${esc(fmtMoney(a, c))}</b>`).join(' · ');
      return `<tr class="group"><td colspan="${cols}">${esc(fmtDate(Q.dayStartMs(s.day)))}<span class="dot"></span>${t}</td></tr>`;
    };
    return table(head, rows.map((s) => `${groupRow(s)}<tr><td>${esc(s.day)}</td><td>${esc(s.brand)}</td><td>${esc(s.campaign || DASH)}</td><td>${esc(s.adset || DASH)}</td><td>${esc(s.ad || DASH)}</td>`
      + `<td class="n"><b>${esc(fmtMoney(s.spend, s.currency))}</b></td><td class="muted">${esc(s.note || '')}</td>`
      + (deletable ? `<td class="n"><form method="post" action="/dash/spend/${esc(s.id)}/delete" data-confirm="Delete this spend row (${esc(s.day)}, ${esc(fmtMoney(s.spend, s.currency))})?">`
        + `<input type="hidden" name="back" value="${esc(back)}"><button class="btn sm ghost danger" type="submit" aria-label="Delete spend row">${icon('trash')}</button></form></td>` : '')
      + '</tr>'), 'No spend entered in this period.');
  }

  // ---------- /dash/campaigns ----------
  const GROUPS = { ad: ['campaign', 'adset', 'ad'], adset: ['campaign', 'adset'], campaign: ['campaign'] };

  // Roll per-ad rows up to ad set or campaign level; ratios are recomputed from the sums, never averaged.
  function regroup(rows, level) {
    if (level === 'ad') return rows;
    const keep = GROUPS[level];
    const map = new Map();
    for (const r of rows) {
      const key = `${r.brand}|${r.is_none ? '' : keep.map((k) => r[k]).join('|')}`;
      const g = map.get(key) || { ...r, adset: level === 'campaign' || r.is_none ? '' : r.adset, ad: '', clicks: 0, joins: 0, ftds: 0, ftds_usd: 0, revenue: 0, spend: 0, spend_rows: 0 };
      for (const k of ['clicks', 'joins', 'ftds', 'ftds_usd', 'revenue', 'spend', 'spend_rows']) g[k] += r[k] || 0;
      map.set(key, g);
    }
    return [...map.values()].map((g) => ({
      ...g,
      clicks_per_join: g.joins > 0 ? g.clicks / g.joins : null,
      cost_per_ftd: g.spend_rows > 0 && g.ftds_usd > 0 ? g.spend / g.ftds_usd : null,
      roi: g.spend > 0 ? ((g.revenue - g.spend) / g.spend) * 100 : null
    })).sort((a, b) => (a.is_none - b.is_none) || (b.revenue - a.revenue) || (b.clicks - a.clicks) || a.campaign.localeCompare(b.campaign));
  }

  function campaignsPage({ req, res, query }) {
    requireAdmin(req, config);
    const now = deps.now();
    const brandCode = query.get('brand') || 'all';
    const brandId = Q.resolveBrandId(db, brandCode);
    const range = Q.periodRange({ period: query.get('period'), from: query.get('from'), to: query.get('to') }, now);
    const level = GROUPS[query.get('group')] ? query.get('group') : 'ad';
    const q = (query.get('q') || '').slice(0, 100);
    const perf = Q.campaignPerf(db, { brandId, start: range.start, end: range.end, fromDay: range.fromDay, toDay: range.toDay });
    const f = Q.funnel(db, { brandId, start: range.start, end: range.end });
    const spendRows = Q.listSpend(db, { brandId, fromDay: range.fromDay, toDay: range.toDay, limit: 8 });

    const custom = range.key === 'custom';
    const params = { brand: brandCode === 'all' ? '' : brandCode, period: custom ? '' : range.key, from: custom ? range.fromDay : '', to: custom ? range.toDay : '', group: level === 'ad' ? '' : level, q };
    const multiBrand = brandCode === 'all' && new Set(perf.rows.map((r) => r.brand)).size > 1;
    const lq = q.toLowerCase();
    const shown = regroup(q ? perf.rows.filter((r) => [r.campaign, r.adset, r.ad].some((v) => String(v || '').toLowerCase().includes(lq))) : perf.rows, level);
    const maxRev = Math.max(0, ...shown.map((r) => r.revenue));

    const td = (col, value, html, cls = '') => `<td${cls ? ` class="${cls}"` : ''} data-col="${col}" data-value="${esc(value === null || value === undefined ? '' : value)}">${html}</td>`;
    const rowHtml = (r) => {
      const label = r.is_total ? 'Total' : (r.is_none ? Q.NONE_LABEL : r.campaign);
      const key = r.is_total ? 'total' : `${r.is_none ? Q.NONE_LABEL : r.campaign}|${r.adset}|${r.ad}${multiBrand ? `|${r.brand}` : ''}`;
      const revHtml = r.is_total ? esc(fmtMoney(r.revenue)) : `<span class="mbar">${bar(r.revenue, maxRev)}${esc(fmtMoney(r.revenue))}</span>`;
      return `<tr data-row="${esc(key)}"${r.is_total ? ' class="total"' : ''}>`
        + td('campaign', label, `${r.is_none ? `<span class="muted">${esc(label)}</span>` : esc(label)}${multiBrand && !r.is_total ? ` <span class="muted">· ${esc(r.brand)}</span>` : ''}`)
        + td('adset', r.adset, esc(r.adset || DASH)) + td('ad', r.ad, esc(r.ad || DASH))
        + td('clicks', r.clicks, esc(fmtInt(r.clicks)), 'n') + td('joins', r.joins, esc(fmtInt(r.joins)), 'n')
        + td('clicks_per_join', r.clicks_per_join, r.clicks_per_join === null ? DASH : esc(r.clicks_per_join.toFixed(2)), 'n')
        + td('ftds', r.ftds, esc(fmtInt(r.ftds)), 'n') + td('revenue', r.revenue, revHtml, 'n')
        + td('spend', r.spend_rows > 0 ? r.spend : null, r.spend_rows > 0 ? esc(fmtMoney(r.spend)) : DASH, 'n')
        + td('cost_per_ftd', r.cost_per_ftd, r.cost_per_ftd === null ? DASH : esc(fmtMoney(r.cost_per_ftd)), 'n')
        + td('roi', r.roi, roiHtml(r.roi), 'n') + '</tr>';
    };
    const head = '<th>Campaign</th><th>Ad set</th><th>Ad</th><th class="n">Clicks</th><th class="n">Joins</th><th class="n">Clicks/Join</th>'
      + '<th class="n">FTDs</th><th class="n">Revenue</th><th class="n">Spend</th><th class="n">Cost/FTD</th><th class="n">ROI</th>';
    const tableHtml = table(head, [...shown.map(rowHtml), rowHtml(perf.totals)]);

    const otherRev = Object.entries(f.revenue).filter(([c]) => c !== 'USD');
    const unattr = f.unattributed.USD || 0;
    const notes = [];
    if (perf.totals.spend_rows === 0) notes.push(`No spend entered for ${range.fromDay} → ${range.toDay}. Spend, Cost/FTD and ROI show — until you enter some below.`);
    if (otherRev.length) notes.push(`Not included in Revenue (other currencies, never summed): ${otherRev.map(([c, a]) => fmtMoney(a, c)).join(', ')}.`);
    if (perf.excluded_spend_rows) notes.push(`${perf.excluded_spend_rows} spend row(s) in other currencies are not included in Spend.`);

    const t = perf.totals;
    const summary = `<div class="tiles">${[
      tile('Spend', t.spend_rows ? esc(fmtMoney(t.spend)) : DASH, t.spend_rows ? `${esc(fmtInt(t.spend_rows))} row${t.spend_rows === 1 ? '' : 's'}` : 'none entered'),
      tile('Revenue', esc(fmtMoney(t.revenue)), 'matched, USD'),
      tile('ROI', roiHtml(t.roi), '(revenue − spend) / spend'),
      tile('Cost / FTD', t.cost_per_ftd === null ? DASH : esc(fmtMoney(t.cost_per_ftd)), `${esc(fmtInt(t.ftds))} FTDs`),
      tile('Clicks / join', t.clicks_per_join === null ? DASH : esc(t.clicks_per_join.toFixed(2)), `${esc(fmtInt(t.clicks))} clicks · ${esc(fmtInt(t.joins))} joins`),
      tile('Unattributed', esc(fmtMoney(unattr)), 'parked + expired')
    ].join('')}</div>`;

    const exportParams = { brand: params.brand, ...(custom ? { from: range.fromDay, to: range.toDay } : { period: range.key }) };
    const groupSeg = seg([['ad', 'Ad', url('/dash/campaigns', { ...params, group: '' })], ['adset', 'Ad set', url('/dash/campaigns', { ...params, group: 'adset' })], ['campaign', 'Campaign', url('/dash/campaigns', { ...params, group: 'campaign' })]], level, 'Group by');
    const filterChip = q ? `<span class="chip">“${esc(q)}”</span><a class="btn sm ghost" href="${esc(url('/dash/campaigns', { ...params, q: '' }))}">Clear</a>` : '';
    const definitions = `<details class="disclose"><summary>${icon('right')}How these numbers are counted</summary><p class="notes">`
      + '<span><strong>Clicks</strong> = opens of the ad links in the period. Link-preview crawlers are not counted, and the same person opening the same link again within a minute counts once. '
      + '<strong>Joins</strong> = members who joined in the period. <strong>FTDs</strong> and <strong>Revenue</strong> = matched events in the period (revenue USD only). '
      + '<strong>(none)</strong> = links with no campaign plus members who never had a link (organic, channel, backfill). Totals recompute the ratios from the totals.</span></p></details>';
    const spendLink = url('/dash/spend', { brand: params.brand, period: params.period, from: params.from, to: params.to });
    const body = `${noticeHtml(query.get('notice'))}`
      + pageHead({ title: 'Campaigns', sub: rangeSub(range), actions: `${brandSeg('/dash/campaigns', params)}${periodSeg('/dash/campaigns', params, range)}<a class="btn" href="${esc(url('/api/export/campaigns.csv', exportParams))}">${icon('download')}Export CSV</a>` })
      + summary
      + `<div class="section"><div class="section-head"><div class="actions">${groupSeg}${filterChip}</div><span class="muted">Revenue in USD</span></div>`
      + tableHtml
      + `<div class="notes">${notes.map((n) => `<p class="muted">${esc(n)}</p>`).join('')}`
      + `<p class="muted" id="unattributed" data-metric="unattributed" data-value="${unattr}">Unattributed revenue (parked + expired, no campaign possible): <strong>${esc(fmtMoney(unattr))}</strong></p></div>${definitions}</div>`
      + `<div class="grid g-main top section">${card({ title: 'Spend in this period', sub: spendRows.length >= 8 ? 'The latest 8 rows' : '', actions: `<a class="btn sm ghost" href="${esc(spendLink)}">Manage spend${icon('right')}</a>`, flush: true, body: spendTable(spendRows) })}`
      + `${card({ title: 'Attribution quality', body: qualityHtml(f.states) })}</div>`
      + `<div class="section">${card({ title: 'Enter spend', body: spendForm(params, url('/dash/campaigns', { brand: params.brand, period: params.period, from: params.from, to: params.to, group: params.group })) })}</div>`;
    page(res, { title: 'Campaigns', active: 'campaigns', body });
  }

  // ---------- /dash/spend ----------
  function spendPage({ req, res, query }) {
    requireAdmin(req, config);
    const now = deps.now();
    const brandCode = query.get('brand') || 'all';
    const brandId = Q.resolveBrandId(db, brandCode);
    const range = Q.periodRange({ period: query.get('period') || '30d', from: query.get('from'), to: query.get('to') }, now);
    const custom = range.key === 'custom';
    const params = { brand: brandCode === 'all' ? '' : brandCode, period: custom ? '' : range.key, from: custom ? range.fromDay : '', to: custom ? range.toDay : '' };
    const rows = Q.listSpend(db, { brandId, fromDay: range.fromDay, toDay: range.toDay, limit: 1000 });
    const byCur = {};
    for (const r of rows) byCur[r.currency] = (byCur[r.currency] || 0) + r.spend;
    const days = new Set(rows.map((r) => r.day)).size;
    const totalDays = Math.round((range.end - range.start) / DAY);
    const usd = byCur.USD || 0;
    const back = url('/dash/spend', params);
    const ser = Q.series(db, { brandId, start: range.start, end: range.end, bucketMs: DAY });
    const other = Object.entries(byCur).filter(([c]) => c !== 'USD');
    const tiles = `<div class="tiles">${[
      tile('Spend (USD)', rows.length ? esc(fmtMoney(usd)) : DASH, rows.length ? `${esc(fmtMoney(usd / Math.max(1, days)))} per day with spend` : 'none entered', null, { spark: sparkline(ser.spend) }),
      tile('Days with spend', esc(`${fmtInt(days)} / ${fmtInt(totalDays)}`), days < totalDays ? `${esc(fmtInt(totalDays - days))} day${totalDays - days === 1 ? '' : 's'} missing` : 'every day entered'),
      tile('Rows', esc(fmtInt(rows.length)), 'one per day and ad'),
      tile('Other currencies', other.length ? other.map(([c, a]) => esc(fmtMoney(a, c))).join(' · ') : DASH, 'never added to USD')
    ].join('')}</div>`;
    const body = `${noticeHtml(query.get('notice'))}`
      + pageHead({ title: 'Spend', sub: `${rangeSub(range)}<span class="dot"></span>entered by hand; feeds cost per join, cost per FTD and ROI`, actions: `${brandSeg('/dash/spend', params)}${periodSeg('/dash/spend', params, range)}` })
      + tiles
      + `<div class="grid g-side top section"><div>${card({ title: 'Spend rows', sub: rows.length >= 1000 ? 'Showing the latest 1,000' : `${fmtInt(rows.length)} in this period, newest first`, flush: true, body: spendTable(rows, { back, deletable: true, grouped: true }) })}</div>`
      + `<div class="sticky">${card({ title: 'Add spend', id: 'new-spend', body: spendForm(params, back) })}</div></div>`;
    page(res, { title: 'Spend', active: 'spend', body });
  }

  // POST /dash/spend — the no-JS form path of POST /api/spend (same validation and upsert).
  const spendBack = (back) => safeBack(back, '/dash/spend', null) || safeBack(back, '/dash/campaigns', '/dash/campaigns');

  async function spendPost({ req, res }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const form = await readForm(req);
    const dest = (code) => {
      const u = new URL(spendBack(form.get('back') || ''), 'http://x');
      u.searchParams.set('notice', code);
      return `${u.pathname}${u.search}`;
    };
    try {
      saveSpend(deps, Object.fromEntries(form));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return redirect(res, dest(e.code === 'negative_spend' ? 'spend_negative' : e.code === 'unknown_brand' ? 'spend_brand' : 'spend_bad'));
    }
    return redirect(res, dest('spend_saved'));
  }

  async function spendDelete({ req, res, params }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const form = await readForm(req);
    const u = new URL(spendBack(form.get('back') || '/dash/spend'), 'http://x');
    const row = Q.deleteSpend(db, Number(params.id));
    if (row) log.info('spend deleted', { brand_id: row.brand_id, day: row.day, campaign: row.campaign, amount: row.spend, currency: row.currency });
    u.searchParams.set('notice', row ? 'spend_deleted' : 'spend_missing');
    redirect(res, `${u.pathname}${u.search}`);
  }

  // ---------- /dash/system ----------
  function systemPage({ req, res, query }) {
    requireAdmin(req, config);
    const s = systemStatus(deps);
    const now = s.now;
    const row = (k, v) => `<div class="s"><span>${esc(k)}</span><span>${v}</span></div>`;
    const yes = (b, on = 'on', off = 'off') => tag(b ? 'on' : 'off', b ? on : off);
    const ago = (t) => (t ? `${esc(fmtAgo(t, now))} <span class="faint">${esc(fmtTime(t))}</span>` : DASH);
    const sysCard = (id, ico, title, body, sub = '') => `<section class="card" id="${esc(id)}"><div class="card-head"><div class="sys-head"><span class="ico">${icon(ico)}</span><div><h2>${esc(title)}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}</div></div></div><div class="card-body"><div class="status">${body}</div></div></section>`;
    const bytes = (n) => (n === null || n === undefined ? DASH : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
    const uptime = (sec) => (sec < 3600 ? `${Math.floor(sec / 60)} min` : sec < 172800 ? `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min` : `${Math.floor(sec / 86400)} d`);

    const cards = [
      sysCard('service', 'bolt', 'Service', row('Version', esc(s.service.version)) + row('Node', `<span class="mono">${esc(s.service.node)}</span>`)
        + row('Up for', esc(uptime(s.service.uptime_s))) + row('Worker last run', s.worker.last_run_at ? ago(s.worker.last_run_at) : tag('pending', 'not yet'))
        + row('Worker interval', `${esc(s.worker.interval_s)} s`)),
      sysCard('database', 'database', 'Database', row('Migration', `<span class="mono">${esc(s.db.latest || DASH)}</span>`)
        + row('Pending migrations', s.db.pending.length ? tag('failed', s.db.pending.join(', ')) : tag('ok', 'none'))
        + row('Size', esc(bytes(s.db.bytes))) + row('Members', esc(fmtInt(s.db.members))) + row('Events', esc(fmtInt(s.db.events)))
        + row('Links / opens', `${esc(fmtInt(s.db.clicks))} / ${esc(fmtInt(s.db.opens))}`)),
      sysCard('snapshot', 'users', 'Bot snapshot', row('Status', s.snapshot.stale ? tag('stale', s.snapshot.available ? 'stale' : 'unavailable') : tag('ok', 'fresh'))
        + row('Last sync', s.snapshot.age_s === null || s.snapshot.age_s === undefined ? DASH : `${esc(fmtAge(s.snapshot.age_s))} ago`)
        + row('Limit', `${esc(config.snapshotStaleMinutes)} min`) + row('Accounts', esc(fmtInt(s.snapshot.rows))),
        'Telegram id ↔ broker id, for trader-id matching'),
      sysCard('backups', 'archive', 'Backups', row('Nightly backup', yes(s.backup.enabled))
        + (s.backup.enabled ? row('Newest', s.backup.newest_at ? ago(s.backup.newest_at) : tag('pending', 'none yet')) + row('Size', esc(bytes(s.backup.newest_bytes)))
          + row('Kept', `${esc(fmtInt(s.backup.count))} of ${esc(fmtInt(s.backup.keep))}`) + row('Directory', `<span class="mono">${esc(s.backup.dir)}</span>`) : '')
        + row('Last error', s.backup.error ? `<span class="neg">${esc(s.backup.error)}</span>` : tag('ok', 'none')), 'Keep a copy off this host too (docs/07 §6)'),
      sysCard('meta', 'send', 'Meta Conversions API', row('Sending', yes(s.meta.enabled))
        + (s.meta.enabled ? row('Dataset', `<span class="mono">${esc(s.meta.dataset)}</span>`) + row('API version', esc(s.meta.version)) : '')
        + row('Sent (7 days)', esc(fmtInt(s.meta.counts.sent))) + row('Pending', s.meta.counts.pending ? tag('pending', fmtInt(s.meta.counts.pending)) : '0')
        + row('Failed', s.meta.counts.failed ? tag('failed', fmtInt(s.meta.counts.failed)) : '0') + row('Skipped', esc(fmtInt(s.meta.counts.skipped)))
        + (s.meta.oldest_pending_at ? row('Oldest pending', ago(s.meta.oldest_pending_at)) : '')
        + (s.meta.last_failure ? row('Last failure', `<span class="muted">${esc(s.meta.last_failure.resp || '')}</span>`) : ''), 'Server-side events; Meta refuses anything older than 7 days'),
      sysCard('forward', 'forward', 'Joinvoo forward', row('Parallel run', yes(s.forward.enabled))
        + row('Sent (7 days)', esc(fmtInt(s.forward.sent))) + row('Pending', esc(fmtInt(s.forward.pending)))
        + row('Failing', s.forward.failed ? tag('failed', fmtInt(s.forward.failed)) : '0'), 'Copies of every decided event while PARALLEL_FORWARD=1'),
      sysCard('security', 'shield', 'Security', row('Postback key (AFF_KEY)', s.postback.key_set ? (s.postback.enforced ? tag('ok', 'enforced') : tag('pending', 'counting only')) : tag('failed', 'not set'))
        + row('Postbacks since boot', `${esc(fmtInt(s.postback.ok))} with key · ${esc(fmtInt(s.postback.missing))} without · ${esc(fmtInt(s.postback.bad))} wrong`)
        + row('Join key (JOIN_KEY)', s.join_key_set ? tag('ok', 'set') : tag('off', 'loopback only'))
        + row('Failed sign-ins', 'blocked after 10 in 15 min')
        + row('Signed-in sessions', `${esc(fmtInt(s.sessions))} <form class="inline-form" method="post" action="/dash/sessions/revoke" data-confirm="Sign out every other session?"><button class="btn sm" type="submit">${icon('logout')}Sign out others</button></form>`)),
      sysCard('alerts', 'bell', 'Alerts', row('Telegram alerts', yes(s.alerts.enabled))
        + s.alerts.list.map((a) => row(a.label, tag(a.state === 'firing' ? 'firing' : 'clear', a.state))).join('')),
      sysCard('report', 'file', 'Daily report', row('Telegram card', yes(s.report.enabled)) + row('Sent at', `${esc(String(s.report.hour).padStart(2, '0'))}:00 Africa/Lagos`)
        + row('Last sent on', esc(s.report.last_day || DASH))),
      sysCard('retention', 'clock', 'Retention', row('Raw postback payloads', `${esc(s.retention.payload_days)} days`)
        + row('Raw client IPs', s.retention.ip_raw_days ? `${esc(s.retention.ip_raw_days)} days` : 'kept') + row('IP hashes', 'kept'))
    ];
    const issues = s.issues.length
      ? card({ title: 'Needs attention', flush: true, body: `<div class="attn">${s.issues.map((i) => `<a href="${esc(i.href)}"><span class="ico ${i.level === 'info' ? 'info' : i.level}">${icon(i.level === 'info' ? 'info' : 'alert')}</span><span class="t">${esc(i.title)}<small>${esc(i.text || '')}</small></span>${icon('right', 'chev')}</a>`).join('')}</div>` })
      : `<div class="banner ok">${icon('ok')}<div><b>All systems normal.</b> <span class="muted">Nothing needs your attention.</span></div></div>`;
    const body = `${noticeHtml(query.get('notice'))}`
      + pageHead({ title: 'System', sub: `Health of the service, its jobs and its integrations<span class="dot"></span>checked ${esc(fmtTime(now))}` })
      + issues + `<div class="grid g3 top section">${cards.join('')}</div>`;
    page(res, { title: 'System', active: 'system', body, status: s });
  }

  async function revokeSessions({ req, res }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const n = sessionsFor(config) ? sessionsFor(config).revokeOthers(req) : 0;
    log.info('sessions revoked', { count: n });
    redirect(res, '/dash/system?notice=sessions_revoked');
  }

  // ---------- /dash/search (the command palette) ----------
  function search({ req, res, query }) {
    requireAdmin(req, config);
    sendJson(res, 200, { ok: true, groups: Q.searchAll(db, query.get('q'), { snapshot: deps.snapshot }) });
  }

  function asset({ req, res, params }) {
    serveAsset(req, res, params.file);
  }

  return [
    ['GET', '/dash/assets/:file', asset],
    ['HEAD', '/dash/assets/:file', asset],
    ['GET', '/dash/login', htmlRoute(loginGet)],
    ['POST', '/dash/login', htmlRoute(loginPost)],
    ['POST', '/dash/logout', htmlRoute(logout)],
    ['GET', '/dash', htmlRoute(overview)],
    ['GET', '/dash/members', htmlRoute(members)],
    ['GET', '/dash/members/:id', htmlRoute(memberPage)],
    ['GET', '/dash/events', htmlRoute(eventsPage)],
    ['GET', '/dash/events/:id', htmlRoute(eventPage)],
    ['POST', '/dash/events/:id/attach', htmlRoute(attachPost)],
    ['GET', '/dash/campaigns', htmlRoute(campaignsPage)],
    ['GET', '/dash/spend', htmlRoute(spendPage)],
    ['POST', '/dash/spend', htmlRoute(spendPost)],
    ['POST', '/dash/spend/:id/delete', htmlRoute(spendDelete)],
    ['GET', '/dash/ad-links', htmlRoute(adLinksPage)],
    ['POST', '/dash/ad-links', htmlRoute(adLinkCreate)],
    ['POST', '/dash/ad-links/:id', htmlRoute(adLinkEdit)],
    ['POST', '/dash/ad-links/:id/toggle', htmlRoute(adLinkToggle)],
    ['GET', '/dash/links', htmlRoute(linksPage)],
    ['POST', '/dash/links', htmlRoute(linksCreate)],
    ['GET', '/dash/system', htmlRoute(systemPage)],
    ['POST', '/dash/sessions/revoke', htmlRoute(revokeSessions)],
    ['GET', '/dash/search', search],
    // Phase 4 API routes are registered here so server.js (outside this phase's file list) is unchanged.
    ...spendRoutes(deps),
    ...exportRoutes(deps)
  ];
}
