# 05 — API Specification

Base: `http://127.0.0.1:8770`. Public routes are proxied by Caddy; admin JSON and the dashboard require HTTP basic auth.

All responses are JSON unless stated. All errors:

```json
{ "ok": false, "error": "short_code", "detail": "human readable" }
```

`Cache-Control: no-store` on every response except the click redirect.

---

## 1. `GET /c/:token` — click bridge (public)

**Phase 12:** the same path also serves saved ad links, `GET /c/<code>`. A code that is an active ad link mints a click
(the link's campaign / ad set / ad fill whatever the visit's own parameters leave out), asks the gate bot for an
invite made for that click (`POST {GATE_BOT_API}/invite`, 3 s timeout) and `302`s to it. On a timeout or refusal it
falls back to the newest stored invite of the brand, then `brands.invite_link`, then the bot start link — never a
500. A minted click token, an unknown code or an inactive link is handled exactly as below. Crawlers and `HEAD` never
ask the bot for an invite.

**Request**

```
GET /c/7K2M9QX4AB?campaign=NG_Broad&adset=Broad_18-34&ad=vid_03&ttclid=E.C.P.xxx&fbclid=IwAR...
```

| Query param | Stored as | Required |
|---|---|---|
| `campaign`, `adset`, `ad`, `creative` | same | no |
| `ttclid`, `fbclid`, `gclid` | same | no |
| `sub1`, `sub2`, `sub3` | same | no |

**Behaviour**

1. Validate token: `/^[0-9A-HJKMNP-TV-Z]{10}$/` (Crockford base32, no I/L/O/U).
2. Unknown token → `404 text/plain` `"link not found"`. No database write.
3. Known token → insert the click row (token is generated on demand by the admin link builder; see §7) → `302` to `https://t.me/<brands.bot_username>?start=c_<token>`.
4. `ip_hash = sha256(ip + settings.ip_salt).slice(0,32)`. Never store the raw IP.
5. Response headers: `Location`, `Cache-Control: no-store`, `X-Coinvoo-Click: <token>`.

**Latency budget:** p99 < 300 ms; the write happens before the redirect but nothing else does.

---

## 2. `POST /api/join` — join capture (internal, from gate bots)

```json
{
  "brand": "brand-one",
  "telegram_id": 7000000001,
  "username": "owner",
  "first_name": "Owner",
  "click_id": "7K2M9QX4AB",
  "source": "bot:start",
  "channel_join": false
}
```

Validation: `brand` must exist; `telegram_id` must be a positive integer; `click_id` optional but if present must exist in `clicks` (else 422 `unknown_click`).

Behaviour: upsert `members` on `(brand_id, telegram_id)`. First touch wins on `click_id`. Returns:

```json
{ "ok": true, "member_id": 1234, "created": true, "click_id": "7K2M9QX4AB" }
```

Side effect: if the member now has an `iq_user_id` known from the bot DB, create the `accounts` row, then re-run parked events matching it.

**Auth.** When `JOIN_KEY` is set, the request must carry it in **either** header, compared in constant time:

| Header | Status |
|---|---|
| `X-Coinvoo-Key: <JOIN_KEY>` | current name |
| `X-Tribute-Key: <JOIN_KEY>` | legacy (pre-rename) name, still sent by the gate bots; accepted with the same key |

Neither header, or a wrong value in every header present → `401 unauthorized`. Without `JOIN_KEY` the route is
loopback-only, and a request that came through the reverse proxy (`X-Forwarded-For` set) is refused.

**Phase 12 additions.** `invite_link` (the channel invite a join request used; resolves to its click when `click_id`
is absent) and `event` (`"join"` default, or `"leave"`, which stamps `left_at` on a known member and never creates
one). A join after a recorded leave is a rejoin: `members.rejoins + 1`, same row, response `rejoin: true`. See
docs/10-gate-bot-invites.md.

### 2a. `POST /api/join/batch` — backfill of missed joins (internal)

Same auth as `POST /api/join`. Body (at most **500** rows; more → `400 too_many`, nothing written; body ≤ 512 KB):

```json
{ "brand": "brand-one",
  "joins": [ { "telegram_id": 123, "joined_at": 1763387171000, "username": "x", "first_name": "Y",
               "join_source": "channel:-1002766084283", "click_id": "7K2M9QX4AB" } ] }
```

- `brand` optional (default `DEFAULT_BRAND`); per row `telegram_id` required (positive integer), `joined_at` epoch
  ms (default: now; not in the future), `username` / `first_name` / `join_source` (default `backfill:batch`) /
  `click_id` optional.
- Each row goes through the same upsert as `POST /api/join`, with the row's `joined_at` as its time, so a historical
  join keeps its real timestamp.
