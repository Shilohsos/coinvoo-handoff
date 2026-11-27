// Daily report: build the numbers, render the plain-text card, schedule the send.
// Every figure comes from the query functions the dashboard uses (queries.js); the only logic here is
// the arithmetic the Overview screen applies to them (cost/join, cost/FTD, ROI), mirrored line for line.
import { dirname } from 'node:path';
import * as Q from './queries.js';
import { sendMessage } from './telegram.js';
import { getSetting, setSetting } from './alerts.js';
import { fmtMoney, fmtInt, fmtAgo } from './render.js';
import { log } from './log.js';

const H = 3600 * 1000;
const DAY_MS = 24 * H;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RETRY_DELAY_MS = 3 * 60000; // network errors: up to 3 retries, 3 minutes apart (inside 10 minutes)
const MAX_NETWORK_RETRIES = 3;

// ---------- configuration (read once, at startup) ----------

// REPORT_BOT_TOKEN, REPORT_CHAT_ID and ALERT_CHAT_ID may all be absent: the report and the alerts then
// do nothing. Nothing here throws, and the token is never copied into anything that gets logged.
export function loadReportConfig(env = process.env, { dbPath = ':memory:' } = {}) {
  const str = (k) => (env[k] !== undefined && String(env[k]).trim() !== '' ? String(env[k]).trim() : null);
  const warnings = [];
  const num = (k, dflt, ok) => {
    const raw = str(k);
    if (raw === null) return dflt;
    const n = Number(raw);
    if (Number.isFinite(n) && ok(n)) return n;
    warnings.push(k);
    return dflt;
  };
  const token = str('REPORT_BOT_TOKEN');
  const reportChatId = str('REPORT_CHAT_ID');
  const alertChatId = str('ALERT_CHAT_ID');
  const missingReport = [!token && 'REPORT_BOT_TOKEN', !reportChatId && 'REPORT_CHAT_ID'].filter(Boolean);
  const missingAlerts = [!token && 'REPORT_BOT_TOKEN', !alertChatId && 'ALERT_CHAT_ID'].filter(Boolean);
  return Object.freeze({
    token, reportChatId, alertChatId,
    reportEnabled: missingReport.length === 0,
    alertsEnabled: missingAlerts.length === 0,
    missingReport, missingAlerts,
    reportHour: num('REPORT_HOUR', 8, (n) => Number.isInteger(n) && n >= 0 && n <= 23),
    silenceHours: num('POSTBACK_SILENCE_HOURS', 6, (n) => n > 0),
    parkedPct: num('PARKED_ALERT_PCT', 50, (n) => n > 0 && n < 100),
    parkedMinEvents: num('PARKED_ALERT_MIN_EVENTS', 10, (n) => Number.isInteger(n) && n >= 1),
    // Lets the proof script aim the client at a local stand-in; the default is Telegram itself.
    apiBase: str('TELEGRAM_API_BASE') || 'https://api.telegram.org',
    timeoutMs: undefined,
    retryDelayMs: undefined,
    diskPath: dbPath === ':memory:' ? '.' : dirname(dbPath),
    warnings
  });
}

// ---------- the numbers ----------

// The Overview's figures for one period and brand. `brandId` null = all brands.
export function summarize(db, { brandId, start, end, fromDay, toDay }) {
  const f = Q.funnel(db, { brandId, start, end });
  const sp = Q.spend(db, { brandId, fromDay, toDay });
  const rev = f.revenue.USD || 0;
  const hasSpend = sp.rows > 0 && sp.usd > 0; // as on the Overview: no spend entered => not computable
  const st = f.states;
  const decided = st.matched + st.parked + st.expired; // ignored events are outside the denominator (docs/03 §8)
  const pct = (n) => (decided > 0 ? (n / decided) * 100 : null);
  return {
    clicks: f.clicks, joins: f.joins, ad_joins: f.ad_joins, regs: f.regs, ftds: f.ftds, ftds_usd: f.ftds_usd, redeps: f.redeps,
    revenue: rev,
    revenue_other: Object.fromEntries(Object.entries(f.revenue).filter(([c]) => c !== 'USD')),
    spend: hasSpend ? sp.usd : null,
    cost_per_join: hasSpend && f.joins > 0 ? sp.usd / f.joins : null,
    cost_per_ftd: hasSpend && f.ftds_usd > 0 ? sp.usd / f.ftds_usd : null, // USD spend over USD first deposits only
    roi: hasSpend ? ((rev - sp.usd) / sp.usd) * 100 : null,
    unattributed: f.unattributed.USD || 0,
    unattributed_other: Object.fromEntries(Object.entries(f.unattributed).filter(([c]) => c !== 'USD')),
    states: { matched: st.matched, parked: st.parked, expired: st.expired, ignored: st.ignored },
    decided,
    matched_pct: pct(st.matched), parked_pct: pct(st.parked), expired_pct: pct(st.expired)
  };
}

