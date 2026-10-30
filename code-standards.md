# Code Standards

> Coding conventions and rules for the Warehouse app. Source: AGENTS.md, docs/agents/ORCHESTRATION.md, README.md.

## General
- **Language:** TypeScript (strict). No `any` without justification.
- **Framework:** Next.js 16 App Router, React 19, Tailwind v4.
- **Styling:** shadcn/ui primitives from `src/components/ui/`. RTL on. Tailwind v4. Design tokens in `globals.css`.
- **DB:** Postgres 15 (self-hosted Supabase). Migrations are new files only, numbered sequentially.

## Conventions
- **Conventional Commits:** `feat(module): …`, `fix(module): …`, `chore: …`, `test(module): …`.
- **Module scope in commit:** always include the module name.
- **Branch naming:** `feat/<ticket-id>-<slug>`, `fix/<id>-…`, `chore/<id>-…`, from `master`.

## SQL & Database
- Money and quantity maths in SQL `numeric`. Never floating point.
- Every movement has an actor. Ledger is append-only — only `ledger` module writes `stock_movements`.
- Grants: select/insert/update/delete only. Never TRUNCATE/REFERENCES/TRIGGER to app role.
- Tenant isolation: forced RLS, composite tenant FKs. App runs as `authenticated`, never as owner.
- Migration files: `NNNN_<module>_<what>.sql`. Never edit an applied migration.
- RLS: `set_config('app.tenant_id', $1, true)` inside a transaction.

## Frontend
- **RTL-first:** `<html lang="ar" dir="rtl">`. Arabic is primary.
- **Latin digits** for numbers. Codes/SKUs in `.ltr-value` (LTR inside RTL).
- **Every string in both AR and EN:** i18n keys in `src/i18n/ar.json` and `en.json`.
- **Phone-first:** 390px baseline. 44px minimum tap targets.
- **Shared styling in one place:** `globals.css` + shadcn tokens. No per-screen field styling.
- **shadcn/ui:** from `src/components/ui/`. RTL on.
- **Components:** shared components in `src/modules/shell/ui/`.

## Testing
- **Gate:** `npm run ci` (tsc + eslint + all tests, 0 skipped).
- **Ledger changes:** also `npm run e2e -- --no-http`.
- **Test framework:** node:test. Playwright for E2E.
- **Every acceptance criterion** must have a test that fails without the change.
- **No skipped tests** in CI.

## Import Rules (ESLint enforced)
1. `domain/` imports nothing from `server/`, `ui/`, `next`, `pg`, or React.
2. `ui/` never imports `server/` directly.
3. Modules import each other only through `index.ts`.
4. Only `ledger` writes `stock_movements`.

## i18n
- Keys under module namespace (e.g., `stock.*`, `intake.*`).
- Parity enforced by CI (F-08): ar/en must have same keys (except CLDR plural forms).
- Missing key fails CI.

## Files & Paths
- `src/app/*`: thin pages, no SQL, no business rules.
- `src/modules/<m>/domain/`: pure rules, no I/O.
- `src/modules/<m>/server/`: DB access + use-cases.
- `src/modules/<m>/ui/`: React components.
- `src/modules/<m>/index.ts`: public API.
- `supabase/migrations/`: schema changes (new files only).
- `tests/<m>/`: tests per module.

## Environment
- Load `.env`. Set `MIGRATE_DATABASE_URL=$DATABASE_URL` for `npm run ci`.
- Local Postgres 15 on 127.0.0.1:55499.
- `gh` CLI at `C:\Program Files\GitHub CLI`.