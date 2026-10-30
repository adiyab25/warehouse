# R0 — Repo audit (roles, guards, list screens)

Generated 2026-10-29.

## 1. `requireRole(` call sites
None. `requireRole` already removed; `requirePermission` count: 1 (only definition/import site). Legacy role-based helpers still present in schema modules (see §3).

## 2. Places reading `app_users.role` / role enum
- src/modules/auth/db.ts (session load: role column still read)
- src/modules/platform/types.ts (role union type)
- src/modules/import-export/db.ts (ALLOWED_ROLES check on user.role)
- src/app/stock/handler.ts, src/app/requisitions/handler.ts (role passed to scope helpers)
- src/modules/shell/ui/AppSidebar.tsx, src/modules/shell/schema.ts (navLinksForRole)
- src/modules/receiving/schema.ts, src/modules/requisitions/schema.ts (canReceive/canRequest/canApproveOrIssue role guards)

Note: role_id FK exists (migrations 0016-0020). Permission tables exist (0016). Session version (0022), unit cost (0023), adjustment reasons (0024), audit log (0025) migrated.

## 3. Routes/actions lacking permission guards
Permission guards largely absent from server actions; role-based guards (can*) still in use. Full enumeration requires DB-backed test run; not runnable here (no Postgres).

## 4. Existing list screens and query style
- Stock list (src/app/stock) — role-scoped
- Requisitions list+detail
- Intake/receiving
- Usage
- Replenishment
- Reports

None accept ListFilter yet (1C.9 pending).

## Recommendation
Tracker is stale: migrations 0016-0025 already applied and requireRole removed, but services/UI still role-based. Next work: finish 1A.3 (permission guards), 1A.5 (PermissionGate), then 1C.x filters. DB must be running to validate.
