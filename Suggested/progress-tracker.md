# Progress Tracker

> Status key: ✅ Done · 🚧 In Progress · ⏳ Not Started · ❌ Blocked · 💡 Backlog

Last updated: 2026-10-29

---

## Phase 0 — Foundation (Complete)

| # | Task | Status | Notes |
|---|---|:-:|---|
| 0.1 | Append-only ledger + stock guard | ✅ | |
| 0.2 | Receiving with variance detection | ✅ | |
| 0.3 | Requisition: request → approve → issue → confirm | ✅ | |
| 0.4 | Public REST API + API keys | ✅ | No key management UI |
| 0.5 | Auth: username/password, sessions, lockout | ✅ | Hard-coded roles (to be replaced in 1A.1) |
| 0.6 | Doc numbers, i18n (ar/en), RTL layout | ✅ | |
| 0.7 | CI gate (414 unit tests, Playwright config) | ✅ | |
| 0.8 | 15 migrations, tenant scoping, `withTenant` | ✅ | |

---

## Phase 1 — Plan 1: Lean (usable every day)

### 1A — Roles, permissions, and user management

| # | Task | Status | Notes |
|---|---|:-:|---|
| 1A.1 | Migration: `roles`, `permissions`, `role_permissions` tables; migrate `app_users.role` enum → `role_id` FK | ⏳ | Replaces hard-coded role enum |
| 1A.2 | Seed migration: owner / manager / branch roles with default permission sets | ⏳ | Owner always keeps `roles:manage` |
| 1A.3 | `requirePermission(session, key)` replaces `requireRole()` in all routes and actions | ⏳ | |
| 1A.4 | Session version bump on permission change → invalidate affected sessions | ⏳ | |
| 1A.5 | `usePermissions()` hook + `PermissionGate` component in shell | ⏳ | |
| 1A.6 | Roles management screen: create role, toggle permissions per module, assign role to user | ⏳ | Owner only (`roles:manage`) |
| 1A.7 | User management screen: create user, assign role, disable, reset password | ⏳ | `users:manage` permission |
| 1A.8 | API key management screen | ⏳ | `api:manage` permission |

### 1B — Catalog and locations management

| # | Task | Status | Notes |
|---|---|:-:|---|
| 1B.1 | Items management screen: add/edit items, variants (size, gender), unit cost | ⏳ | `items:manage`; cost stored as integer piastres |
| 1B.2 | Unit cost field on item variant (migration + UI) | ⏳ | Snapshot cost onto every movement row |
| 1B.3 | Cost snapshot on every ledger movement (`unit_cost_piastres` column in `stock_movements`) | ⏳ | Migration needed |
| 1B.4 | Locations management screen: add/edit branches and shelves, set min/max per item | ⏳ | `locations:manage` |
| 1B.5 | Category management (add/edit categories on items screen) | ⏳ | |

### 1C — Filtering (standard across all list screens)

| # | Task | Status | Notes |
|---|---|:-:|---|
| 1C.1 | `ListFilter` type + `parseListFilter()` util in platform | ⏳ | Shared by all db.ts query functions |
| 1C.2 | `SearchInput` component (debounced, clearable) | ⏳ | |
| 1C.3 | `StatusMultiSelect` component (badge-style) | ⏳ | |
| 1C.4 | `DateRangePicker` component (Arabic calendar, presets: today/this week/this month/custom) | ⏳ | |
| 1C.5 | `BranchSelect` component (hidden on branch-role screens) | ⏳ | |
| 1C.6 | `FilterChip` + `ActiveFilterChips` + "Clear all" | ⏳ | |
| 1C.7 | Mobile: filters collapse into bottom sheet | ⏳ | |
| 1C.8 | Filter state persisted in URL query params on all list screens | ⏳ | |
| 1C.9 | Wire `ListFilter` to all existing list screens: stock, requisitions, intake | ⏳ | |

### 1D — Core document workflows (gaps)

