# Architecture Context

> System architecture, module layout, and dependency rules. Source: `docs/architecture/MAP.md`.

## Layers (every module)

```
Browser ──► src/app/<route>/page.tsx       (thin: read params, call module, render)
             src/app/<route>/actions.ts      (thin 'use server' wrapper: auth + call module)
                     │
                     ▼
 src/modules/<m>/ui/        React screens & widgets (client/server components)
 src/modules/<m>/server/    DB access + use-cases (ONLY place SQL lives, besides migrations)
 src/modules/<m>/domain/    pure rules: validation, state machines, formatting — no I/O
 src/modules/<m>/index.ts   module's PUBLIC API — other modules import ONLY from here
                     │
                     ▼
 supabase/migrations/NNNN_<m>_<what>.sql     tables, RLS, triggers, SQL functions
 Postgres 15 (tenant RLS forced; app runs as non-owner `authenticated`)
```

## Dependency Rules (enforced by ESLint no-restricted-imports)
1. `domain/` imports nothing from `server/`, `ui/`, `next`, `pg`, or React.
2. `ui/` never imports `server/` directly — receives data via props or server action.
3. A module imports another module only through its `index.ts`.
4. Only `ledger` writes `stock_movements`. Every other module posts via `ledger.postMovement()` inside its own transaction.
5. `src/components/ui/*` (shadcn) imports nothing from modules.
6. `src/app/*` contains no SQL and no business rules.

## Modules (24)

| ID | Module | Purpose | State |
|---|---|---|---|
| M00 | platform | DB pools, tenant scoping, migrations, env, errors, jobs | ✅ |
| M01 | auth | Users, sign-in, sessions, lockout, roles | ✅ (no admin UI) |
| M02 | shell | App layout, sidebar, topbar, dashboards, i18n, theme | 🟡 |
| M03 | locations | Warehouse, branches, bins, transit/scrap/quarantine/vendor | 🟡 |
| M04 | catalog | Items, variants, categories, barcodes, min/max levels, labels | 🟡 |
| M05 | ledger | Stock movements, on-hand, history, stock guard, snapshots | ✅ |
| M06 | receiving | Delivery notes, partial deliveries, variance | ✅ |
| M07 | requisitions | Request → approve → issue → confirm | ✅ |
| M08 | transfers | Branch-to-branch moves | ❌ |
| M09 | branch-usage | Consumption/sale entry, branch policy | ❌ (UI only) |
| M10 | returns | Restock/quarantine/write-off | 🟡 |
| M11 | counts | Stocktake sessions, blind count, recount | 🟡 |
| M12 | lots-serials | Lots, expiry (FEFO), serials | ❌ |
| M13 | suppliers | Suppliers, POs, reorder | ❌ |
| M14 | costing | Unit cost, moving average, month-end close | ❌ |
| M15 | reports | Reports, dashboards, export | 🟡 |
| M16 | approvals | Two-person rule, notification inbox | ❌ |
| M17 | audit-log | Change history of master data | ❌ |
| M18 | api | Public REST API, API keys | ✅ (no key UI) |
| M19 | events | Domain-event outbox, webhooks | 🟡 |
| M20 | integrations | Shopify, Bosta, WhatsApp | ❌ |
| M21 | import-export | Opening balances, CSV/Excel import/export, seed | 🟡 |
| M22 | settings | Tenant settings, branding, thresholds | ❌ |
| M23 | offline | PWA, offline queue, camera scanning | ❌ |

## Database (15 migrations)
`0001_init` through `0015_platform_doc_numbers`. Tables: tenants, app_users, locations, items, item_variants, location_levels, stock_movements, on_hand (view), stock_snapshots, receipts, receipt_lines, requisitions, requisition_lines, returns, return_lines, count_sessions, count_lines, login_attempts, events, doc_sequences.

## Routes
- `/` — home dashboard (role-aware)
- `/sign-in` — authentication
- `/stock`, `/stock/[variantId]`, `/stock/usage` — stock views
- `/intake` — receiving
- `/requisitions`, `/requisitions/[id]` — requisition workflow
- `/reports` — reports/replenishment
- `/dev/ui` — component demo (dev only)
- `/api/v1/*` — public REST API
- `/api/labels/*` — label PDF generation

## Multi-Tenancy
- Every table has `tenant_id` with composite FKs.
- RLS forced on all tables. App runs as `authenticated` role.
- `withTenant()` sets `app.tenant_id` inside a transaction.
---

## Extended Reference (from suggested docs)

# Architecture Context

