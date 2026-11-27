import { HttpError, readJson, sendJson } from '../router.js';
import { requireAdmin, requireSameOrigin } from '../auth.js';
import * as Q from '../queries.js';

// Admin JSON (docs/05 §6): the same query functions the dashboard renders from.
export function adminRoutes(deps) {
  const { db, config } = deps;

  const dayRange = (query) => {
    const from = query.get('from');
    const to = query.get('to');
    const fromMs = from ? Q.dayStartMs(from) : null;
    const toS = to ? Q.dayStartMs(to) : null;
    if ((from && fromMs === null) || (to && toS === null)) throw new HttpError(400, 'bad_params', 'from/to must be YYYY-MM-DD');
    return { fromMs, toMs: toS === null ? null : toS + 86400000 };
  };

  function members({ req, res, query }) {
    requireAdmin(req, config);
    const { fromMs, toMs } = dayRange(query);
    const r = Q.listMembers(db, {
      q: query.get('q') || '', brandId: Q.resolveBrandId(db, query.get('brand')), ftd: query.get('ftd') || '',
      sort: query.get('sort') || 'total', dir: query.get('dir') || 'desc', fromMs, toMs,
      page: Q.parsePage(query.get('page')), limit: Q.parseLimit(query.get('limit'), 50), snapshot: deps.snapshot
    });
    sendJson(res, 200, { ok: true, page: r.page, limit: r.limit, total: r.total, members: r.rows });
  }

  function member({ req, res, params }) {
    requireAdmin(req, config);
    const id = Number(params.id);
    const d = Number.isSafeInteger(id) && id > 0 ? Q.memberDetail(db, id) : null;
    if (!d) throw new HttpError(404, 'not_found', 'no such member');
    const { offer_link_tpl, ...m } = d.member;
    void offer_link_tpl;
    sendJson(res, 200, { ok: true, member: m, accounts: d.accounts, value: d.value, events: d.trail });
  }

  function events({ req, res, query }) {
    requireAdmin(req, config);
    const { fromMs, toMs } = dayRange(query);
    const r = Q.listEvents(db, {
      state: query.get('state') || '', kind: query.get('kind') || '', brandId: Q.resolveBrandId(db, query.get('brand')),
      q: query.get('q') || '', memberId: Number(query.get('member')) || null, fromMs, toMs,
      page: Q.parsePage(query.get('page')), limit: Q.parseLimit(query.get('limit'), 100)
    });
    // The list carries payloads for the HTML expander; the JSON list leaves them to /api/events/:id.
    const rows = r.rows.map(({ payload_json, ...e }) => { void payload_json; return e; });
    sendJson(res, 200, { ok: true, page: r.page, limit: r.limit, total: r.total, events: rows });
  }

  function event({ req, res, params }) {
    requireAdmin(req, config);
    const e = Q.eventDetail(db, params.id);
    if (!e) throw new HttpError(404, 'not_found', 'no such event');
    let payload = null;
    try { payload = JSON.parse(e.payload_json); } catch { /* leave null */ }
    const { payload_json, ...rest } = e;
    void payload_json;
    sendJson(res, 200, { ok: true, event: { ...rest, payload } });
  }

  async function attach({ req, res, params }) {
    requireAdmin(req, config);
    requireSameOrigin(req);
    const body = await readJson(req);
    const r = Q.attachEvent(deps, { eventId: params.id, memberId: body.member_id, note: body.note, link: body.link_account === true });
    sendJson(res, 200, { ok: true, ...r });
  }

  function clicks({ req, res, query }) {
    requireAdmin(req, config);
    const { fromMs, toMs } = dayRange(query);
    const r = Q.listClicks(db, {
      brandId: Q.resolveBrandId(db, query.get('brand')), campaign: query.get('campaign') || '', fromMs, toMs,
      page: Q.parsePage(query.get('page')), limit: Q.parseLimit(query.get('limit'), 100)
    });
    sendJson(res, 200, { ok: true, page: r.page, limit: r.limit, total: r.total, clicks: r.rows });
  }

  return [
    ['GET', '/api/members', members],
    ['GET', '/api/members/:id', member],
    ['GET', '/api/events', events],
    ['GET', '/api/events/:id', event],
    ['POST', '/api/events/:id/attach', attach],
    ['GET', '/api/clicks', clicks]
  ];
}