| # | Task | Status | Notes |
|---|---|:-:|---|
| 1D.1 | Requisition: cancel and reject actions | ⏳ | |
| 1D.2 | Requisition: partial fulfilment + backorder (remaining lines stay open) | ⏳ | |
| 1D.3 | Reservations on approval (block double-promise of same units) | ⏳ | Schema change needed |
| 1D.4 | Returns screen: list (with filters), create, process (restock/quarantine/scrap) | ⏳ | Backend 🟡; add `returns:*` permission gates |
| 1D.5 | Counts screen: new session, blind count, recount, post adjustment | ⏳ | Backend 🟡; add `counts:*` permission gates |
| 1D.6 | Branch usage entry screen + filter by date range and item | ⏳ | Report screen exists; `usage:create` permission |
| 1D.7 | Adjustment reason codes (required field on scrap/damage/count adjust) | ⏳ | Migration needed |
| 1D.8 | Document history timeline on every detail screen (user + timestamp + action) | ⏳ | Needs audit log (1E.1) |

### 1E — Audit log and security

| # | Task | Status | Notes |
|---|---|:-:|---|
| 1E.1 | Audit log module: migration (`audit_log` table), write on every mutation | ⏳ | New module; captures: user, action, table, old/new values, timestamp |
| 1E.2 | Audit log viewer screen with full filters (date range, user, action, module) | ⏳ | `reports:audit` permission |
| 1E.3 | Password reset flow (manager resets for branch; owner resets for all) | ⏳ | |
| 1E.4 | Backup + restore runbook documented and tested | ⏳ | Not a screen |

### 1F — Cost and spending reports

| # | Task | Status | Notes |
|---|---|:-:|---|
| 1F.1 | Monthly spend report: total cost of goods received, filtered by month/date range | ⏳ | Requires 1B.2 and 1B.3 |
| 1F.2 | Branch spend report: cost of issued goods per branch, filtered by date range | ⏳ | |
| 1F.3 | Branch item detail: what a branch took in a period — item, qty, unit cost, total | ⏳ | Filterable by branch + date range + item/category |
| 1F.4 | Current stock value report: on_hand × unit_cost per item/location | ⏳ | |
| 1F.5 | All reports: export to Excel and PDF | ⏳ | |

### 1G — Quality of life

| # | Task | Status | Notes |
|---|---|:-:|---|
| 1G.1 | Camera barcode scanner component (intake, counts, item picker) | ⏳ | Fallback to text input |
| 1G.2 | Item picker: search by name, size, SKU, barcode; shows on-hand and unit cost | ⏳ | Shared component |
| 1G.3 | Recurring requisition templates (branch saves and reuses a standard order) | ⏳ | |
| 1G.4 | Printable pick list and delivery note (print styles) | ⏳ | Pick list exists; needs CSS |
| 1G.5 | Low-stock alert tiles on dashboard (min levels already exist) | ⏳ | |
| 1G.6 | Photo upload on variance / scrap / damage | ⏳ | Needs storage config |
| 1G.7 | Toast notifications (success/error, 3s auto-dismiss) | ⏳ | Shared component |
| 1G.8 | Skeleton / loading states on all screens | ⏳ | Shared component |
| 1G.9 | Error state with retry on all screens | ⏳ | Shared component |
| 1G.10 | FormField wrapper (label + input + validation error, RTL-safe) | ⏳ | Shared component |
| 1G.11 | `MoneyDisplay` component (integer piastres → formatted EGP) | ⏳ | Shared component |

---

## Phase 2 — Plan 2: Complete

### 2A — Kindergarten-specific

| # | Task | Status | Notes |
|---|---|:-:|---|
| 2A.1 | Academic year / term setting | ⏳ | Needs settings module |
| 2A.2 | Student count per branch | ⏳ | |
| 2A.3 | Per-student need calculator (students × need = suggested order qty) | ⏳ | |
| 2A.4 | Class packs / kits (issue a pack, deduct all components) | ⏳ | Needs BOM migration |
| 2A.5 | Uniform size-curve view (which sizes move, which are low) | ⏳ | |
| 2A.6 | Back-to-school surge report (last year demand per branch) | ⏳ | |
| 2A.7 | Book edition / year tag on items | ⏳ | Catalog change |
| 2A.8 | End-of-year book return and inspection flow | ⏳ | |
| 2A.9 | Branch consumption comparison per student | ⏳ | |

