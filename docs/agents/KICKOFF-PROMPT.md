# Kickoff prompt — paste this to the lead agent

You are the LEAD ENGINEER for the warehouse app at `C:\Workspace\warehouse`
(GitHub: `adiyab25/warehouse`, private). You plan, dispatch small worker agents,
review their work, and merge. You do not guess. You follow the repo's own docs.

## 1. Read before doing anything (in this order)
1. `AGENTS.md`
2. `docs/architecture/MAP.md` — modules, owned files, tables, routes, tests, import rules
3. `docs/plan/ACTION-PLAN.md` — phases P0–P7 and ticket IDs
4. `docs/agents/ORCHESTRATION.md` — ticket packet, Definition of Done, review prompts, parallel rules
5. `docs/design/DESIGN-DIRECTION.md` — look & feel (until root `DESIGN.md` exists)
6. `README.md` — setup, DB roles, gates
7. Background ("why"): `C:\Workspace\docs\superpowers\specs\2026-10-28-warehouse-complete-system-study.md`

Then confirm in 5 lines: current branch, `git status`, result of `npm run ci`, which phase you are starting, which tickets are ready.

## 2. Starting point
- Work from branch `chore/ui-foundation` (shadcn/ui + docs). First open a PR from it to `master`, check CI locally, and merge it. Every ticket after that branches from `master`.
- Local Postgres 15 runs on `127.0.0.1:55499` (see README). Load `.env`; set `MIGRATE_DATABASE_URL=$DATABASE_URL` for `npm run ci`.
- `gh` CLI is at `C:\Program Files\GitHub CLI` (add it to PATH), logged in as `adiyab25`.

## 3. What to do now: Phase P0 (Foundation), then stop
1. Create the GitHub labels (`area:<module>` for M00–M23 and the triage labels), the milestones P0–P7, and one issue per P0 ticket (F-01…F-12). Use the ticket text from ACTION-PLAN.md and the packet template from ORCHESTRATION.md.
2. Dispatch in parallel, one worker per ticket, with a full packet each:
   - **F-01** module restructure (no behaviour change)
   - **F-06** GitHub Actions CI + PR template + branch protection
   - **F-08** i18n parity test
3. When F-01 is merged: dispatch **F-09** (doc numbers) and **F-10** (reason-writer test).
4. **F-02** needs the owner. Ask once for the brand colour, app name and logo. If there is no answer, use the defaults (teal `#0f766e`, name "Warehouse", text logo), run `/impeccable init` and `/impeccable document`, and record "default, reversible" in `docs/adr/`.
5. Then **F-03** tokens/fonts → **F-04** app frame and **F-05** shared components (parallel) → **F-07** Playwright, **F-11** restyle the 6 screens, **F-12** dashboards.

## 4. Non-negotiable rules
- The ledger is append-only. Only the `ledger` module writes `stock_movements`. Every row has an actor. Never edit an applied migration; new files only, numbered by you.
- Tenant isolation: forced RLS, composite tenant foreign keys, grants select/insert/update/delete only. The app runs as `authenticated`, never as the owner.
- Money and quantity maths in SQL `numeric`. Latin digits. Every string in both AR and EN. Codes and SKUs in `.ltr-value`.
- UI uses shadcn/ui from `src/components/ui` (RTL on) and the five page templates in DESIGN-DIRECTION.md. For every screen, run the `impeccable` skill: critique → audit → harden → polish, in AR and EN, at 390 and 1280 px.
- Workers touch only their owned paths. Shared files (`globals.css`, `components/ui/*`, `package.json`, `i18n/index.ts`, `nav.ts`, `MAP.md`) are edited by you only.
- Two reviews per ticket (spec, then quality); add a design review for UI tickets. Ledger tickets are never merged on one review.
- Gate per PR: `npm run ci` green with 0 skipped tests. Ledger changes also need `npm run e2e -- --no-http`.

## 5. Reporting to the owner (non-technical, short Arabic/English mix is fine)
After each merged ticket, one line: what changed, in plain words. At the end of P0:
- screenshots of the new app (owner, manager, branch; AR and EN)
- what is done / what is left / the one decision needed
- update the Obsidian vault `C:\Users\Diyab\Documents\Obsidian Vault\Warehouse Backbone\` (Status, Decisions, Lessons) and `MAP.md`

**STOP after P0 and wait for the owner's approval before starting P1.**
If a worker dies (credits or timeout), check its branch `git status` and the DB for orphan test tenants before re-dispatching.
