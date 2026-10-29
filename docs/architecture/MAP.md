# System Map — every part, who owns it, where it lives

> **Read this first.** Every task, every agent, every bug report starts here.
> It answers: *which module is this, which files belong to it, which tables,
> which routes, which tests, which i18n keys, and what may it depend on.*
> If you add a file, add it to its module's row. A file that is in no module is a defect.

Status: **2026-10-28 — current layout + target layout.** The target is reached by ticket `F-01` (mechanical move, no behaviour change).

---

## 1. The layers (applies to every module)

```
 Browser ──► src/app/<route>/page.tsx         (thin: read params, call the module, render)
              src/app/<route>/actions.ts       (thin 'use server' wrapper: auth + call module)
                      │
                      ▼
 src/modules/<m>/ui/        React screens & widgets for this module (client/server components)
 src/modules/<m>/server/    DB access + use-cases (the ONLY place SQL lives, besides migrations)
 src/modules/<m>/domain/    pure rules: validation, state machines, formatting — no I/O, unit-tested
 src/modules/<m>/index.ts   the module's PUBLIC API — other modules import ONLY from here
                      │
                      ▼
 supabase/migrations/NNNN_<m>_<what>.sql      tables, RLS, triggers, SQL functions
 Postgres 15 (tenant RLS forced; app runs as non-owner `authenticated`)
```

**Dependency rules (enforced by an ESLint `no-restricted-imports` rule — ticket `F-01`):**
1. `domain/` imports nothing from `server/`, `ui/`, `next`, `pg` or React.
2. `ui/` never imports `server/` directly — it receives data via props or calls a server action.
3. A module imports another module **only through its `index.ts`**.
4. Only `ledger` writes `stock_movements`. Every other module posts movements by calling `ledger.postMovement()` (or a ledger SQL function) inside its own transaction.
5. `src/components/ui/*` (shadcn primitives) import nothing from modules.
6. `src/app/*` contains no SQL and no business rules.

---

## 2. Module catalogue

Legend — **State:** ✅ done · 🟡 partial (DB only / no UI) · ❌ not started.

| ID | Module | Purpose (one line) | State |
|---|---|---|---|
| M00 | `platform` | DB pools, tenant scoping, migrations runner, env, errors, logging, jobs | ✅ |
| M01 | `auth` | Users, sign-in, sessions, lockout, roles & permissions | ✅ (no admin UI) |
| M02 | `shell` | App layout, sidebar, top bar, global scan/search, dashboards, i18n, theme | 🟡 |
| M03 | `locations` | Warehouse, branches, bins, transit/scrap/quarantine/vendor/holder | 🟡 |
| M04 | `catalog` | Items, variants, categories, barcodes, min/max levels, labels | 🟡 |
| M05 | `ledger` | Stock movements, on-hand, history, stock guard, snapshots | ✅ |
| M06 | `receiving` | Delivery notes/receipts, partial deliveries, variance, (POs, QC, put-away) | ✅ / ❌ POs |
| M07 | `requisitions` | Branch request → approve → issue (transit) → confirm; pick list; dispatch | ✅ / ❌ pick |
| M08 | `transfers` | Branch-to-branch & bin-to-bin moves through transit | ❌ |
| M09 | `branch-usage` | Branch consumption/sale entry, branch policy (consume-on-receipt) | ❌ |
| M10 | `returns` | Restock / quarantine / write-off, return to supplier | 🟡 |
| M11 | `counts` | Stocktake sessions, blind count, recount, cycle counts, ABC | 🟡 |
| M12 | `lots-serials` | Lots + expiry (FEFO), serial numbers, asset custody | ❌ |
| M13 | `suppliers` | Suppliers, purchase orders, reorder suggestions | ❌ |
| M14 | `costing` | Unit cost per movement, moving average, month-end close | ❌ |
| M15 | `reports` | Reports, owner dashboard data, Excel/PDF export | 🟡 |
| M16 | `approvals` | Two-person rule: write-offs, variances, overrides; notification inbox | ❌ |
| M17 | `audit-log` | Change history of master data (items, users, settings…) | ❌ |
| M18 | `api` | Public read/write API, API keys, scopes, OpenAPI docs | ✅ (no key UI) |
| M19 | `events` | Domain-event outbox, webhook delivery worker, delivery log | 🟡 |
| M20 | `integrations` | Shopify, Bosta, WhatsApp adapters (`src/integrations/*`) | ❌ |
| M21 | `import-export` | Opening balances, catalogue CSV/Excel import & export, seed | 🟡 |
| M22 | `settings` | Tenant settings: thresholds, branding, label size, language | ❌ |
| M23 | `offline` | PWA, offline queue, camera scanning | ❌ |

