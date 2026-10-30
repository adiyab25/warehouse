# Warehouse App — Orchestration Plan (Plan 1: Lean)

Purpose: split the Plan 1 backlog into small, self-contained task cards that local model agents can execute one at a time, with the orchestrator controlling order, context, and review.

---

## 0. Resolve these BEFORE dispatching any agent

The source docs contradict each other. Agents will guess wrong if these stay open. Decide, then record in the Decisions log.

| # | Conflict | Where | Recommended |
|---|---|---|---|
| D1 | Auth: "Supabase auth" vs "username/password, bcrypt, session cookie" | project-overview vs architecture-context | Architecture wins (custom sessions, raw Postgres). Fix overview. |
| D2 | DB host: "Self-hosted Supabase" vs "Postgres 15 managed externally, not Supabase hosted" | same | Raw Postgres. Remove Supabase wording; keep `supabase/migrations/` folder name or rename to `db/migrations/` (pick one). |
| D3 | Permission change effect: "next request, no re-login" vs "session version bump, invalidate sessions, show refresh notice" | overview vs architecture | Session version bump. On next request, re-load permissions from DB and continue (no forced login). Overview wording to match. |
| D4 | Test count: 414 | overview vs tracker | Same number, fine. Agents must never reduce it. |
| D5 | `app_users.role` enum → `role_id`: backfill strategy not written | tracker 1A.1 | Migration must (1) create tables, (2) seed system roles per tenant, (3) backfill `role_id` from old enum, (4) set NOT NULL, (5) drop enum column in a LATER migration after code is switched. |
| D6 | Existing movements have no cost | tracker 1B.3 | Add nullable `unit_cost_piastres`, backfill from current variant cost, then NOT NULL only for new rows (check constraint on `created_at >` cutover) or backfill 0 with a flag. Decide. |

---

## 1. Orchestrator protocol

1. Pick the next task whose dependencies are all ✅ (see §5 waves).
2. Build the agent prompt from: **§2 Global Rules** + **the task card** + **only the files listed in the card's `Read` field**. Do not feed whole architecture docs to small models.
3. Dispatch to the agent named in the card.
4. Run the **gate** (§7). If it fails, return the failing output to the same agent once. If it fails twice, escalate to a bigger model or to you.
5. A *different* agent (Reviewer) checks the diff against the card's acceptance criteria and global rules.
6. Merge, mark the task ✅ in `progress-tracker.md`, move on.

One task = one branch = one PR. Never batch tasks.

---

## 2. Global Rules (paste at the top of EVERY agent prompt)

```
You are working in a Next.js 16 App Router + React 19 + Tailwind v4 + shadcn/ui repo.
Raw Postgres 15, plain SQL, no ORM. Arabic-first RTL, phone-first (375px).

HARD RULES
1. All qty and money are INTEGERS (piastres for EGP). Never floats.
2. SQL lives ONLY in src/modules/<name>/db.ts. Never string-interpolate filters;
   use parameterised queries.
3. Every query runs inside withTenant(tenantId). Every table has tenant_id.
4. stock_movements is append-only. Never UPDATE or DELETE it. Only the ledger module writes it.
5. Migrations: new file supabase/migrations/NNNN_description.sql. NEVER edit a committed migration.
6. A module may import only from: platform, shell, auth, ledger. Never from a sibling
   domain module — call its service via index.ts.
7. Every server action and API route starts with:
   const session = await getSession(req); requirePermission(session, '<key>');
8. UI: hide (do not just disable) controls the user lacks permission for.
9. RTL: use logical Tailwind classes only (ms-/me-/ps-/pe-/text-start/text-end/start-0/end-0/border-s).
   Never ml-/mr-/pl-/pr-/text-left/text-right. Codes, SKUs, doc numbers, barcodes, EGP amounts
   go inside <span className="ltr-value">.
10. Tap targets >= 44px. Flat design: no shadows, no gradients, 1px border, 0.5rem radius.
11. i18n: every user-visible string needs a key in BOTH src/i18n/ar.json and en.json
    (module.object.action). Never concatenate translated strings. Latin digits 0-9.
12. Do not touch files outside the card's "Touch" list. If you need to, STOP and say so.
13. Add or update tests. Do not delete or skip existing tests. 414 must keep passing.
14. Output: a unified diff or full file contents per file. No prose inside code files.
```

