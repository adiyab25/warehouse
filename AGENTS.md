# AGENTS.md

Inventory backbone — one central warehouse feeding 14 branches. Movements are
the truth; on-hand is derived. See `README.md` for setup, gates and rules.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `adiyab25/warehouse`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Start here

1. `docs/architecture/MAP.md` — every module, its files, tables, routes, tests, and the import rules.
2. `docs/plan/ACTION-PLAN.md` — phases and tickets (each ticket = one GitHub issue).
3. `docs/agents/ORCHESTRATION.md` — ticket packet, Definition of Done, review prompts, parallel-work rules.
4. `docs/design/DESIGN-DIRECTION.md` (until `DESIGN.md` exists) — how the UI looks; UI is shadcn/ui (`src/components/ui`, RTL on) on Tailwind v4. Use the `impeccable` skill for design work.

Gate before any PR: `npm run ci` (tsc + eslint + all tests, 0 skipped). Ledger changes also run `npm run e2e -- --no-http`.