---

## 3. Module detail — files today → target, tables, routes, tests

> "Today" paths are real (verified 2026-10-28). "Target" is where `F-01` moves them.

### M00 platform
- **Today:** `src/db/client.ts`, `src/db/app-pool.ts`, `src/db/types.ts`, `src/domain/ids.ts`, `src/domain/text.ts`, `src/proxy.ts`, `scripts/migrate.mjs`, `scripts/db-check.mjs`, `scripts/gen-types.mjs`, `scripts/ci.mjs`, `scripts/ci-gate.mjs`, `next.config.mjs`
- **Target:** `src/modules/platform/{server/db.ts, server/tenant-scope.ts, domain/ids.ts, domain/text.ts}`; `src/proxy.ts` stays (Next requires it); scripts stay in `scripts/`.
- **Tables:** `tenants`, `schema_migrations`; helper `set_updated_at()`, `normalise_name()`.
- **Migrations:** `0001_init`, `0002_tenants_users` (tenant half).
- **Tests:** `tests/harness*`, `tests/migrate.test.ts`, `tests/contract/tenancy.test.ts`, `rls-conventions.test.ts`, `privileges.test.ts`, `app-role.test.ts`, `tests/domain/ci-gate.test.ts`, `text.test.ts`, `tenant.test.ts`.
- **Invariants:** tenant via `set_config('app.tenant_id', $1, true)` inside a tx; app refuses to serve as superuser/BYPASSRLS; RLS forced on every table.

### M01 auth
- **Today:** `src/auth/{cookie,current-user,login,password,session,tenant,token}.ts`, `src/app/sign-in/*`, `src/app/sign-out/route.ts`
- **Target:** `src/modules/auth/{server/,domain/,ui/SignInForm.tsx}`; add `domain/permissions.ts` (role × action matrix).
- **Tables:** `app_users`, `sessions`, `login_attempts`, `api_clients` (token resolver shared with M18).
- **Migrations:** `0002` (users), `0010_auth`, `0011_login_attempts`, `0012_usernames`, `0014_language_preference`.
- **Routes:** `/sign-in`, `/sign-out`; future `/admin/users`, `/account`.
- **Tests:** `contract/auth-guards`, `auth-resolver-security`, `login-attempts`, `app-users-identity`, `current-user`; `domain/login`, `password`, `sign-in-contract`; `e2e/session-gate`.
- **Roles:** `owner`, `warehouse_manager`, `branch_user` (+ planned `warehouse_staff`, `viewer`).

### M02 shell
- **Today:** `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/app/actions.ts` (language), `src/components/LanguageSwitcher.tsx`, `src/domain/home-nav.ts`, `src/i18n/{index.ts,request.ts,ar.json,en.json}`, `src/components/ui/*` (shadcn), `src/lib/utils.ts`, `src/hooks/use-mobile.ts`, `components.json`
- **Target:** `src/modules/shell/{ui/AppSidebar.tsx, ui/TopBar.tsx, ui/GlobalScan.tsx, ui/PageHeader.tsx, ui/templates/*, domain/nav.ts}`; `src/i18n/` stays global; `src/components/ui/` stays (shadcn convention).
- **Routes:** `/` (dashboard). Future route groups: `src/app/(app)/…` (signed-in shell), `src/app/(auth)/…` (sign-in).
- **Tests:** `domain/home-nav`, `i18n`, `language`, `form-controls-css`.
- **i18n namespace:** `app.*`, `home.*`, `nav.*`, `common.*`.

### M03 locations
- **Today:** `src/db/locations.ts`
- **Target:** `src/modules/locations/{server/locations.ts, ui/LocationList.tsx, ui/LocationForm.tsx}`
- **Tables:** `locations` (types: warehouse, bin, branch, transit, vendor, scrap, quarantine, holder; `parent_id` for bins).
- **Migration:** `0003_locations`. **Tests:** `contract/locations`.
- **Routes (planned):** `/admin/locations`, `/locations/[id]`.

### M04 catalog
- **Today:** `src/db/items.ts`, `src/domain/barcode.ts`, `src/domain/labels.ts`, `src/app/api/labels/**`
- **Target:** `src/modules/catalog/{server/items.ts, server/labels.ts, domain/barcode.ts, domain/labels.ts, ui/ItemList.tsx, ui/ItemForm.tsx, ui/VariantGrid.tsx, ui/LabelSheet.tsx}`
- **Tables:** `items`, `item_variants`, `location_levels`; planned `categories`.
- **Migration:** `0004_items_variants`. **Routes:** `/api/labels/variant/[id]`, `/api/labels/location/[id]`; planned `/items`, `/items/[id]`, `/items/new`, `/labels`.
- **Tests:** `contract/items`, `contract/labels`, `domain/barcode`, `domain/labels`, `label-fuzz.fixture`.