---

## 3. Agent roster

Give each a narrow role and a narrow slice of context.

| Agent | Scope | Gets as context | Typical tasks |
|---|---|---|---|
| **A-DB** | SQL migrations, `db.ts` queries, RLS/tenant checks | Global rules, migration list, relevant table DDL | 1A.1, 1A.2, 1B.3, 1D.3, 1D.7, 1E.1 |
| **A-SVC** | `service.ts`, `schema.ts` (Zod), permission guards, events | Global rules, module's db.ts signatures, permission key table | 1A.3, 1A.4, 1D.1, 1D.2 |
| **A-UI** | React components, screens, RTL, i18n | Global rules, ui-context.md (tokens, patterns, RTL table), component props | 1C.2–1C.7, 1G.* |
| **A-SCREEN** | Full list/detail/form screens composed from shared components | Global rules, screen pattern for that type, module `index.ts` | 1A.6–1A.8, 1B.1, 1B.4, 1D.4–1D.6 |
| **A-TEST** | node:test unit/contract tests, Playwright specs | Global rules, the code under test | Pairs with every task |
| **A-REVIEW** | Checks diff vs card + global rules, no writing | Diff + card + Global Rules | Every task |
| **A-DOCS** | Updates tracker, decisions log, architecture docs | Diff summary | After merge |

If you only have one model, run the same roles as separate prompts — the narrow context is what matters.

---

## 4. Task card template

```
ID:          1A.1
Title:       ...
Agent:       A-DB
Depends on:  none | IDs
Branch:      feat/1a1-roles-migration
Read:        (files the agent must see, nothing else)
Touch:       (the ONLY files it may create/edit)
Do:          (numbered, concrete steps)
Acceptance:  (checkable statements)
Tests:       (what must exist)
Out of scope:(what NOT to do)
```

---

## 5. Dependency graph and waves

```
Wave 0  Decisions D1–D6 + repo audit (R0)
Wave 1  1C.1 (ListFilter)  ·  1A.1 → 1A.2  ·  1B.2/1B.3  ·  1G.7/1G.8/1G.9/1G.10/1G.11 (shared UI, independent)
Wave 2  1A.3 → 1A.4 → 1A.5  ·  1C.2–1C.7  ·  1E.1
Wave 3  1A.6/1A.7/1A.8  ·  1B.1/1B.4/1B.5  ·  1C.8/1C.9  ·  1D.1/1D.7
Wave 4  1D.2/1D.3  ·  1D.4/1D.5/1D.6  ·  1E.2/1E.3  ·  1D.8
Wave 5  1F.1–1F.4 → 1F.5  ·  1G.1–1G.6
Wave 6  1E.4 runbook  ·  full E2E pass  ·  Plan 1 sign-off
```

Hard dependencies to enforce:
- 1A.3 (requirePermission) needs 1A.1 + 1A.2.
- Every new screen (1A.6+, 1B.*, 1D.4–1D.6) needs 1A.5 (`PermissionGate`).
- 1C.9 needs 1C.1–1C.7.
- 1F.* needs 1B.2 + 1B.3 + 1G.11.
- 1D.8 (timeline) needs 1E.1.
- 1D.7 (reason codes) before 1D.4/1D.5 post/process actions are finished.

---

## 6. Task cards

### WAVE 0 — Audit

