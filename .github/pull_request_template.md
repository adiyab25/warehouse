## Ticket

<!-- PR title = ticket id + title, e.g. "F-06 GitHub Actions CI + PR template". -->

**F-<id> — <title>**

- Module: <!-- e.g. platform, receiving, ledger, … -->
- Branch: `feat/<id>-<slug>`

Closes #<issue-number>

## Summary

<!-- One or two sentences, business words: what this change does and why. -->

## Acceptance checklist

<!-- Every acceptance criterion becomes a test. Tick each when proven. -->

- [ ] Acceptance criteria covered by tests that **fail without the change**.
- [ ] `npm run ci` green: tsc + eslint + all tests, **0 skipped**.
- [ ] <!-- (ledger tickets) `npm run e2e -- --no-http` green, reconciliation still matches. -->
- [ ] <!-- (UI tickets) renders AR (RTL) and EN (LTR) at 390 px and 1280 px. -->

## Screenshots

<!-- UI tickets only: AR/EN × 390/1280 px screenshots. Delete this section otherwise. -->

## Gate output

<!-- Tail of `npm run ci` — tests count, pass count, 0 skipped. -->

```text

```