// The campaign with the most matched FTDs (revenue breaks ties); `(none)` is not a campaign.
export function topCampaign(db, { brandId, start, end, fromDay, toDay }) {
  const { rows } = Q.campaignPerf(db, { brandId, start, end, fromDay, toDay });
  const best = rows.filter((r) => !r.is_none && r.ftds > 0)
    .sort((a, b) => (b.ftds - a.ftds) || (b.revenue - a.revenue))[0];
  if (!best) return null;
  return { label: [best.campaign, best.adset, best.ad].filter(Boolean).join(' / '), ftds: best.ftds, revenue: best.revenue };
}

// ---------- the card ----------

const fmtP = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);
const fmtRoi = (v) => (v === null ? '—' : `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(1)}%`);
const money = (v) => (v === null || v === undefined ? '—' : fmtMoney(v));
// {NGN: 150000, EUR: 20} -> "EUR 20.00 + ₦150,000" (fmtMoney per currency); "" when there is nothing outside USD.
const otherMoney = (m) => Object.entries(m || {}).filter(([, a]) => a > 0)
  .sort(([a], [b]) => a.localeCompare(b)).map(([c, a]) => fmtMoney(a, c)).join(' + ');

function dayHeading(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Fixed shape, plain text, no emoji. Metrics that cannot be computed print an em dash.
export function renderCard(p) {
  // Money that is not USD is never added to the USD figures above; when there is any, say so on its own line.
  const otherRev = otherMoney(p.revenue_other);
  const otherUnattr = otherMoney(p.unattributed_other);
  const otherLine = otherRev || otherUnattr
    ? `Not in the USD figures: ${[otherRev && `revenue ${otherRev}`, otherUnattr && `unattributed ${otherUnattr}`].filter(Boolean).join(' · ')}`
    : '';
  const top = p.top_campaign
    ? `Top campaign: ${p.top_campaign.label} — ${fmtInt(p.top_campaign.ftds)} FTD${p.top_campaign.ftds === 1 ? '' : 's'}, ${fmtMoney(p.top_campaign.revenue)}`
    : 'Top campaign: —';
  const last = p.last_event_at === null ? 'Last event: never'
    : `Last event: ${fmtAgo(p.last_event_at, p.generated_at)}${p.silence ? ' (silence)' : ''}`;
  return [
    `COINVOO — ${p.brand} — ${dayHeading(p.day)}`,
    '',
    `Clicks ${fmtInt(p.clicks)} · Joins ${fmtInt(p.joins)} · Regs ${fmtInt(p.regs)} · FTDs ${fmtInt(p.ftds)} · Re-deps ${fmtInt(p.redeps)}`,
    `Revenue ${money(p.revenue)} · Spend ${money(p.spend)} · ROI ${fmtRoi(p.roi)} (USD)`,
    `Cost/join ${money(p.cost_per_join)} · Cost/FTD (USD) ${money(p.cost_per_ftd)}`,
    '',
    // Matched/Parked/Expired share the decided events (as the dashboard does); ignored is a count.
    `Matched ${fmtP(p.matched_pct)} · Parked ${fmtP(p.parked_pct)} · Expired ${fmtP(p.expired_pct)} · Ignored ${fmtInt(p.states.ignored)}`,
    `Unattributed revenue ${money(p.unattributed)}`,
    ...(otherLine ? [otherLine] : []),
    '',
    top,
    last
  ].join('\n');
}

// One card per brand and, when several are reported, the combined line. `brandCode` null = every
// active brand. Returns the JSON the read API serves and the text the bot sends, which are the
// same numbers: `text` is rendered from `brands`.
export function buildDailyReport(db, { day, brandCode = null, now, silenceHours = 6 }) {
  const start = Q.dayStartMs(day);
  const end = start + DAY_MS;
  const brands = Q.listBrands(db).filter((b) => (brandCode ? b.code === brandCode : b.active));
  const cards = brands.map((b) => {
    const range = { brandId: b.id, start, end, fromDay: day, toDay: day };
    const last = Q.lastEventAt(db, b.id);
    const p = {
      brand: b.code, day, generated_at: now,
      ...summarize(db, range),
      top_campaign: topCampaign(db, range),
      last_event_at: last,
      silence: last !== null && now - last > silenceHours * H
    };
    p.text = renderCard(p);
    return p;
  });
  const withSpend = cards.filter((c) => c.spend !== null);
  const revenueOther = {};
  for (const c of cards) for (const [cur, a] of Object.entries(c.revenue_other)) revenueOther[cur] = (revenueOther[cur] || 0) + a;
  const total = {
    revenue: cards.reduce((a, c) => a + c.revenue, 0),
    revenue_other: revenueOther,
    spend: withSpend.length ? withSpend.reduce((a, c) => a + c.spend, 0) : null,
    ftds: cards.reduce((a, c) => a + c.ftds, 0)
  };
  const totalOther = otherMoney(total.revenue_other);
  const totalLine = `ALL BRANDS — revenue ${money(total.revenue)}${totalOther ? ` · other revenue ${totalOther}` : ''} · spend ${money(total.spend)} · FTDs ${fmtInt(total.ftds)}`;
  const parts = cards.map((c) => c.text);
  if (!cards.length) parts.push('COINVOO — no active brands');
  else if (!brandCode) parts.push(totalLine);
  return { day, generated_at: now, currency: 'USD', brands: cards, total: brandCode ? null : total, text: parts.join('\n\n') };
}

// The day a report sent now covers: yesterday, in Lagos time.
export function reportDayFor(now) {
  return Q.periodRange({ period: 'today' }, now - DAY_MS).fromDay;
}

// ---------- sending ----------

// The one function that sends a report: build it, deliver it to REPORT_CHAT_ID. Takes an injectable fetch.
export async function sendDailyReport({ db, rc, now, fetchImpl = globalThis.fetch, day = reportDayFor(now) }) {
  const report = buildDailyReport(db, { day, now, silenceHours: rc.silenceHours });
  const res = await sendMessage({
    token: rc.token, chatId: rc.reportChatId, text: report.text, fetchImpl, apiBase: rc.apiBase,
    timeoutMs: rc.timeoutMs, retryDelayMs: rc.retryDelayMs
  });
  return { ...res, text: report.text, day };
}

// ---------- the scheduler ----------

const lagosHour = (now) => new Date(now + H).getUTCHours();

// Called on every worker tick. Fires at REPORT_HOUR (Africa/Lagos) once per day:
//   * settings.last_report_day is written BEFORE the send, so a restart cannot send the day twice;
//   * a failed send is not retried the same day, except a transient failure (no answer, 5xx, 429),
//     which is retried up to 3 times, 3 minutes apart (settings.report_retry survives a restart).
// Returns a short status string (for logs and tests). Never throws.
export async function scheduleReport(deps, rc, state) {
  if (!rc.reportEnabled) return 'disabled';
  if (state.inflight) return 'busy';
  state.inflight = true;
  try {
    const now = deps.now();
    const today = Q.periodRange({ period: 'today' }, now).fromDay;

    const raw = getSetting(deps.db, 'report_retry');
    let retry = null;
    if (raw) { try { retry = JSON.parse(raw); } catch { retry = null; } }
    if (retry && retry.day !== today) { retry = null; setSetting(deps.db, 'report_retry', ''); }

    if (retry) {
      if (now < retry.at) return 'waiting';
    } else {
      if (lagosHour(now) !== rc.reportHour) return 'idle';
      if (getSetting(deps.db, 'last_report_day') === today) return 'already_sent';
      setSetting(deps.db, 'last_report_day', today); // before the send
    }

    const attempt = retry ? retry.n + 1 : 0;
    const res = await sendDailyReport({ db: deps.db, rc, now, fetchImpl: deps.fetchImpl });
    log.info('report', { day: res.day, sent: res.ok ? 'ok' : 'failed', message: res.messageId, attempt, status: res.status, error: res.ok ? null : res.error });
    if (res.ok) { setSetting(deps.db, 'report_retry', ''); return 'sent'; }

    if (res.transient && attempt < MAX_NETWORK_RETRIES) {
      setSetting(deps.db, 'report_retry', JSON.stringify({ day: today, n: attempt, at: now + RETRY_DELAY_MS }));
      return 'retry_scheduled';
    }
    setSetting(deps.db, 'report_retry', '');
    return 'failed';
  } catch (e) {
    log.error('report', e);
    return 'error';
  } finally {
    state.inflight = false;
  }
}
