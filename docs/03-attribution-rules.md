# 03 — Attribution Rules

The matcher is the only part of this system that can quietly lie. These rules are exact; implement them literally.

---

## 1. Resolution order

For every postback, run in this order and **stop at the first rule that produces a confirmed member**.

| Rank | Rule | Confidence | Condition |
|---|---|---|---|
| 1 | `afftrack` | 100 | `aff_track` is a decimal Telegram id that exists in `members.telegram_id` for the same brand |
| 2 | `trader_id` | 90 | `trader_id` maps to exactly one `accounts` row → member |
| 3 | `click_id` | 85 | `click_id` present on the postback, and a `members` row carries that `click_id` |
| 4 | `trader_id` via bot DB | 90 | `trader_id` = `trading-bot.db users.iq_user_id` → `telegram_id` exists in `members` (Path C) |
| 5 | Parked | 0 | none of the above |

Notes:

- Rules 2 and 4 are the same confidence and differ only in source: `accounts` (already linked inside coinvoo) vs. the trading-bot database (read-only lookup). Run 2 first, then 4.
- Rule 1 wins over everything. If `afftrack` names a Telegram id that is **not** a member, do not fall through silently — log `afftrack_unknown` and continue to rule 2, but keep the note.
- A `trader_id` that appears in both `accounts` and the bot DB must resolve identically. If they disagree, trust `accounts` and log `trader_conflict`.

## 2. Candidate disambiguation

One `trader_id` may touch several Telegram identities (the classic case: a person created two Telegram accounts, or an old account holder reused the bot).

Order of preference when more than one member matches:

1. Member whose `accounts` row owns this `iq_user_id` → **100 % of the time, correct**.
2. Member whose `click_id` equals the postback's `clickid`.
3. Member with the earliest `joined_at` (first touch).
4. Member with the most recent `last_seen_at`.

Every rejected candidate writes an `attribution_log` row with `reason='candidate_rejected:<rule>'`.

## 3. Accounts — one broker account, one owner

- `accounts.iq_user_id` is `UNIQUE`. The first member to link an `iq_user_id` owns it.
- If a **second** Telegram id presents the same `iq_user_id`:
  - the link is refused;
  - `attribution_log` records `candidate=<tg>, reason='account_claimed'`;
  - events continue to attribute to the owner.
- A manual override is allowed only from the dashboard's Parked screen (Phase 3) and is recorded with `path='manual'`, `confidence=100`, and the operator's note.

## 4. Stub guard — the broker's own tests

Stored, never matched, never counted in revenue:

- `trader_id` that is not at least 5 digits (`^\d{5,}$`) — the network's test postbacks send `trader_id=1`.
- `afftrack` or `clickid` containing `test` (case-insensitive).
- `amount` present but `<= 0` on an `ftd`/`dep`.
- `status` that is not in the mapping table (§6).

These rows land with `state='ignored'`, `ignore_reason='stub_guard'` (or the specific reason), and are visible in the dashboard's Events screen but excluded from every metric.

> Live evidence for why this rule exists: synthetic postbacks once wrote four fake deposits onto real members in Joinvoo. A guard in code is cheaper than an apology.

## 5. Duplicates

**Hard duplicate:** same `event_id` → the second insert is a no-op; respond `{ok:true, duplicate:true}`; nothing is counted twice. The network's `event_id` is authoritative.

**Soft duplicate:** no `event_id`, or a different `event_id`, but the same `(trader_id, kind, amount)` arrived within **120 seconds** → store it, mark `state='ignored'`, `ignore_reason='duplicate_soft'`, and surface it in the dashboard. Deliberately conservative: a genuine second $10 deposit two minutes after the first is possible, so it is flagged, not deleted.

## 6. Status mapping

| Inbound `status` | `kind` |
|---|---|
| `reg`, `registration`, `register`, `signup` | `reg` |
| `ftd`, `first_deposit`, `firstdeposit` | `ftd` |
| `dep`, `redep`, `deposit`, `repeat_deposit`, `redeposit` | `dep` |
| anything else | `ignored` (`ignore_reason='bad_kind'`) |

If both `status` and `net` are absent → `ignored`.

## 7. Parked pool lifecycle

```
new ──► matched        (rule 1–4 hit)
  └──► parked ──► matched   (member appears later, ≤ 48 h)
            └──► expired   (> 48 h, still forwarded unattributed)
  └──► ignored          (stub guard, duplicate, bad kind)
```

- A parked event is re-run through the **whole** rule set every 60 s by the worker.
- Trigger points for an immediate re-run (do not wait for the tick):
  - a new `members` row is created (`POST /api/join`) — re-run parked events whose `trader_id` or `aff_track` matches that member;
  - an `accounts` row is created — re-run parked events with that `trader_id`.
- After 48 h the event becomes `expired` and is **still forwarded** to Joinvoo unattributed during the parallel run. Expiry is not deletion.

## 8. Honesty rules (non-negotiable)

1. The dashboard always shows the **unmatched ratio** for the selected period. It is never hidden, never rounded to zero, never omitted when it is bad.
2. `revenue` is the sum of matched `ftd` + `dep` amounts only. Parked and expired money is reported separately as `unattributed_revenue`.
3. `matched %` is computed as `matched events / (matched + parked + expired)`. `ignored` events are excluded from the denominator.
4. A metric that cannot be computed (no spend entered, no clicks) renders as `—`, never as `0` or `∞`.

## 9. Worked examples

**E1 — clean Path A**
Ad click `/c/7K2M9QX4AB?campaign=NG_Broad&ttclid=E.C.P` → click stored → member `7000000001` joins with payload → `members.click_id='7K2M9QX4AB'` → postback `status=ftd&trader_id=197512345&afftrack=7000000001&amount=50` → rule 1 hits → `matched, path=afftrack, confidence=100`; revenue +50; campaign `NG_Broad` credited.

**E2 — Path C recovery**
Customer registers through a bare affiliate link, no click id, no afftrack. Postback arrives with `trader_id=197318401`, amount 10, `afftrack` empty. Rule 2 misses (no account link), rule 4 hits `trading-bot.db` → `telegram_id=6956546116` → member exists → `matched, path=trader_id, confidence=90`. Ad context is `NULL`; the member is named. This is the 51 %-yesterday, 84 %-ceiling case.

**E3 — deposit before the person connects**
Postback `trader_id=197999999` $25 at 18:29. No `accounts` row, no bot DB row → `parked`. At 21:05 the person connects their account in the trading bot; the Phase 2 hook (or the bot DB poll) creates the `accounts` row → parked event re-runs → `matched, path=trader_id, confidence=90`, `decided_at` 3.5 h after arrival.

**E4 — stub**
`trader_id=1&status=ftd&amount=100&afftrack=TEST-RECON-1` → `ignored / stub_guard`. Counted nowhere.

**E5 — second Telegram id on the same account**
Member A owns `iq_user_id=197318401`. Member B calls `/api/join` and later the bot reports the same id. Link refused (`account_claimed`); the event attributes to A; B stays a member with zero value until they link a different account.