### M05 ledger
- **Today:** `src/db/movements.ts`, `src/domain/movement.ts`
- **Target:** `src/modules/ledger/{server/movements.ts, server/on-hand.ts, domain/movement.ts, ui/MovementTable.tsx}`
- **Tables/views:** `stock_movements` (append-only), `on_hand` (view), `stock_snapshots`.
- **Migration:** `0005_movements`. **Tests:** `contract/ledger`, `domain/movement`, `e2e/full-flow` (reconciliation).
- **Public API:** `postMovement`, `lockStockPair`, `onHand`, `movementHistory`.
- **Invariants:** never UPDATE/DELETE; every row has an actor; reasons from the closed list; debits guarded under advisory lock.

### M06 receiving
- **Today:** `src/db/receipts.ts`, `src/domain/receipt.ts`, `src/domain/intake.ts`, `src/app/intake/{page,actions,handler}.ts(x)`, `src/components/{IntakeScreen,ExpectedVsReceived,ScanField}.tsx`
- **Target:** `src/modules/receiving/{server/receipts.ts, domain/receipt.ts, domain/intake.ts, ui/IntakeScreen.tsx, ui/ExpectedVsReceived.tsx}`; `ScanField` → `src/modules/shell/ui/ScanField.tsx` (shared).
- **Tables:** `receipts`, `receipt_lines`. **Migration:** `0006_receipts`.
- **Routes:** `/intake` (→ rename `/receiving` with redirect). **Tests:** `contract/receipts`, `domain/receipt`, `domain/intake`.

### M07 requisitions
- **Today:** `src/db/requisitions.ts`, `src/domain/{requisition,requisition-keys,requisition-ui}.ts`, `src/app/requisitions/**`, `src/components/{RequisitionListScreen,RequisitionDetailScreen}.tsx`
- **Target:** `src/modules/requisitions/{server/, domain/, ui/}`
- **Tables:** `requisitions`, `requisition_lines`. **Migration:** `0007_requisitions`.
- **Routes:** `/requisitions`, `/requisitions/[id]`; planned `/requisitions/[id]/pick`, `/requisitions/[id]/dispatch-note`.
- **Tests:** `contract/requisitions`, `domain/requisition`, `domain/requisition-ui`.

### M08 transfers (new)
- **Target:** `src/modules/transfers/`; reuses ledger + transit; tables `transfers`, `transfer_lines` (or `requisitions.kind`). Routes `/transfers`, `/transfers/[id]`.

### M09 branch-usage (new)
- **Today (read side only):** `src/db/usage.ts`, `src/app/stock/usage/page.tsx`, `src/components/StockUsageScreen.tsx`
- **Target:** `src/modules/branch-usage/{server/usage.ts, server/policy.ts, ui/UsageEntry.tsx, ui/UsageReport.tsx}`
- **Tables:** planned `items.branch_policy`, `location_item_policy`. Routes `/usage` (entry), `/reports/usage`.
- **Tests:** `contract/usage`.

### M10 returns
- **Today:** `src/db/returns.ts` (no UI). **Tables:** uses `stock_movements` + migration `0008_returns` helpers.
- **Target:** `src/modules/returns/{server/returns.ts, ui/ReturnForm.tsx, ui/ReturnList.tsx}`. Routes `/returns`, `/returns/new`.
- **Tests:** `contract/returns`.

### M11 counts
- **Today:** `src/db/counts.ts` (no UI). **Tables:** `count_sessions`, `count_lines`. **Migration:** `0009_counts`.
- **Target:** `src/modules/counts/{server/, domain/abc.ts, ui/CountSession.tsx, ui/VarianceReview.tsx}`. Routes `/counts`, `/counts/[id]`.
- **Tests:** `contract/counts`.

### M12 lots-serials · M13 suppliers · M14 costing · M16 approvals · M17 audit-log · M22 settings · M23 offline (all new)
- One folder each under `src/modules/<name>/`, own migrations (`NNNN_<name>_*.sql`), own `tests/<name>/`. Designs in `docs/superpowers/specs/2026-10-28-warehouse-complete-system-study.md` §3.

### M15 reports
- **Today:** `src/db/replenishment.ts`, `src/app/reports/**`, `src/app/stock/**` (on-hand + history screens), `src/components/{StockListScreen,StockHistoryScreen,ReplenishmentScreen}.tsx`
- **Target:** stock screens → `src/modules/ledger/ui/` (they read the ledger); reports → `src/modules/reports/{server/<report>.ts, ui/<Report>.tsx, export/}`.
- **Tests:** `contract/replenishment`.

