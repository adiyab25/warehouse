# 0001 — Locations admin UI

**Status:** Proposed
**Date:** 2026-10-29
**Mode:** ENHANCEMENT

## Summary

Add an admin screen for locations (branches, bins, shelves) so owner and manager can view, add, edit, and rename them. Backend (M03) already exists; this spec covers only the UI.

## Requirements

- AC-1: `/admin/locations` lists all locations grouped by type (warehouse, branch, bin, transit, scrap, quarantine, vendor, holder).
- AC-2: Owner and manager can add a new location (type, name, parent for bins).
- AC-3: Owner and manager can rename an existing location.
- AC-4: Owner can remove a location only if it has no stock on hand.
- AC-5: Screen is Arabic-first RTL, phone-first (390px), uses shared shell components.
- AC-6: All strings in both `ar.json` and `en.json`.

## Decision

Build a single page `/admin/locations` with a table/list of locations and a dialog for add/edit. Reuse `PageHeader`, `DataTable`, `EmptyState` from shell. Permission gate: `locations:manage` for add/edit/remove, `locations:view` for list.

## Build plan

1. Create `src/modules/locations/ui/LocationList.tsx` and `LocationForm.tsx`.
2. Add route `src/app/(app)/admin/locations/page.tsx` (thin: read params, call module, render).
3. Add server actions in `src/app/(app)/admin/locations/actions.ts` (auth + call module).
4. Wire i18n keys in `ar.json`/`en.json`.
5. Add `PermissionGate` for manage actions.

## Consequences

- Locations become manageable from the UI; no DB changes needed.
- Follows existing module convention (ui/ + thin route).

## Follow-up

- Nested AGENTS.md for locations if conventions grow.
path">
C:/Workspace/warehouse/docs/specs/0001-locations-ui.md