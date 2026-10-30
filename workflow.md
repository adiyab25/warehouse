# Workflow

> How work flows through this project. Based on `docs/agents/ORCHESTRATION.md` and the kickoff prompt.

## Roles
- **Lead (you/Hermes):** picks tickets, writes packets, dispatches workers, reviews, merges, updates docs.
- **Builder (worker):** implements one ticket test-first on its own branch, runs the gate, reports.
- **Spec reviewer:** checks diff against acceptance criteria and MAP rules.
- **Quality reviewer:** checks correctness, security (RLS, tenant, actor), tests.
- **Design reviewer (UI tickets):** Impeccable critique + audit on rendered screen, AR+EN, 390+1280px.

## Lead's Loop (per phase)
1. Pick ready tickets (dependencies merged) → write packets → dispatch builders in parallel (max 3–4).
2. As each returns: spec review → quality review (→ design review) → fix loop → merge.
3. After last merge of phase: full gate on master, e2e with HTTP, live walk-through as each role, demo screenshots, update vault Status/Decisions/Lessons, close milestone.

## Ticket Packet (copy into every dispatch)
```
# <ID> <title>
Module: <M.. name>  ·  Branch: feat/<id>-<slug>  ·  Size: S/M/L
## Goal (one sentence, business words)
## Owned paths (the ONLY files you may create/edit)
## Read first
## Contract
## Rules that apply
## Acceptance criteria (each one becomes a test)
## Out of scope
## Proof to return
```

## Definition of Done
1. Acceptance criteria each covered by a test that fails without the change.
2. `npm run ci` green: tsc + eslint + all tests, 0 skipped.
3. Ledger-touching: `npm run e2e -- --no-http` green + reconciliation matches.
4. UI: renders AR (RTL) and EN (LTR) at 390px and 1280px; Impeccable audit no blocking findings; every string from i18n; keyboard reachable; empty/loading/error states exist.
5. Docs: MAP.md row updated; new term → GLOSSARY.md; real decision → docs/adr/.
6. Two reviews passed (spec, then quality; + design for UI).
7. PR merged by lead; GitHub issue closed with PR link; Obsidian vault Status updated.

## Parallel Work Rules
- One module per worker at a time. Two workers never own the same path.
- Shared files are lead-only: globals.css, components/ui/*, package.json, i18n/index.ts, nav.ts, MAP.md.
- Migration numbers assigned by the lead in the packet.
- i18n JSON: each worker edits only its namespace; lead resolves merge order.
- Merge order follows dependency column in ACTION-PLAN.md.

## Branches, Commits, PRs
- Branch: `feat/<ticket-id>-<slug>`, `fix/<id>-…`, `chore/<id>-…`, from `master`.
- Commits: Conventional Commits with module scope — `feat(receiving): …`, `fix(ledger): …`
- PR title = ticket id + title; body uses PR template; links the issue (`Closes #n`).
- Master protected: CI required, 1 PR review, no direct pushes, no force pushes.

## When Something Goes Wrong
- Worker dies mid-task: check `git status` on its branch and DB for orphan test tenants before re-dispatching.
- Reviewer and builder disagree twice: lead decides and records reason in PR.
- Ticket grows beyond size: stop, split, re-plan; never let one PR span modules.