### M18 api
- **Today:** `src/api/{auth,errors,params,read,write,movements-write}.ts`, `src/app/api/v1/**`, `src/db/read-api.ts`, `src/db/api-clients.ts`
- **Target:** `src/modules/api/{server/, domain/errors.ts, domain/params.ts}`; route handlers stay in `src/app/api/v1/**` (thin).
- **Tables:** `api_clients`. **Tests:** `api/read-api`, `api/write-api`, `contract/api-clients`.

### M19 events
- **Today:** `src/domain/events.ts`, migration `0013_events` (`domain_events`, `event_subscriptions`). No worker.
- **Target:** `src/modules/events/{server/outbox.ts, server/deliver.ts, domain/events.ts}` + `src/app/api/cron/deliver-events/route.ts`.
- **Tests:** `domain/events`.

### M21 import-export
- **Today:** `src/import/opening.ts`, `scripts/{import-opening,seed,e2e-flow}.mjs`, `docs/import-format.md`, `docs/opening-sample.csv`
- **Target:** `src/modules/import-export/{server/opening.ts, server/catalog-import.ts, server/export.ts, ui/ImportWizard.tsx}`; scripts stay.
- **Tests:** `contract/opening-import`.

---

## 4. Cross-cutting maps

### 4.1 Route map (target)
| Route | Module | Roles |
|---|---|---|
| `/` dashboard | M02/M15 | all |
| `/stock`, `/stock/[variantId]` | M05 | all (branch = own) |
| `/receiving` (`/intake`) | M06 | owner, manager, staff |
| `/requisitions/**` | M07 | all |
| `/transfers/**` | M08 | all |
| `/usage` | M09 | branch |
| `/returns/**` | M10 | all |
| `/counts/**` | M11 | all |
| `/items/**`, `/labels` | M04 | owner, manager |
| `/suppliers/**`, `/purchase-orders/**` | M13 | owner, manager |
| `/reports/**` | M15 | owner, manager, viewer |
| `/approvals` | M16 | owner |
| `/admin/users|locations|settings|api-keys|webhooks|history` | M01/M03/M22/M18/M19/M17 | owner |
| `/account` | M01 | all |
| `/api/v1/**` | M18 | API keys |
| `/api/labels/**` | M04 | signed-in |
| `/api/cron/**` | M19/M14/M11 | cron secret |

### 4.2 Movement reason → writer map (every reason must have a screen *and* an API path)
| Reason | Written by | UI today | UI target |
|---|---|---|---|
| `opening_balance` | M21 import | CLI | Import wizard |
| `receipt` | M06 | ✅ /intake | ✅ |
| `issue_to_branch` | M07 issue + confirm | ✅ | ✅ |
| `transfer` | M08, bins put-away | ❌ | /transfers, put-away |
| `return_from_branch` | M10 / M07 return | ❌ | /returns |
| `consumption` | M09, API | API only | /usage + auto on receipt |
| `sale` | API, M20 Shopify | API only | via integrations |
| `count_correction` | M11 | ❌ | /counts |
| `write_off` | M10 | ❌ | /returns (+ approval) |

A CI test (`F-10`) greps that each reason in the CHECK list has at least one non-test writer.

### 4.3 i18n namespaces
One prefix per module: `auth.*`, `nav.*`, `stock.*`, `intake.*`, `requisitions.*`, `transfers.*`, `usage.*`, `returns.*`, `counts.*`, `items.*`, `labels.*`, `reports.*`, `approvals.*`, `admin.*`, `settings.*`, `common.*`. A test asserts `ar.json` and `en.json` have identical key sets (`F-08`), **except the four Arabic-only CLDR plural forms (`cart.items.zero`/`two`/`few`/`many`) which English's `Intl.PluralRules` never selects** — those keys exist only in `ar.json` by design. See `tests/shell/domain/i18n-parity.test.ts`.

### 4.4 Test map
| Folder | Kind | Needs DB |
|---|---|---|
| `tests/domain/` | pure unit tests | no |
| `tests/contract/` | SQL/RLS/writer behaviour as `authenticated` | yes |
| `tests/api/` | HTTP handlers | yes |
| `tests/e2e/` | full-flow + session gate | yes |
| `tests/ui/` (new, Playwright) | screens per role, AR/EN, 390/1280 px screenshots | yes + server |

Target: tests mirror modules — `tests/<module>/{domain,contract,ui}/…` (moved in `F-01`).

### 4.5 Migration naming (from 0015)
`NNNN_<module>_<what>.sql`, e.g. `0015_branch-usage_policy.sql`. Never edit an applied migration.
