## Phase

<!-- e.g. Phase 2 — postback receiver, matcher, parked pool -->

## What was built

<!-- five lines or fewer -->

## Proof output

<!-- paste the complete terminal output of the phase proof script -->

```
(paste here)
```

## Deviations from the directive

<!-- state them plainly; "none" is a valid answer -->

## Not done

<!-- list anything in the directive that is not met, or "nothing" -->

## Checklist

- [ ] `node --test` passes
- [ ] `node --check` passes on every changed `.js` file
- [ ] Proof script run against the real service, output pasted above
- [ ] Boots clean from an empty database
- [ ] Boots clean from the previous phase's database
- [ ] Restart with data intact
- [ ] No secret, token, password or real affiliate id in the diff
- [ ] No dependency added to `package.json`
- [ ] No writes to `trading-bot.db`, `gatebot1.db`, `brand-two-onboard.db`, `recon.db`