- **Idempotent.** Re-posting the same rows never creates a second member (`(brand_id, telegram_id)` is unique),
  never rewrites `joined_at`, and never moves `last_seen_at` backwards; first touch still wins on `click_id`.
- A bad row does not fail the batch: it is reported by index and the valid rows are written.

```json
{ "ok": true, "created": 2, "updated": 1, "errors": [ { "index": 3, "error": "telegram_id must be a positive integer" } ] }
```

---

## 3. `GET|POST /api/aff` — postback receiver (public, high volume)

Accepts query string (GET) or `application/x-www-form-urlencoded` / JSON (POST). Unknown parameters are preserved in `payload_json`.

**Success**

```json
{ "ok": true, "event_id": "f50af504-…", "duplicate": false,
  "matched": true, "path": "afftrack", "member_id": 1234 }
```

**Duplicate**

```json
{ "ok": true, "event_id": "f50af504-…", "duplicate": true }
```

**Ignored**

```json
{ "ok": true, "ignored": "stub_guard" }
```

**Errors:** `400 bad_params` (no status at all), `401 unauthorized` (Phase 10: `AFF_KEY` is enforced and the key is
missing or wrong — nothing is stored), `500 store_failed`. Always HTTP 200 for anything that was stored — the network
must not retry a valid event.

**Postback key (Phase 10).** When `AFF_KEY` is set, every postback must carry it: `?key=<AFF_KEY>` on the URL (also
accepted as `aff_key`, as a body field, or as the `X-Coinvoo-Key` header). Without it anyone who learns the URL can
post a deposit that is matched at confidence 100, counted as revenue and sent to Meta as a Purchase. The key is
compared in constant time and is **removed from the payload before anything is stored**, with or without `AFF_KEY`.
`AFF_KEY_ENFORCE=0` checks and counts keys but still accepts every postback (rollout mode; see docs/07 §4a).

Rules: see `docs/03-attribution-rules.md`. The Joinvoo forward is scheduled after the response and never blocks it.

---

## 4. `GET /api/aff/health` — liveness (public)

```json
{ "ok": true, "service": "coinvoo", "version": "1.0.0",
  "db": "ok", "uptime_s": 91234,
  "last_event_at": 1794690000000, "worker_last_run_at": 1794689940000 }
```

Returns `503` with `{"ok":false,"db":"fail"}` if a `SELECT 1` fails.

---

## 5. `GET /api/aff/stats` — counters (public, no PII; money only with admin credentials)

Phase 10: the `revenue` block is included only when the request carries valid admin basic auth. An anonymous caller
gets every counter below and no `revenue` key. (Wrong credentials count towards the failed sign-in limit, §8.)

```json
{
  "ok": true,
  "period": "24h",
  "events": { "total": 42, "reg": 12, "ftd": 9, "dep": 21,
              "matched": 31, "parked": 9, "expired": 2, "ignored": 0 },
  "forward": { "sent": 29, "pending": 3, "failed": 0 },
  "revenue": { "matched_usd": 1240.50, "unattributed_usd": 180.00 }
}
```

---

## 6. Admin JSON (basic auth, or a dashboard session — Phase 11)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/members?q=&brand=&limit=50&page=1` | Member list with value columns |
| `GET` | `/api/members/:id` | One member + events + attributions |
| `GET` | `/api/events?state=&kind=&from=&to=&limit=100&page=1` | Event list |
| `GET` | `/api/events/:id` | Raw payload + attribution log |
| `POST` | `/api/events/:id/attach` | Manual attach `{member_id, note}` — writes `path='manual'` |
| `GET` | `/api/clicks?campaign=&from=&to=&limit=100` | Click list |
| `POST` | `/api/spend` | `{day, campaign, adset, ad, spend, currency, note}` upsert into `costs` |
| `GET` | `/api/spend?from=&to=` | Spend rows |
| `DELETE` | `/api/spend/:id` | Remove one spend row (Phase 11); `404` when it does not exist; same-origin like every write |
| `GET` | `/api/report/daily?day=YYYY-MM-DD&brand=brand-one` | The daily report payload (Phase 5) |
| `GET` | `/api/export/members.csv`, `/api/export/events.csv`, `/api/export/campaigns.csv` | CSV streams (Phase 4) |
| `POST` | `/api/links` | Create a click link: `{brand, campaign, adset, ad, creative}` → `{token, url}` |
| `GET` | `/api/ad-links?brand=` | Saved ad links, each with `url` and `stats {clicks, joins, members}` (Phase 12) |
| `POST` | `/api/ad-links` | Create `{brand, label, campaign, adset, ad}`; the 10-character `code` is generated (unused by any link or click) |
| `PATCH` | `/api/ad-links/:id` | Change `label` / `campaign` / `adset` / `ad` / `active`; the code never changes |
| `GET` | `/api/ad-links/:id/stats` | `{clicks, joins, members}`: non-crawler visits, people bound to one of its clicks, those plus their rejoins |

