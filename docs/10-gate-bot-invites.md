# 10 — Gate bot: per-click channel invites (directive Part C)

Coinvoo side: `GET /c/<code>` (src/routes/adlinks.js) and `POST /api/join` (src/routes/join.js), in this PR.
Bot side: `/root/gatebot1-bot/index.js`. That repository is not reachable from the build session, so this is a
**reference implementation to apply by hand** — check it against the bot's own `reportJoin` and launch code.

## 1. Environment

| Where | Variable | Value |
|---|---|---|
| Coinvoo `.env` | `GATE_BOT_API` | `http://127.0.0.1:8771` (the bot's local server) |
| Coinvoo `.env` | `GATE_SHARED_SECRET` | 16+ characters, `openssl rand -hex 24`; the same value in the bot |
| Coinvoo `.env` | `GATE_BOT_TIMEOUT_MS` | optional, default `3000` |
| bot `.env` | `GATE_SHARED_SECRET` | the same value |
| bot `.env` | `GATE_BOT_TOKEN`, `CHANNEL_ID` | as today; never logged |

Without `GATE_BOT_API`, `/c/<code>` still works: it records the click and sends the visitor to the newest stored
invite, else `brands.invite_link`, else the bot start link (`t.me/<bot>?start=c_<token>`).

## 2. `POST /invite` — mint one invite for one click

```js
const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const SECRET = process.env.GATE_SHARED_SECRET;
const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const same = (a, b) => timingSafeEqual(createHash('sha256').update(String(a || '')).digest(), createHash('sha256').update(String(b)).digest());

http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST' || req.url !== '/invite') return send(404, { ok: false });
  if (!SECRET || !same(req.headers['x-coinvoo-token'], SECRET)) return send(401, { ok: false });
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 4096) return send(413, { ok: false }); }
  let j; try { j = JSON.parse(raw); } catch { return send(400, { ok: false }); }
  if (!TOKEN_RE.test(String(j.click_id || ''))) return send(400, { ok: false });
  try {
    // No member_limit and no expire_date: the link stays valid and reusable (directive "Do not").
    const link = await bot.telegram.createChatInviteLink(process.env.CHANNEL_ID, { creates_join_request: true, name: `cv_${j.click_id}` });
    send(200, { invite_link: link.invite_link });
  } catch (e) {
    console.log('[gate] invite failed', e && e.code ? e.code : '');   // 429 or anything else -> Coinvoo falls back
    send(503, { ok: false });
  }
}).listen(8771, '127.0.0.1');
```

## 3. Join requests and leaves

The invite's `name` carries the click (`cv_<click_id>`); the full `invite_link` is sent too, so Coinvoo can resolve an
invite it re-used while the bot was throttled. Invites are **not** revoked on join.

```js
bot.on('chat_join_request', async (ctx) => {
  const r = ctx.chatJoinRequest;
  const m = /^cv_([0-9A-HJKMNP-TV-Z]{10})$/.exec((r.invite_link && r.invite_link.name) || '');
  try { await ctx.telegram.approveChatJoinRequest(r.chat.id, r.from.id); } catch (e) { console.log('[gate] approve failed'); }
  await reportJoin({                       // POST /api/join with X-Coinvoo-Key, as today
    brand: 'brand-one', telegram_id: r.from.id, username: r.from.username, first_name: r.from.first_name,
    click_id: m ? m[1] : undefined, invite_link: r.invite_link ? r.invite_link.invite_link : undefined,
    source: 'channel:join'
  });
});

bot.on('chat_member', async (ctx) => {
  const u = ctx.chatMember;
  const was = u.old_chat_member.status;
  const now = u.new_chat_member.status;
  const who = { brand: 'brand-one', telegram_id: u.new_chat_member.user.id };
  if (['member', 'administrator', 'restricted'].includes(was) && ['left', 'kicked'].includes(now)) {
    await reportJoin({ ...who, event: 'leave' });
  } else if (['left', 'kicked'].includes(was) && now === 'member') {
    await reportJoin({ ...who, source: 'channel:join' });
  }
});

// chat_member updates are only delivered when asked for:
bot.launch({ allowedUpdates: ['message', 'callback_query', 'chat_join_request', 'chat_member'] });
```

**Why leaves are reported.** An approved join request also arrives as a `left -> member` `chat_member` update, a
second or two after the join request. Counting that transition as a rejoin would make every first join a rejoin.
Coinvoo therefore counts a join as a rejoin only when the member's leave was recorded (`members.left_at`): the
duplicate report after an approval is a no-op, and a real leave-then-return is `rejoins + 1` on the same member row.

## 4. `POST /api/join` fields added in this phase

| Field | Meaning |
|---|---|
| `invite_link` | The invite the join request used. When there is no `click_id`, Coinvoo binds the newest click that invite was handed to and that has no member yet; if every one already has its member, the join is recorded without a click. |
| `event` | `"join"` (default) or `"leave"`. A leave stamps `left_at` on a known member and never creates one. |

The response gains `rejoin: true|false`; a leave answers `{ ok, member_id, left }`.

## 5. Check after deploy

1. `curl -s -X POST -H "x-coinvoo-token: $GATE_SHARED_SECRET" -d '{"brand":"brand-one","click_id":"0000000000"}' 127.0.0.1:8771/invite` → `{"invite_link":"https://t.me/+..."}`.
2. Create a link: `curl -s -u admin:… -H 'content-type: application/json' -d '{"brand":"brand-one","label":"test"}' localhost:8770/api/ad-links`.
3. `curl -sI https://<public host>/c/<code>` → `302` (HEAD reuses the newest invite and mints nothing); a GET from a phone → the channel's join screen.
4. Join, then `curl -s -u admin:… localhost:8770/api/ad-links/<id>/stats` → `members: 1`, and the member page shows the bound `click_id`.
