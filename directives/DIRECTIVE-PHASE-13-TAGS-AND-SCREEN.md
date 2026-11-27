# DIRECTIVE — PHASE 13: CAMPAIGN TAGS + AD-LINK SCREEN

Repo: `your-org/coinvoo` · branch from `main` @ `5747513` · one PR
Reviewer: Wizard · Target: merge, deploy, then Master creates and copies a link from the dashboard himself

Read `docs/09-one-tap-ad-links.md` first. P1 (ad links, per-click invites, join binding) is live and verified.
This phase adds the two things standing between Master and running an ad without asking anyone for a command:
**the tag string he pastes into Meta**, and **a screen where he creates and copies links**.

P3 (one-tap page) and P4 (offer rotation) are **dropped** — traffic goes to the channel, and the gate bot hands
out the broker link itself. Do not build them.

---

## HARD RULES

- Zero dependencies. Plain ESM `.js`, `node:http` / `node:sqlite` / `node:crypto`. No frameworks, no new modules.
- `npm test` **100 % green**; the 296 existing tests must not regress.
- Only the files named here are in scope. Work only inside them.
- `AFF_KEY`, tokens and the gate secret are read from env, never committed or logged.
- The screen must work with JavaScript disabled — the links are the point, not the chrome.

---

## PART A — the tag string (`src/routes/adlinks.js`)

`GET /api/ad-links/:id/url?tags=1` returns the link with Meta's dynamic parameters appended, so Master can paste
one string into the ad's **URL parameters** field:

```
{{ad.name}}|{{adset.name}}|{{campaign.name}}|{{placement}}|{{site_source_name}}|{{campaign.id}}|{{adset.id}}|{{ad.id}}
```

- Return `{ url, tags, template }` where `url` is `https://<host>/c/<code>` and `tags` is the string above.
- `template` is the full URL already carrying `?t={{ad.id}}` style shorthand — **use one compact parameter**:
  append `?m={{ad.id}}|{{adset.id}}|{{campaign.id}}|{{placement}}` so nothing is URL-encoded twice and Meta cannot
  mangle eight separate keys.
- Parsing: on `/c/<code>`, if `m` is present, split on `|` into `ad_id|adset_id|campaign_id|placement` and store
  each on the click (columns `ad_id`, `adset_id`, `campaign_id`, `placement`, all TEXT, migration `012`). Names keep
  arriving by the existing keys; ids are what the reports need.
- Reuse the existing `MACRO_RE` rule: an unresolved `{{…}}` is never stored as a value.

## PART B — migration (`migrations/012_click_ad_ids.sql`, new)

```sql
ALTER TABLE clicks ADD COLUMN ad_id TEXT;
ALTER TABLE clicks ADD COLUMN adset_id TEXT;
ALTER TABLE clicks ADD COLUMN campaign_id TEXT;
ALTER TABLE clicks ADD COLUMN placement TEXT;
```

## PART C — the screen (`src/routes/dash.js`, `src/ui/`)

A page at **`/dash/ad-links`**, linked from the main dashboard nav as **Ad links**.

- Table: `code` · `label` · `campaign` · `active` · `clicks` · `joins` · the copyable URL. Newest first.
- **Create** form: label (required), campaign / adset / ad (optional). One button.
- Row actions: **Copy link**, **Copy tags**, **Edit** (label/campaign/adset/ad), **On/Off**.
- "Copy tags" copies the PART A string and shows it in a `<code>` block so it can be selected by hand.
- A short line under the table: *Paste the link into the ad's destination, and the tags into URL parameters.*
- Same session auth and same-origin POST checks as the rest of the dashboard.

## PART D — tests (`test/adlinks.test.js`)

1. `GET /api/ad-links/:id/url?tags=1` returns the URL and the tag string, unencoded `|` separators intact.
2. `/c/<code>?m=ad|adset|campaign|placement` stores all four; `?m` with fewer parts stores what it has.
3. A macro inside `m` is not stored.
4. `/dash/ad-links` returns 200 signed in, 302 to sign-in when not, and renders a created link's code and URL.
5. Copy-tags block contains the exact template string.
6. An ad link with clicks but no joins shows `joins 0`, not blank.

---

## Do not

- Do not build P3 (one-tap page) or P4 (offer rotation).
- Do not change `/c/:token`, the matcher, the Meta sender or `aff-recon`.
- Do not add charts, filters or pagination — the list is short by design.

## Done when

Suite green, PR open, `/dash/ad-links` reachable and signed-in-safe, and one link created from the screen shows a
click and a join after a real visit.
