# Consolidated Plan — Warehouse (Kindergarten Chain)

> Merged from: ACTION-PLAN.md (P0-P7), Suggested/progress-tracker.md (Plan 1/Plan 2), Suggested/architecture-context.md, Suggested/project-overview.md, Suggested/ui-context.md.
> Product: kindergarten warehouse — 1 central warehouse, 14 branches. Arabic-first, phone-first, EGP.
> Status: P0 complete (12/12 tickets, 414 tests, 0 skipped). CI green.

---

## Product Identity
- **What:** Multi-tenant, Arabic-first, phone-first warehouse and stock-control system.
- **Who:** Kindergarten chain — 14 branches. Users: warehouse staff, branch coordinators, manager, owner.
- **Stock types:** Educational books (per-curriculum edition, per-grade), uniforms (size/gender variants), daily consumables (paper, markers, cleaning).
- **Core loop:** Receive from supplier → Store → Branch requests → Manager approves → Issue (in transit) → Branch confirms → Branch consumes/returns/counts.
- **Scope excludes:** No customer sales, invoicing, e-commerce, multi-currency, tax, HR, payroll, student records, shipping carriers. Integrations (WhatsApp, Shopify, Bosta) are post-MVP.

## Module Structure Convention (target)
Each module under `src/modules/<name>/`:
```
<module>/
├── db.ts          # SQL queries — only place raw SQL lives
├── service.ts     # Business logic, calls db.ts, emits events
├── schema.ts      # Zod schemas for inputs/outputs
├── ui/            # React components for this module only
│   ├── *.tsx
│   └── index.ts
└── index.ts       # Public API of the module
```
Current codebase uses `domain/server/ui/index.ts`. Migration to the new convention is a future refactor ticket.

## Permission System (new — replaces hard-coded roles)
- Roles are owner-created named sets of permissions. A user has exactly one role.
- Permission keys: `module:action` (e.g., `requisitions:approve`, `reports:cost`).
- 3 seed roles: owner (everything), manager (receive/approve/issue/counts/reports), branch (requisitions/confirm/usage/own reports).
- DB: `roles`, `permissions`, `role_permissions` tables. `app_users.role` enum → `role_id` FK.
- Guards: `requirePermission(session, key)` in every action/route. `usePermissions()` hook + `PermissionGate` component in UI.
- Session version bump on permission change → invalidate affected sessions.
- Owner always keeps `roles:manage`.

## Permission Keys (full list)
auth: users:view, users:manage, roles:manage
catalog: items:view, items:manage
locations: locations:view, locations:manage
ledger: stock:view
receiving: intake:view, intake:create
requisitions: requisitions:view, requisitions:create, requisitions:approve, requisitions:issue, requisitions:confirm, requisitions:cancel
returns: returns:view, returns:create, returns:process
counts: counts:view, counts:create, counts:post
branch-usage: usage:view, usage:create
reports: reports:basic, reports:cost, reports:audit
api: api:manage
settings: settings:manage
transfers: transfers:create, transfers:approve

## Costing
- `unit_cost_piastres` (integer) on `item_variants` — smallest unit, no floats.
- Snapshotted onto every `stock_movements` row (preserves historical cost).
- Enables: monthly spend, branch spend, branch item detail, current stock value.
- Full weighted-average costing module is Plan 2.

## Filtering (standard across all list screens)
Every list screen supports: search, status (multi-select), date range, branch, item/category, created by, sort.
- Filter state in URL query params (shareable, bookmarkable).
- Mobile: filters collapse into bottom sheet.
- Active filters shown as dismissible chips.

## Status Badge Mapping
draft→idle, submitted→wait, approved→wait, issued→transit, in_transit→transit, confirmed→ok, cancelled→bad, rejected→bad, partial→wait, completed→ok.

## Phases

### P0 — Foundation ✅ COMPLETE
F-01 through F-12. All merged. CI green (414 tests, 0 skipped).

### P1 — Lean (usable every day)

#### 1A — Roles, permissions, user management
1A.1 Migration: roles, permissions, role_permissions tables; migrate app_users.role → role_id FK
1A.2 Seed migration: owner/manager/branch roles with default permission sets
1A.3 requirePermission() replaces requireRole() in all routes/actions
1A.4 Session version bump on permission change
1A.5 usePermissions() hook + PermissionGate component
1A.6 Roles management screen (owner only)
1A.7 User management screen
1A.8 API key management screen

#### 1B — Catalog and locations management
1B.1 Items management: add/edit items, variants, unit cost
1B.2 Unit cost field on item variant (migration + UI)
1B.3 Cost snapshot on every ledger movement (unit_cost_piastres column)
1B.4 Locations management: add/edit branches and shelves, min/max per item
1B.5 Category management