## Repo layout
```
/
├── src/
│   ├── app/                     # Next.js App Router pages and API routes
│   │   ├── (app)/               # Authenticated app shell
│   │   │   ├── layout.tsx       # Sidebar + topbar
│   │   │   ├── page.tsx         # / dashboard
│   │   │   ├── stock/
│   │   │   ├── intake/
│   │   │   ├── requisitions/
│   │   │   ├── returns/         # TODO Plan 1
│   │   │   ├── counts/          # TODO Plan 1
│   │   │   ├── usage/           # TODO Plan 1
│   │   │   ├── reports/
│   │   │   ├── items/           # TODO Plan 1
│   │   │   ├── locations/       # TODO Plan 1
│   │   │   └── admin/           # users, roles, api-keys — TODO Plan 1
│   │   ├── sign-in/
│   │   ├── sign-out/
│   │   └── api/
│   │       ├── v1/              # Public REST API
│   │       └── labels/          # PDF label routes
│   ├── modules/                 # Domain modules (see below)
│   ├── i18n/                    # ar.json, en.json
│   └── lib/                     # Shared non-module utilities
├── supabase/
│   └── migrations/              # Plain SQL, numbered (0001..N)
├── docs/
│   └── architecture/
│       ├── MAP.md
│       ├── project-overview.md
│       ├── architecture-context.md
│       ├── workflow.md
│       ├── code-standards.md
│       ├── ui-context.md
│       └── progress-tracker.md
├── tests/                       # node:test unit + contract tests
├── e2e/                         # Playwright
└── .github/workflows/           # CI
```

## Module structure
Each module under `src/modules/<name>/` follows the same layout:

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

Cross-module imports: a module may import from `platform`, `shell`, `auth`, `ledger`.
It must NOT import from sibling domain modules directly — go via service calls.

## Module registry

| Module | State | Owns |
|---|:-:|---|
| platform | ✅ | DB pools, `withTenant`, migrations, env, errors, jobs |
| auth | ✅ | Users, sessions, lockout — roles now permission-based (see below) |
| shell | 🟡 | Layout, i18n, theme tokens, shared components |
| ledger | ✅ | `stock_movements`, `on_hand`, `stock_snapshots`, stock guard |
| receiving | ✅ | `receipts`, `receipt_lines`, variance |
| requisitions | ✅ | `requisitions`, `requisition_lines`, pick list, dispatch |
| locations | 🟡 | `locations`, min/max levels |
| catalog | 🟡 | `items`, `item_variants`, `location_levels`, barcodes, unit costs |
| branch-usage | 🟡 | Usage report UI; entry screen TODO |
| returns | 🟡 | `returns`, `return_lines`; UI TODO |
| counts | 🟡 | `count_sessions`, `count_lines`; UI TODO |
| reports | 🟡 | Replenishment, usage, spending, branch cost, dashboard data |
| api | ✅ | Public REST, API keys |
| events | 🟡 | Domain-event outbox, webhook worker |
| import-export | 🟡 | CSV/Excel import/export, seed |
| transfers | ❌ | Branch ↔ branch (Plan 2) |
| suppliers | ❌ | Supplier master, POs (Plan 2) |
| costing | ❌ | Avg cost, valuation (Plan 2) |
| approvals | ❌ | Rule-based approval (Plan 2) |
| audit-log | ❌ | Mutation log (Plan 1) |
| settings | ❌ | Tenant config (Plan 1) |
| notifications | ❌ | WhatsApp/email alerts (Plan 2) |

## Permission system (replaces hard-coded roles)

### Concept
- A **role** is a named set of permissions created and managed by the owner.
- A **permission** is a string key: `module:action` — e.g. `requisitions:approve`, `reports:cost`.
- A user has exactly one role. Permissions are checked at the role level, not the user level.
- Three **seed roles** ship with the app: `owner`, `manager`, `branch`. They cannot be deleted but their permissions can be edited (except `owner`, which always retains `roles:manage`).

### DB tables (new migration needed)
```sql
-- roles table
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,             -- e.g. "Accountant"
  is_system   boolean NOT NULL DEFAULT false,  -- seed roles
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- permissions table (permission catalogue)
CREATE TABLE permissions (
  key         text PRIMARY KEY,          -- e.g. "requisitions:approve"
  module      text NOT NULL,
  description_ar text NOT NULL,
  description_en text NOT NULL
);

-- role_permissions join table
CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_id, permission_key)
);

-- app_users gains role_id (replaces the old role enum)
ALTER TABLE app_users ADD COLUMN role_id uuid REFERENCES roles(id);
```

### Permission keys (full list)