### 2B — Purchasing

| # | Task | Status | Notes |
|---|---|:-:|---|
| 2B.1 | Suppliers module + screen | ⏳ | New module |
| 2B.2 | Purchase orders (PO) + screen with filters | ⏳ | |
| 2B.3 | PO-linked intake (expected vs received, auto-fill lines) | ⏳ | |
| 2B.4 | Reorder suggestions from min/max → draft PO | ⏳ | |
| 2B.5 | Units of measure + conversion (carton → piece) | ⏳ | Migration change |
| 2B.6 | Return to supplier (defective goods, with credit note) | ⏳ | |
| 2B.7 | Quality accept/reject step on intake | ⏳ | |

### 2C — Advanced costing

| # | Task | Status | Notes |
|---|---|:-:|---|
| 2C.1 | Weighted-average cost update when purchase price changes | ⏳ | Replaces static unit_cost |
| 2C.2 | Purchase price variance report | ⏳ | |
| 2C.3 | Cost per branch per term (academic) | ⏳ | |

### 2D — Movement

| # | Task | Status | Notes |
|---|---|:-:|---|
| 2D.1 | Transfers module (branch ↔ branch) with same filter/timeline pattern | ⏳ | New module |
| 2D.2 | Bin/shelf locations inside warehouse (`parent_id` on locations) | ⏳ | |
| 2D.3 | Bin labels PDF (label system already exists) | ⏳ | |
| 2D.4 | Pick list sorted by bin | ⏳ | |

### 2E — Control and communication

| # | Task | Status | Notes |
|---|---|:-:|---|
| 2E.1 | Settings module + screen (tenant config, school name, logo, thresholds) | ⏳ | New module |
| 2E.2 | Approvals: rule-based (scrap above qty, large count adjust) | ⏳ | New module |
| 2E.3 | Branch-scoped manager (manager sees assigned branches only) | ⏳ | Role permission change |
| 2E.4 | WhatsApp / email notifications (new requisition, approved, shipped, low stock) | ⏳ | Events module wired |
| 2E.5 | Weekly auto-summary to owner | ⏳ | Jobs module |
| 2E.6 | Comments / notes on requisitions and receipts | ⏳ | |
| 2E.7 | Delivery signature on confirm | ⏳ | |

### 2F — Advanced reports

| # | Task | Status | Notes |
|---|---|:-:|---|
| 2F.1 | Inventory turnover + days of cover per item | ⏳ | |
| 2F.2 | Dead stock report (no movement in N days) | ⏳ | |
| 2F.3 | Variance report (receiving and count) by reason and branch | ⏳ | |
| 2F.4 | Per-student consumption | ⏳ | |

### 2G — Mobile and PWA

| # | Task | Status | Notes |
|---|---|:-:|---|
| 2G.1 | Installable PWA (manifest, service worker) | ⏳ | |
| 2G.2 | Offline queue for confirm + count | ⏳ | |

---

## Incidents

| Date | Summary | Resolution |
|---|---|---|
| — | — | — |

---

## Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-10-29 | Integers only for qty and money (piastres) | Avoid float rounding errors |
| 2026-10-29 | Append-only ledger, no soft deletes | Audit integrity |
| 2026-10-29 | Plain SQL in db.ts, no ORM | Explicit, testable, no magic |
| 2026-10-29 | Lots/expiry deferred | Books and uniforms don't expire |
| 2026-10-29 | Serials deferred | No tracked-asset stock in scope |
| 2026-10-29 | Permission-based roles (not enum) | Owner needs to create custom roles (Accountant, Supervisor, etc.) |
| 2026-10-29 | Cost snapshot on movement row | Preserves historical cost when item price changes |
| 2026-10-29 | Filter state in URL query params | Shareable, bookmarkable, consistent |