#### 1C — Filtering (standard across all list screens)
1C.1 ListFilter type + parseListFilter() util in platform
1C.2 SearchInput component (debounced, clearable)
1C.3 StatusMultiSelect component (badge-style)
1C.4 DateRangePicker (Arabic calendar, presets)
1C.5 BranchSelect (hidden on branch-role screens)
1C.6 FilterChip + ActiveFilterChips + "Clear all"
1C.7 Mobile: filters collapse into bottom sheet
1C.8 Filter state persisted in URL query params on all list screens
1C.9 Wire ListFilter to all existing list screens

#### 1D — Core document workflows (gaps)
1D.1 Requisition: cancel and reject actions
1D.2 Requisition: partial fulfilment + backorder
1D.3 Reservations on approval (prevent double-promise)
1D.4 Returns screen: list, create, process (restock/quarantine/scrap)
1D.5 Counts screen: new session, blind count, recount, post adjustment
1D.6 Branch usage entry screen + filter by date range and item
1D.7 Adjustment reason codes (required on scrap/damage/count adjust)
1D.8 Document history timeline on every detail screen

#### 1E — Audit log and security
1E.1 Audit log module: migration (audit_log table), write on every mutation
1E.2 Audit log viewer screen with full filters
1E.3 Password reset flow
1E.4 Backup + restore runbook documented and tested

#### 1F — Cost and spending reports
1F.1 Monthly spend report
1F.2 Branch spend report
1F.3 Branch item detail (item, qty, unit cost, total, filtered by branch+date+item)
1F.4 Current stock value report
1F.5 All reports: export to Excel and PDF

#### 1G — Quality of life
1G.1 Camera barcode scanner component
1G.2 Item picker (searchable by name/SKU/barcode, shows on-hand + unit cost)
1G.3 Recurring requisition templates
1G.4 Printable pick list and delivery note (print styles)
1G.5 Low-stock alert tiles on dashboard
1G.6 Photo upload on variance/scrap/damage
1G.7 Toast notifications
1G.8 Skeleton/loading states
1G.9 Error state with retry
1G.10 FormField wrapper (label + input + validation error, RTL-safe)
1G.11 MoneyDisplay component (integer piastres → formatted EGP)

### P2 — Plan 2: Complete

#### 2A — Kindergarten-specific
2A.1 Academic year/term setting
2A.2 Student count per branch
2A.3 Per-student need calculator
2A.4 Class packs/kits (issue a pack, deduct all components)
2A.5 Uniform size-curve view
2A.6 Back-to-school surge report
2A.7 Book edition/year tag on items
2A.8 End-of-year book return and inspection flow
2A.9 Branch consumption comparison per student

#### 2B — Purchasing
2B.1 Suppliers module + screen
2B.2 Purchase orders + screen with filters
2B.3 PO-linked intake (expected vs received, auto-fill lines)
2B.4 Reorder suggestions from min/max → draft PO
2B.5 Units of measure + conversion (carton → piece)
2B.6 Return to supplier (defective goods, credit note)
2B.7 Quality accept/reject step on intake

#### 2C — Advanced costing
2C.1 Weighted-average cost update when purchase price changes
2C.2 Purchase price variance report
2C.3 Cost per branch per term

#### 2D — Movement
2D.1 Transfers module (branch ↔ branch)
2D.2 Bin/shelf locations inside warehouse (parent_id on locations)
2D.3 Bin labels PDF
2D.4 Pick list sorted by bin

#### 2E — Control and communication
2E.1 Settings module + screen (tenant config, school name, logo, thresholds)
2E.2 Approvals: rule-based (scrap above qty, large count adjust)
2E.3 Branch-scoped manager (manager sees assigned branches only)
2E.4 WhatsApp/email notifications
2E.5 Weekly auto-summary to owner
2E.6 Comments/notes on requisitions and receipts
2E.7 Delivery signature on confirm

#### 2F — Advanced reports
2F.1 Inventory turnover + days of cover per item
2F.2 Dead stock report
2F.3 Variance report by reason and branch
2F.4 Per-student consumption

#### 2G — Mobile and PWA
2G.1 Installable PWA (manifest, service worker)
2G.2 Offline queue for confirm + count

## Success Definition
The owner can see at any moment how much money is in stock, what every branch received and spent in a period, and who did what. A manager and 14 branch coordinators can do their full weekly workflow on a phone, in Arabic, without calling or texting each other.

## Scope Boundaries (what this app does NOT do)
- No customer sales, invoicing or e-commerce
- No multi-currency or tax / e-invoicing
- No HR, payroll or scheduling
- No student records
- No shipping carriers (internal delivery only)
- Integrations (WhatsApp, Shopify, Bosta) are post-MVP