**R0 — Repo audit (A-REVIEW, read-only)**
- Do: list every call to `requireRole(` and every place that reads `app_users.role`; list all routes/actions lacking any guard; list all existing list screens and how they query.
- Output: `docs/architecture/audit-r0.md` with three tables (role usages, unguarded routes, list screens).
- Acceptance: file exists; counts reported; no source changes.
- Why: 1A.3 and 1C.9 become mechanical once this list exists.

---

### WAVE 1 — Foundations (parallel safe)

**1A.1 — Roles/permissions tables** · A-DB
- Read: latest 2 migrations, `app_users` DDL, `platform/db.ts`.
- Touch: `supabase/migrations/0016_roles_permissions.sql`, test file.
- Do:
  1. Create `roles`, `permissions`, `role_permissions` exactly as in architecture-context (tenant_id on roles; ENABLE + FORCE RLS with tenant policy matching other tables).
  2. Add `app_users.role_id uuid REFERENCES roles(id)` (nullable for now).
  3. Insert the full permission catalogue (all keys in the table, with ar + en descriptions).
- Acceptance: migration applies on a clean DB and on a DB with data; RLS policy present on `roles` and `role_permissions`; old `role` enum column untouched.
- Out of scope: seeding roles, dropping the enum.

**1A.2 — Seed system roles + backfill** · A-DB (depends 1A.1)
- Touch: `0017_seed_system_roles.sql`.
- Do: per tenant, insert `owner`, `manager`, `branch` with `is_system=true`; insert default `role_permissions`; backfill `app_users.role_id` from enum; set NOT NULL. Owner gets every key. Manager: everything except `roles:manage`, `users:manage`, `api:manage`, `settings:manage`. Branch: `stock:view`, `requisitions:view/create/confirm/cancel`, `returns:view/create`, `usage:view/create`, `reports:basic`, `items:view`, `locations:view`.
- Acceptance: no user with NULL `role_id`; each tenant has 3 system roles; owner has `roles:manage`.
- Also: `next_doc_number`-style helper for creating seed roles when a new tenant is created (function or documented seed step).

**1C.1 — ListFilter + parseListFilter** · A-SVC
- Touch: `src/lib/list-filter.ts` (or `platform/`), `platform/db.ts` (WHERE builder), `tests/list-filter.test.ts`.
- Do: implement `ListFilter` type, `parseListFilter(searchParams)` (clamp `limit` ≤ 100, default 25; validate `sortDir`; parse dates; split multi-status on comma), and a builder returning `{ where: string, params: unknown[] }` using `$n` placeholders from an allow-list of columns supplied by the caller.
- Acceptance: sort column must be allow-listed (else ignored); no interpolation of user values; round-trip test URL → filter → URL.

**1B.2 + 1B.3 — Unit cost + movement snapshot** · A-DB (one PR, two migrations)
- Do: `item_variants.unit_cost_piastres integer NOT NULL DEFAULT 0 CHECK (>= 0)`; `stock_movements.unit_cost_piastres integer` per D6; ledger service snapshots the variant's current cost at insert time inside the same transaction.
- Acceptance: changing a variant's cost does not change old movement rows; test proves it; ledger remains the only writer.
- Out of scope: any UI.

**Shared UI pack (A-UI, each its own PR, no dependencies)**
- **1G.7 Toast**, **1G.8 Skeleton**, **1G.9 ErrorState (with retry)**, **1G.10 FormField**, **1G.11 MoneyDisplay**.
- Location: `src/modules/shell/ui/`; export via `index.ts`.
- MoneyDisplay acceptance: input integer piastres → `١٬٢٥٠٫٠٠`-style per ui-context is for Arabic display; but numbers must be Latin digits per i18n rule — **confirm which wins (ui-context contradicts itself: "Latin digits" vs Arabic-digit currency example)**. Default: Latin digits, `1,250.00 EGP` inside `ltr-value`.
- Each component: story/test with RTL render, 44px targets, i18n keys in both files.

---

### WAVE 2 — Auth core, filter UI, audit

