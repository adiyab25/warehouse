# Feature Inventory — Warehouse App

> Auto-generated summary of available features as of P0 completion (2026-10-29).
> Source: `docs/architecture/MAP.md`, `src/app/` routes, `src/modules/`, `supabase/migrations/`.

---

## UI Screens (routes)

| Route | Screen | Module | Description |
|---|---|---|---|
| `/` | Home Dashboard | shell | Role-aware tiles: owner (stock lines, below-min, open requests, in-transit), manager (to approve/issue/receipts), branch (my requests, to confirm) |
| `/sign-in` | Sign In | auth | Username/password login, language switch, session cookie |
| `/stock` | Stock List | ledger | Search stock by item/variant, view on-hand per location, link to history |
| `/stock/[variantId]` | Stock Detail / History | ledger | Movement history for a variant, balance per location |
| `/stock/usage` | Usage Report | branch-usage | Branch consumption/sales report by date range |
| `/intake` | Intake (Receiving) | receiving | Delivery note entry: scan/enter items, quantities, variance detection |
| `/requisitions` | Requisition List | requisitions | List of requisitions with status, filter by branch/status |
| `/requisitions/[id]` | Requisition Detail | requisitions | Line items, approve/issue/confirm workflow, quantities |
| `/reports` | Reports / Replenishment | reports | Replenishment report (per-branch tables), usage totals |
| `/dev/ui` | Component Demo | shell | Story-style demo of shared components (dev only) |

## Backend Modules

| Module        | State           | Key Capabilities                                                                                   |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| platform      | ✅               | DB pools (owner + app role), tenant scoping (`withTenant`), migrations runner, env, errors, jobs   |
| auth          | ✅ (no admin UI) | Users, sign-in, sessions, lockout, roles (owner/manager/branch), password hashing, login attempts  |
| shell         | 🟡              | App layout (sidebar, topbar, direction), i18n (ar/en), theme tokens, shared components, dashboards |
| locations     | 🟡              | Warehouse, branches, transit/scrap/quarantine/vendor/holder locations; min/max levels              |
| catalog       | 🟡              | Items, variants, categories, barcodes, min/max per location, labels                                |
| ledger        | ✅               | Stock movements (append-only), on-hand, history, stock guard, snapshots, doc numbers               |
| receiving     | ✅               | Delivery notes/receipts, partial deliveries, variance detection                                    |
| requisitions  | ✅               | Branch request → approve → issue (transit) → confirm; pick list; dispatch                          |
| transfers     | ❌               | Not started                                                                                        |
| branch-usage  | ❌ (UI only)     | Usage entry screen, consumption tracking                                                           |
| returns       | 🟡              | Return documents (restock/quarantine/scrap)                                                        |
| counts        | 🟡              | Stocktake sessions, blind count, recount                                                           |
| lots-serials  | ❌               | Not started                                                                                        |
| suppliers     | ❌               | Not started                                                                                        |
| costing       | ❌               | Not started                                                                                        |
| reports       | 🟡              | Replenishment, usage reports, owner dashboard data                                                 |
| approvals     | ❌               | Not started                                                                                        |
| audit-log     | ❌               | Not started                                                                                        |
| api           | ✅ (no key UI)   | Public REST API (items, locations, movements, on-hand, requisitions), API keys                     |
| events        | 🟡              | Domain-event outbox, webhook delivery worker                                                       |
| integrations  | ❌               | Not started (Shopify, Bosta, WhatsApp)                                                             |
| import-export | 🟡              | Opening balances, catalogue CSV/Excel import/export, seed                                          |
| settings      | ❌               | Not started                                                                                        |
| offline       | ❌               | Not started                                                                                        |

## Database Tables (15 migrations)

| Migration | Tables / Objects |
|---|---|
| 0001_init | tenants, schema_migrations, helpers |
| 0002_tenants_users | tenants, app_users |
| 0003_locations | locations |
| 0004_items_variants | items, item_variants, location_levels |
| 0005_movements | stock_movements, on_hand (view), stock_snapshots |
| 0006_receipts | receipts, receipt_lines |
| 0007_requisitions | requisitions, requisition_lines |
| 0008_returns | returns, return_lines |
| 0009_counts | count_sessions, count_lines |
| 0010_auth | auth tables, roles |
| 0011_login_attempts | login_attempts |
| 0012_usernames | username column |
| 0013_events | events/outbox |
| 0014_language_preference | language_preference column |
| 0015_doc_numbers | doc_sequences, next_doc_number(), number column on receipts/requisitions/counts |

## API Routes (public)

| Route | Method | Description |
|---|---|---|
| `/api/v1/items` | GET | List items |
| `/api/v1/locations` | GET | List locations |
| `/api/v1/movements` | GET/POST | List/post movements |
| `/api/v1/on-hand` | GET | On-hand quantities |
| `/api/v1/requisitions` | GET/POST | List/create requisitions |
| `/api/v1/[[...path]]` | * | Catch-all router |
| `/api/labels/location/[id]` | GET | Label PDF for location |
| `/api/labels/variant/[id]` | GET | Label PDF for variant |
| `/sign-out` | GET | Sign out (clear session) |

## Shared Components (src/modules/shell/ui/)

| Component | Purpose |
|---|---|
| AppSidebar | Role-filtered navigation sidebar |
| TopBar | Sidebar trigger, breadcrumb, language switch, user menu, sign-out |
| PageHeader | Page title + description + actions |
| DataTable | TanStack Table: sort, column visibility, server pagination, cards <640px |
| StatusBadge | Maps document/line status → status token + i18n label |
| FilterBar | Filter controls wrapper |
| KpiCard | Dashboard KPI tile |
| QtyStepper | Quantity input stepper |
| EmptyState | Empty state placeholder |
| ConfirmDialog | Confirmation dialog |
| DocNumber | Document number display |
| Money / Qty / DateTime | Formatted value components (Formatters) |

## Design Tokens (DESIGN.md)

- **Primary:** deep teal `#0f766e`
- **Font:** IBM Plex Sans Arabic (arabic + latin), IBM Plex Mono
- **Status:** ok (green), wait (yellow), bad (red), transit (blue), idle (gray)
- **Radius:** 0.5rem (8px) standard
- **Layout:** phone-first, 44px tap targets, flat surfaces, 1px borders
- **Direction:** RTL (Arabic), LTR exception via `.ltr-value` for codes/SKUs

## i18n

- Files: `src/i18n/ar.json`, `src/i18n/en.json`
- Parity enforced by CI (F-08)
- All user-facing strings in both languages
- Latin digits for numbers; codes in `.ltr-value`

## Testing

- **Unit/contract tests:** node:test (414 tests, 0 skipped)
- **E2E:** Playwright (config in place, Chromium installed)
- **Ledger reconciliation:** `npm run e2e -- --no-http` (append-only, 0 rows left)
- **Gate:** `npm run ci` (tsc + eslint + tests, 0 skipped)
- **CI:** GitHub Actions (Postgres 15 service, migrate, build, gate)

## Credentials (dev seed)

- Owner: `owner` / `ownerpassword123`
- Manager: `manager` / `managerpassword123`
- Branch: `branch01`–`branch14` / `branchpassword123`
- Tenant: "Demo Kindergarten" (14 branches, 10 items, opening balances)

## Dev Server

- `npm run dev` → http://localhost:3000 (or 3001 if 3000 in use)
- DB: Postgres 15 on 127.0.0.1:55499
- Load `.env`, set `MIGRATE_DATABASE_URL=$DATABASE_URL` for `npm run ci`