`/api/links` returns the short URL (not the raw click id) so ads can be built from the dashboard.

---

## 7. Dashboard HTML (sign-in session or basic auth)

| Path | Screen |
|---|---|
| `/dash/login` | Sign in (Phase 11). `POST` checks `ADMIN_USER`/`ADMIN_PASS` under the failed sign-in limit and sets the session cookie |
| `/dash/logout` | `POST` — ends this session |
| `/dash` | Overview: KPIs with sparklines, performance chart, needs attention, attribution quality, money, funnel, top campaigns, latest events |
| `/dash/members` | Members list (`?q=`, `?brand=`, `?ftd=`, `?from=`, `?to=`, `?sort=`, `?page=`) |
| `/dash/members/:id` | Member profile, value, identity, click context, offer link, event timeline |
| `/dash/events` | Events with per-state tabs and counts; parked rows carry the attach form (`?tab=parked`) |
| `/dash/events/:id` | One event: details, attach form when parked, attribution log, raw payload |
| `/dash/campaigns` | Campaign performance (`?group=adset` / `?group=campaign` roll the per-ad rows up), spend in the period, spend entry |
| `/dash/spend` | Spend rows by day with daily totals, add and delete (Phase 11) |
| `/dash/links` | Ad-link builder, landing-page `/go` CTA URLs, link list with search |
| `/dash/system` | Service, database, bot snapshot, backups, Meta queue, Joinvoo forward, security, alerts, report, retention |
| `/dash/search?q=` | JSON for the command palette: members, events, links, campaigns |
| `/dash/assets/:file` | The stylesheet and the script, content-hashed, public, cached forever |

**Sessions (Phase 11).** The cookie `cv_session` holds a random 256-bit token (`HttpOnly`, `SameSite=Lax`, `Path=/`,
30 days; `Secure` when the request arrived over HTTPS). Only its SHA-256 is stored, in `sessions`, tied to a
fingerprint of the current credentials: changing `ADMIN_USER` or `ADMIN_PASS` ends every session. A browser that is
not signed in is redirected to `/dash/login?next=…`; a script without credentials still gets `401` with
`WWW-Authenticate: Basic`, so basic auth keeps working everywhere.

No JavaScript framework. One script, served from `/dash/assets/` with the page's nonce, adds the command palette
(⌘K / Ctrl K), keyboard jumps (`g` then o/m/e/c/s/l/y), copy buttons, clickable rows, chart tooltips, the theme
toggle and the mobile menu. Every screen works without it. The CSP allows styles only from the stylesheet
(`style-src 'self'`, no inline style) and scripts only with the per-response nonce.

---

## 8. Authentication

- HTTP basic auth against `ADMIN_USER` / `ADMIN_PASS` from the environment. Constant-time comparison (`crypto.timingSafeEqual`).
- Applies to `/dash/*` and everything under `/api/` **except**: `/api/aff`, `/api/aff/health`, `/api/aff/stats`, `/api/join`, `/api/join/batch`, and `/c/*`.
- `/api/join` and `/api/join/batch` are restricted by an optional shared secret header `X-Coinvoo-Key` (or the legacy `X-Tribute-Key`) when `JOIN_KEY` is set. If unset, the route is loopback-only (verify `req.socket.remoteAddress` is `127.0.0.1` or `::1`).
- **Failed sign-in limit (Phase 10).** `/dash` and `/api/*` are reachable from the internet through Caddy. Ten wrong
  credentials from one address within 15 minutes block that address for 15 minutes (`429 too_many_attempts` with
  `Retry-After`), correct credentials included. A request with no credentials is not a failure. One log line per
  block, with a hashed address: `[coinvoo] auth_blocked ip=<hash> fails=10 minutes=15`.
- `/api/aff` is restricted by `AFF_KEY` when it is set (§3).

---

## 9. Status codes used

| Code | When |
|---|---|
| `200` | Success, including duplicates and ignored events |
| `302` | Click redirect |
| `400` | Malformed parameters that cannot be stored |
| `401` | Missing/incorrect basic auth; a postback without the right key while `AFF_KEY` is enforced |
| `404` | Unknown click token, unknown resource |
| `422` | Storeable but semantically invalid (`unknown_click` on `/api/join`) |
| `429` | Rate limit exceeded (postback bursts > 100/s, `/go` visits > 20/s, per IP); too many failed sign-ins (`too_many_attempts`) |
| `500` | Database or unexpected failure |
| `503` | Health check failing |