**1A.3 — `requirePermission` replaces `requireRole`** · A-SVC (depends 1A.2, R0)
- Touch: `auth/service.ts`, every file listed in R0's role-usage table.
- Do: implement `requirePermission(session, key)` throwing `FORBIDDEN`; load permissions at session creation into the cookie payload; replace each `requireRole` using the mapping table below; keep `requireRole` as a deprecated wrapper until the last call is gone, then delete.
- Mapping (starter): approve/reject → `requisitions:approve`; issue → `requisitions:issue`; receive → `intake:create`; reports cost → `reports:cost`; api keys → `api:manage`.
- Acceptance: zero remaining `requireRole(` calls; a test per role proving allowed and denied paths; 414+ tests green.
- Split into sub-PRs by module if R0 shows > 25 call sites.

**1A.4 — Session version bump** · A-SVC + A-DB (depends 1A.3)
- Do: `roles.permissions_version int`; bump on any `role_permissions` change; session stores version; mismatch → reload permissions from DB, show "session refreshed" flag (per D3).
- Acceptance: test — change a role's permission, existing session loses access on next request without login.

**1A.5 — `usePermissions()` + `PermissionGate`** · A-UI (depends 1A.3)
- Touch: `shell/ui/permission-gate.tsx`, `shell/hooks/use-permissions.ts`.
- Acceptance: `can(key)` and `<PermissionGate permission="x">`; renders nothing when denied; sidebar filtered by permission.

**1C.2–1C.7 — Filter components** · A-UI (one PR each, depends none except i18n)
- `SearchInput` (300ms debounce, ✕ clear), `StatusMultiSelect`, `DateRangePicker` (presets today / this week / this month / custom; DD/MM/YYYY), `BranchSelect` (accepts `hidden` prop), `FilterChip` + `ActiveFilterChips` + "Clear all", mobile bottom-sheet wrapper for `FilterBar`.
- Rule: components are controlled and URL-agnostic. URL wiring happens in 1C.8.
- Acceptance: keyboard + touch usable; 390px render; ar/en keys.

**1E.1 — Audit log module** · A-DB then A-SVC
- Do: `audit_log(id, tenant_id, user_id, action, table_name, record_id, old_values jsonb, new_values jsonb, created_at)`, append-only (no UPDATE/DELETE grants); `audit-log` module exposing `record(...)`; call it from service layer on every mutation (not from db.ts).
- Acceptance: a mutation test in each of requisitions, receiving, catalog writes exactly one audit row; no sibling-module imports (use `platform` event hook or a shared `auditing` helper in `platform`).

---

### WAVE 3 — Management screens + list wiring

**1A.6 Roles screen** · A-SCREEN (depends 1A.4, 1A.5)
- Pattern: "Role management screen" in ui-context. Create/rename role, toggle permissions grouped by module, delete disabled on system roles, owner cannot lose `roles:manage`, assign role per user.
- Guards: `roles:manage` on all actions. Saving calls the version bump.
- Acceptance: cannot delete a role with users; cannot remove `roles:manage` from owner (server-enforced, not just UI).

**1A.7 Users screen** · A-SCREEN (create, assign role, disable, reset password; `users:view` / `users:manage`). Shares password-reset service with 1E.3.

**1A.8 API keys screen** · A-SCREEN (`api:manage`; show key once on creation; revoke).

**1B.1 Items screen** · A-SCREEN (depends 1B.2, 1G.10, 1G.11): items + variants (size, gender), unit cost in EGP input converted to piastres at the boundary.
**1B.4 Locations screen**: branches/shelves + min/max per item.
**1B.5 Categories**: inline on items screen.

**1C.8 URL-persisted filter state** · A-UI: hook `useListFilter()` reading/writing `ListFilter` via search params (shallow navigation, preserves unrelated params).
**1C.9 Wire existing lists** · A-SCREEN, one PR per screen: stock → requisitions → intake. Each `db.ts` list fn accepts `ListFilter`.

