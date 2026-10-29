# Orchestration — how the lead agent runs small agents on this repo

> The **lead agent** (mastermind) plans, dispatches, reviews and merges.
> **Worker agents** each do ONE ticket in ONE module and return proof.
> Workers know nothing except what the ticket packet gives them — so the packet must be complete.

## 1. Roles
| Role | Does | Never does |
|---|---|---|
| **Lead** | Picks the next tickets from `ACTION-PLAN.md`, writes packets, dispatches, runs the two reviews, runs the gate, merges, updates the vault + docs | Write large features itself while workers are running in the same files |
| **Builder** (worker) | Implements one ticket test-first on its own branch, runs the gate, reports | Touch files outside the ticket's *owned paths*; edit an applied migration; change another module's internals |
| **Spec reviewer** (worker) | Checks the diff against the ticket's acceptance criteria and MAP rules | Rewrite the code |
| **Quality reviewer** (worker) | Checks correctness, security (RLS, tenant, actor), tests that can fail, naming, i18n | Approve a ledger change without reading the SQL |
| **Design reviewer** (worker, UI tickets) | Runs Impeccable `critique` + `audit` on the rendered screen, AR + EN, 390 + 1280 px | Judge from markup alone |

## 2. Ticket packet (the lead copies this into every dispatch)
```markdown
# <ID> <title>
Module: <M.. name>  ·  Branch: feat/<id>-<slug>  ·  Size: S/M/L
## Goal (one sentence, business words)
## Owned paths (the ONLY files you may create/edit)
- src/modules/<m>/...
- supabase/migrations/<NNNN>_<m>_<what>.sql   (new file only)
- tests/<m>/...
- src/i18n/{ar,en}.json  — keys under "<namespace>.*" only
## Read first
- AGENTS.md, docs/architecture/MAP.md (module row + rules), DESIGN.md (UI tickets)
- <specific files to read and why>
## Contract
- Public functions / routes / tables this ticket adds or changes, with signatures
## Rules that apply (copy the relevant ones)
- Ledger rows only through ledger.postMovement; every row has an actor
- Tenant: set_config('app.tenant_id', $1, true) inside a tx; RLS forced + composite FKs
- Money/qty maths in SQL numeric; assert exact strings in tests
- Latin digits; AR + EN strings for every label; codes in .ltr-value
## Acceptance criteria (each one becomes a test)
1. ...
## Out of scope
## Proof to return
- `npm run ci` tail (tests count, 0 skipped)
- for UI: Playwright screenshots AR/EN × 390/1280 paths
- list of files changed; anything not done and why
```

## 3. Definition of Done (a ticket is not done until all are true)
1. Acceptance criteria each covered by a test that **fails without the change** (reviewer checks one by reverting).
2. `npm run ci` green: tsc + eslint + all tests, **0 skipped**.
3. Ledger-touching: `npm run e2e -- --no-http` green and the reconciliation still matches.
4. UI: renders in AR (RTL) and EN (LTR) at 390 px and 1280 px; Impeccable `audit` has no blocking findings; every string from i18n; keyboard reachable; empty/loading/error states exist.
5. Docs: MAP.md row updated (new files/tables/routes); new term → `GLOSSARY.md`; real decision → `docs/adr/NNNN-*.md`.
6. Two reviews passed (spec, then quality; + design for UI).
7. PR merged by the lead; GitHub issue closed with the PR link; Obsidian vault Status updated at the end of each phase.

## 4. Parallel work without collisions
- **One module per worker at a time.** Two workers never own the same path.
- **Shared files are lead-only:** `src/app/globals.css`, `src/components/ui/*`, `components.json`, `package.json`, `src/i18n/index.ts`, `src/modules/shell/domain/nav.ts`, `docs/architecture/MAP.md`. A worker needing a change there writes it in its report; the lead applies it.
- **Migration numbers are assigned by the lead** in the packet (no two branches create the same `NNNN`).
- i18n JSON: each worker edits only its namespace; the lead resolves merge order.
- Merge order inside a phase follows the dependency column in `ACTION-PLAN.md`.

## 5. Branches, commits, PRs
- Branch: `feat/<ticket-id>-<slug>`, `fix/<id>-…`, `chore/<id>-…`, from `master`.
- Commits: Conventional Commits with module scope — `feat(receiving): …`, `fix(ledger): …`.
- PR title = ticket id + title; body uses `.github/pull_request_template.md` (ticket `F-06`); links the issue (`Closes #n`).
- `master` protected: CI required, no direct pushes (after `F-06`).

## 6. Review prompts (lead pastes these)
**Spec review:** "Here is ticket <packet> and diff <range>. For each acceptance criterion say met / not met with file:line evidence. List any file changed outside owned paths. List any MAP.md rule broken."
**Quality review:** "Review diff <range> on a multi-tenant, append-only stock ledger. Check: RLS + forced + composite FKs on new tables; grants only s/i/u/d; every movement has an actor; idempotency keys; advisory lock on debits; SQL numeric for money/qty; tests that would fail without the change; error messages in AR/EN; no secrets. Return blocking / non-blocking."
**Design review:** "Open <routes> signed in as <role>, in AR and EN, at 390 and 1280 px. Run `/impeccable critique` and `/impeccable audit` on each. Return screenshots and blocking findings only."

## 7. When something goes wrong
- A worker dies mid-task (billing/timeout): check `git status` on its branch and the DB for orphan test tenants **before** re-dispatching — the work is often complete but unverified.
- A reviewer and builder disagree twice: lead decides and records the reason in the PR.
- A ticket grows beyond its size: stop, split, re-plan; never let one PR span modules.

## 8. Lead's loop (per phase)
1. Pick ready tickets (dependencies merged) → write packets → dispatch builders in parallel (max 3–4 to keep review load sane).
2. As each returns: spec review → quality review (→ design review) → fix loop → merge.
3. After the last merge of the phase: full gate on `master`, e2e with HTTP, a live walk-through as each role, demo screenshots to the owner, update vault Status/Decisions/Lessons, close the milestone.