| Module | Key | What it allows |
|---|---|---|
| auth | `users:view` | See user list |
| auth | `users:manage` | Create, edit, disable, reset password |
| auth | `roles:manage` | Create roles, assign permissions, assign role to user |
| catalog | `items:view` | See items and variants |
| catalog | `items:manage` | Add, edit, archive items and variants |
| locations | `locations:view` | See locations |
| locations | `locations:manage` | Add, edit locations and min/max |
| ledger | `stock:view` | See stock levels and history |
| receiving | `intake:view` | See receipts |
| receiving | `intake:create` | Create a delivery note |
| requisitions | `requisitions:view` | See requisitions (own branch only for branch role) |
| requisitions | `requisitions:create` | Submit a new requisition |
| requisitions | `requisitions:approve` | Approve or reject |
| requisitions | `requisitions:issue` | Issue / dispatch |
| requisitions | `requisitions:confirm` | Confirm receipt |
| requisitions | `requisitions:cancel` | Cancel or amend |
| returns | `returns:view` | See returns |
| returns | `returns:create` | Create a return |
| returns | `returns:process` | Process return (restock/quarantine/scrap) |
| counts | `counts:view` | See count sessions |
| counts | `counts:create` | Start a count session |
| counts | `counts:post` | Post adjustment after count |
| branch-usage | `usage:view` | See usage reports |
| branch-usage | `usage:create` | Log consumption |
| reports | `reports:basic` | Replenishment, stock, usage reports |
| reports | `reports:cost` | Spending, branch cost, valuation reports |
| reports | `reports:audit` | Audit log viewer |
| api | `api:manage` | Create and revoke API keys |
| settings | `settings:manage` | Tenant settings (Plan 2) |
| transfers | `transfers:create` | Create branch-to-branch transfers (Plan 2) |
| transfers | `transfers:approve` | Approve transfers (Plan 2) |

### How guards work in code
```ts
// Every server action and API route
const session = await getSession(req);
requirePermission(session, 'requisitions:approve');
// throws FORBIDDEN if the user's role does not have this permission

// UI — hide controls the user cannot use
const can = usePermissions(); // hook reads session permissions
{can('requisitions:approve') && <Button>Approve</Button>}
```

### Permission cache
Permissions are loaded on session creation and cached in the session cookie payload.
When an owner changes a role's permissions, all active sessions for users in that role
are invalidated (session version bump). The user gets a "session refreshed" notice on
their next request.

## Costing and cost tracking

### Where cost lives
- `unit_cost_piastres` (integer) stored on `item_variants` — smallest unit, no floats.
- On every ledger movement, `unit_cost_piastres` is snapshotted into the movement row.
  This means historical cost is preserved even if the item price changes later.

### What this enables (no separate costing module needed for Plan 1)
- **Monthly spend**: `SUM(qty * unit_cost_piastres)` on intake movements, grouped by month
- **Branch spend in period**: `SUM(qty * unit_cost_piastres)` on issue movements to a branch, filtered by date range
- **What a branch took**: requisition lines with item, qty, unit cost, total cost, filtered by branch + date range
- **Current stock value**: `SUM(on_hand * unit_cost_piastres)` per item/location

A full weighted-average costing module (Plan 2) adds purchase price variance and
updates costs when supplier prices change.

## Filtering architecture

Every list query in `db.ts` accepts a `ListFilter` object:

```ts
type ListFilter = {
  search?: string;          // full-text on relevant columns
  status?: string[];        // multi-value
  branchId?: string;
  itemId?: string;
  categoryId?: string;
  createdById?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
};
```

The SQL builder in `platform/db.ts` converts this to a parameterised WHERE clause.
Never build filter SQL by string interpolation.
URL query params map 1:1 to `ListFilter` fields via a shared `parseListFilter()` util.

## Database rules
- Multi-tenant: every table has `tenant_id`. Use `withTenant(tenantId)` before every query.
- Ledger is append-only: `stock_movements` never updated or deleted.
- Migrations are plain SQL files named `NNNN_description.sql`. Never edit a committed migration — add a new one.
- Views (`on_hand`) are defined inside migrations, not in code.
- Sequences via `doc_sequences` + `next_doc_number()`.
- All qty and money values: integers in smallest unit (piastres for EGP). No floats.

## Auth and sessions
- Username/password, bcrypt, session cookie (httpOnly).
- Permission-based (roles are configurable, not an enum).
- Every server action / API route calls `requirePermission(session, key)`.
- Login attempts tracked in `login_attempts`, lockout applied server-side.
- Session version bump on role permission change → all affected sessions invalidated.

## API design rules
- Versioned: `/api/v1/...`
- Auth: `Authorization: Bearer <api-key>` header.
- Standard response envelope: `{ data, meta, error }`.
- Pagination: `?page=&limit=` with `meta.total`, `meta.page`, `meta.pages`.
- All filter params accepted on list endpoints (see `ListFilter` above).
- Error codes: machine-readable string (e.g. `INSUFFICIENT_STOCK`, `NOT_FOUND`, `FORBIDDEN`).
- All mutations return the updated document.

## Key constraints
- Stock guard: throws `INSUFFICIENT_STOCK` if movement makes `on_hand` negative (policy configurable).
- Reservations (Plan 1): approved requisitions reserve qty to prevent double-promise.
- No soft-deletes on ledger tables — use status fields and `is_active` flags elsewhere.
- All financial/qty values stored as integers (smallest unit) — no floats.

## Deployment
- Vercel (preview per PR, production on main).
- Postgres 15 managed externally (not Supabase hosted — raw Postgres).
- Env vars: `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `SESSION_SECRET`, `NEXT_PUBLIC_APP_URL`.
- CI runs on GitHub Actions: migrate → build → `npm run ci` (tsc + eslint + tests).