**1D.1 Cancel / reject** · A-SVC: new transitions with `requisitions:cancel` / `requisitions:approve`; reason required; ledger untouched unless stock was reserved (then release).
**1D.7 Reason codes** · A-DB + A-SVC: `adjustment_reasons` table; required on scrap, damage, count adjust.

---

### WAVE 4 — Workflows

**1D.3 Reservations** · A-DB + A-SVC (do BEFORE 1D.2): `reservations` table written on approve, released on cancel/issue; `available = on_hand − reserved`; stock guard checks available on issue/approve.
**1D.2 Partial fulfilment + backorder**: remaining lines stay open; status `partial`; second issue allowed.
**1D.4 Returns screen**, **1D.5 Counts screen** (blind count, recount, post adjustment), **1D.6 Usage entry screen** · A-SCREEN, each gated by its permission keys, with filters from the start.
**1E.2 Audit viewer** (`reports:audit`), **1E.3 Password reset flow**, **1D.8 Timeline component + wire into every detail screen**.

---

### WAVE 5 — Reports and QoL

**1F.1 Monthly spend**: `SUM(qty * unit_cost_piastres)` on intake movements by month.
**1F.2 Branch spend**: same on issue movements per branch.
**1F.3 Branch item detail**: item, qty, unit cost, total; filter branch + dates + item/category.
**1F.4 Stock value**: `SUM(on_hand * unit_cost_piastres)` per item/location.
**1F.5 Export Excel + PDF** for all four. All gated `reports:cost`; query functions take `ListFilter`; verify totals against a seeded fixture in tests.

**1G.1 BarcodeScanner**, **1G.2 ItemPicker** (name/size/SKU/barcode, shows on-hand + cost), **1G.3 Requisition templates**, **1G.4 Print CSS**, **1G.5 Low-stock tiles**, **1G.6 Photo upload** (needs storage decision first).

---

### WAVE 6 — Close-out

**1E.4 Backup/restore runbook**: written AND restored into a scratch DB by a human; record date in Incidents table.
**E2E**: Playwright flows — receive → request → approve → issue → confirm; role change takes effect; filter URL shareable; Arabic RTL smoke at 390px.
**Sign-off**: tracker all Plan 1 ✅; CI green; no `requireRole`; no float money.

---

## 7. Gates (run after every task)

```
npm run ci            # tsc + eslint + tests, 0 skipped
migration check       # applies on clean DB AND on a copy of current data
grep checks:          # fail the task if any of these appear in the diff
  - 'ml-' 'mr-' 'pl-' 'pr-' 'text-left' 'text-right'   (outside ltr-value contexts)
  - 'requireRole('                                      (after 1A.3)
  - UPDATE/DELETE on stock_movements
  - '${' inside SQL strings
  - parseFloat / toFixed on money paths
i18n parity check     # ar.json and en.json have identical key sets
```

Reviewer checklist (A-REVIEW answers yes/no per line): permission guard present · tenant scoped · only listed files touched · tests added · ar+en keys · RTL logical classes · integer money · no sibling-module import.

---

## 8. Small-model survival tips

- Give schema + one example file of the same kind (e.g. show `requisitions/service.ts` when asking for `returns/service.ts`). Copying a pattern beats describing one.
- Keep prompts under ~6k tokens: Global Rules + card + ≤3 files.
- Never ask for migration + service + UI in one turn.
- Have the agent restate the acceptance criteria before coding; reject if it misses one.
- When an agent invents a helper that may already exist, ask it to grep first (`rg "export (function|const) <name>"`).

---

## 9. Parked for Plan 2 (do not dispatch)

2A kindergarten features · 2B purchasing/suppliers/PO · 2C weighted-average costing · 2D transfers/bins · 2E settings/approvals/notifications · 2F advanced reports · 2G PWA/offline.
Revisit once Plan 1 sign-off is complete.
