# Scope: Warehouse (kindergarten chain) — UI/backend alignment pass

Multi-tenant, Arabic-first, phone-first warehouse and stock-control system for a kindergarten chain (1 central warehouse, 14 branches). This pass focuses on making the app functional end to end: aligning the frontend UI with the already-built backend modules.

**Build approach:** Tracer Bullet (vertical slices; each feature built end to end through every layer, working).
**Workflow:** Beta (after /develop: /check verify, then /test).

_These are recommendations to keep your build orderly, not requirements. Skip anything that does not fit._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | Platform (DB, tenant, migrations) | Foundation | existing |
| 2 | Auth (sign-in, sessions, roles) | Foundation | existing |
| 3 | Shell (layout, nav, i18n, theme) | Foundation | in-progress |
| 4 | Locations (branches, bins, shelves) | Foundation | in-progress |
| 5 | Catalog (items, variants, categories, labels) | Foundation | in-progress |
| 6 | Ledger (movements, on-hand) | Foundation | existing |
| 7 | Receiving (intake, partial delivery, variance) | Slice 1 | existing |
| 8 | Requisitions (request → approve → issue → confirm) | Slice 1 | existing |
| 9 | Reports (stock, replenishment, history screens) | Slice 1 | in-progress |
| 10 | Transfers (branch/bin moves through transit) | Slice 2 | planned |
| 11 | Returns (restock/quarantine/write-off) | Slice 2 | planned |
| 12 | Counts (stocktake, recount, post) | Slice 2 | planned |
| 13 | Branch usage (consumption entry) | Slice 2 | planned |
| 14 | Suppliers & purchase orders | Slice 3 | planned |
| 15 | Settings (tenant config, branding, thresholds) | Slice 3 | planned |
| 16 | Audit log (change history) | Slice 3 | planned |
| 17 | Admin screens (users, roles, locations, api keys) | Slice 3 | planned |
| 18 | Import/export (opening balances, CSV) | Slice 3 | in-progress |

## Foundations

### 1. Platform · existing
DB pools, tenant scoping, migrations, env, errors, logging. code in `src/db/`, `src/modules/platform/`

### 2. Auth · existing
Sign-in, sessions, lockout, roles & permissions. code in `src/auth/`, `src/app/sign-in/`

### 3. Shell · in-progress
App layout, sidebar, top bar, global scan/search, dashboards, i18n, theme. Partial: dashboard and scan widgets incomplete.
**Done when:** signed-in shell renders with nav, language switcher, and dashboard KPIs for all roles.
- [ ] Finish dashboard + global scan: `/develop shell`

### 4. Locations · in-progress
Locations backend exists (M03); admin UI for branches/bins/shelves.
**Done when:** owner/manager can view, add, edit, rename locations from the UI.
- [x] Design it (spec): `/architect locations UI`
- [ ] Build it: `/develop locations UI`
   - [ ] LocationList + LocationForm components
   - [ ] Route + server actions
   - [ ] i18n keys (ar/en)
   - [ ] PermissionGate for manage
- [ ] Verify it: `/check verify locations UI`
- [ ] Test it: `/test locations UI`
Spec 0001 · code in `src/modules/locations/`

### 5. Catalog · in-progress
Items, variants, categories, barcodes, min/max levels, labels. Backend exists; item management UI partial.
**Done when:** owner/manager can add/edit items, variants, unit cost, categories from the UI.
- [ ] Design it (spec): `/architect catalog UI`
- [ ] Build it: `/develop catalog UI`

### 6. Ledger · existing
Stock movements, on-hand view, history, stock guard, snapshots. code in `src/db/movements.ts`, `src/modules/ledger/`

## Slice 1: Core flows (already built, UI present)

### 7. Receiving · existing
Delivery notes/receipts, partial deliveries, variance. code in `src/db/receipts.ts`, `src/app/intake/`

### 8. Requisitions · existing
Branch request → approve → issue (transit) → confirm; pick list; dispatch. code in `src/db/requisitions.ts`, `src/app/requisitions/`

### 9. Reports · in-progress
Stock screens, replenishment, history. Backend exists; several report screens incomplete.
**Done when:** stock list, stock history, and replenishment screens render with filters for all roles.
- [ ] Finish report screens: `/develop reports UI`

## Slice 2: Missing modules (backend partial or absent, no UI)

### 10. Transfers · planned
Branch-to-branch and bin-to-bin moves through transit. No backend or UI yet.
**Done when:** a user can create, approve, and confirm a transfer between branches.
- [ ] Design it (spec): `/architect transfers`

### 11. Returns · planned
Restock / quarantine / write-off, return to supplier. Backend helpers exist; no UI.
**Done when:** a user can create and process a return (restock, quarantine, or scrap).
- [ ] Design it (spec): `/architect returns`

### 12. Counts · planned
Stocktake sessions, blind count, recount, cycle counts. Backend exists; no UI.
**Done when:** a user can run a count session, enter counts, and post adjustments.
- [ ] Design it (spec): `/architect counts`

### 13. Branch usage · planned
Branch consumption/sale entry. Read side exists; entry UI missing.
**Done when:** a branch user can enter consumption and see usage history.
- [ ] Design it (spec): `/architect branch usage`

## Slice 3: Admin & settings

### 14. Suppliers & purchase orders · planned
Suppliers, POs, reorder suggestions. No backend or UI yet.
**Done when:** owner/manager can manage suppliers and create POs.
- [ ] Design it (spec): `/architect suppliers`

### 15. Settings · planned
Tenant settings: thresholds, branding, label size, language. No backend or UI yet.
**Done when:** owner can configure tenant settings from the UI.
- [ ] Design it (spec): `/architect settings`

### 16. Audit log · planned
Change history of master data. No backend or UI yet.
**Done when:** mutations are logged and viewable with filters.
- [ ] Design it (spec): `/architect audit log`

### 17. Admin screens · planned
Users, roles, locations, API keys, webhooks management. Backend partially exists; UI missing.
**Done when:** owner can manage users, roles, and API keys from the UI.
- [ ] Design it (spec): `/architect admin screens`

### 18. Import/export · in-progress
Opening balances, catalogue CSV/Excel import & export. Partial.
**Done when:** owner can import opening balances and export catalogue.
- [ ] Finish import wizard: `/develop import/export`

## Legend

**Next step** = first unticked box. **needs a decision** = run `/architect` first. Atomic build tasks live in the spec's `## Build plan`, not here. Status: `planned` → `in-progress` → `done`, plus `existing` (pre-workflow) and `dropped`. Pointer line (`spec <n> · code in <path>`) appears only once those exist.
path">
C:/Workspace/warehouse/docs/scope/scope.md