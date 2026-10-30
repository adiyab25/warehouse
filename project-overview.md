# Project Overview

> Warehouse — stock operations console for small clothing brands.

## What It Is
A warehouse/stock operations console that replaces spreadsheets and manual tracking. Manages inventory across a central warehouse and multiple branches: receiving, storage, requisitions, transfers, returns, stock counts, and reporting. Every movement is auditable with an actor.

## Who It's For
Small Egyptian clothing-e-commerce businesses operating on Shopify + Bosta courier + Meta ads. Users: warehouse staff, branch staff, managers, business owner. Arabic-first (RTL), EGP currency.

## Tech Stack
- **Frontend:** Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui (radix-nova, RTL on)
- **Backend:** Self-hosted Supabase (Postgres 15), Node.js
- **Auth:** Supabase auth, app runs as `authenticated` role (never owner)
- **i18n:** Arabic (primary) + English, parity enforced by CI
- **Testing:** node:test (414 tests), Playwright (E2E), GitHub Actions CI
- **Design:** Impeccable v4.8, IBM Plex Sans Arabic, teal #0f766e accent

## Key Properties
- **Append-only ledger:** only `ledger` module writes `stock_movements`. Every row has an actor.
- **Tenant isolation:** forced RLS, composite tenant FKs. Multi-tenant.
- **Phone-first:** 390px baseline, 44px tap targets, Arabic RTL.
- **CI gate:** `npm run ci` (tsc + eslint + tests, 0 skipped). No merge without green CI.
- **Branch protection:** enabled (CI required, 1 PR review, no force pushes).

## Current State
- **Phase:** P0 (Foundation) — COMPLETE
- **Tests:** 414 passed, 0 skipped
- **Build:** clean
- **Repo:** public (adiyab25/warehouse)
- **Dev server:** http://localhost:3000 (or 3001)

## Owner Decisions (defaults, reversible)
- Brand accent: deep teal `#0f766e`
- App name: "Warehouse"
- Logo: text logo
- Recorded in: docs/adr/0001-default-brand-identity.md
---

## Extended Reference (from suggested docs)

# Project Overview

> Warehouse — stock operations console for a kindergarten chain.
> Source: `docs/architecture/MAP.md`, FEATURES.md, PLANS.md.

## What It Is
A multi-tenant, Arabic-first, phone-first warehouse and stock-control system.
One central warehouse distributes to 14 branches. No customer-facing sales. No e-commerce.
Replaces spreadsheets and manual tracking. Every movement is auditable with an actor.

## Who It's For
A kindergarten chain operating across 14 branches. Users: warehouse staff, branch coordinators, manager, business owner. Arabic-first (RTL), EGP currency.

## Who Uses It — Roles

Roles are **not** fixed system types. The owner creates and names roles, then assigns
permissions to each one. Three seed roles ship with the app:

| Seed Role | Intended for | Default capabilities |
|---|---|---|
| Owner | Kindergarten owner | Everything, including role and permission management |
| Manager | Warehouse manager | Receive, approve, issue, counts, all reports including cost |
| Branch | Branch coordinator | Requisitions, confirm deliveries, log usage, own reports |

The owner can create additional roles (e.g. "Accountant", "Supervisor") and grant or
revoke any permission for any role at any time. Changes take effect on the user's
next request — no re-login required.

## Core Operational Loop
```
Receive from supplier → Store in warehouse → Branch requests → Manager approves
→ Issue (in transit) → Branch confirms → Branch consumes / returns / counts
```

## Target Stock Types
- Educational books (per-curriculum edition, per-grade)
- Uniforms (size and gender variants)
- Daily consumables (paper, markers, cleaning supplies)

## Item Costing
Every item variant is entered with a unit cost (EGP, stored as integer piastres — no floats).
Cost is snapshotted onto every ledger movement row, so historical cost is preserved
even when an item's price is updated later.

This enables — with no separate costing module:
- How much the warehouse spent this month (total cost of received goods)
- How much each branch received this month (cost of issued goods per branch)
- What each branch took during any date range (items + quantities + cost)
- Current total stock value at any point in time

A full weighted-average costing module (Plan 2) adds supplier-price variance and
auto-updates costs when a purchase price changes.

## Tech Stack
- **Frontend:** Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui (radix-nova, RTL on)
- **Backend:** Self-hosted Supabase (Postgres 15), Node.js
- **Auth:** Supabase auth, app runs as `authenticated` role (never owner)
- **i18n:** Arabic (primary) + English, parity enforced by CI (F-08)
- **Testing:** node:test (414 tests), Playwright (E2E), GitHub Actions CI
- **Design:** Impeccable v4.8, IBM Plex Sans Arabic, teal `#0f766e` accent
- **Hosting:** Vercel

## Key Properties
- **Append-only ledger:** only `ledger` module writes `stock_movements`. Every row has an actor.
- **Permission-based auth:** roles are owner-created; every route/action checks a permission key.
- **Tenant isolation:** forced RLS, composite tenant FKs. App runs as `authenticated`, never as owner.
- **Phone-first:** 390px baseline, 44px tap targets, Arabic RTL.
- **Filtering standard:** every list screen supports search, status, date range, branch, item, sort — server-side, URL-persisted.
- **CI gate:** `npm run ci` (tsc + eslint + tests, 0 skipped). No merge without green CI.
- **Branch protection:** enabled (CI required, 1 PR review, no force pushes).

## Current State
- **Phase:** P0 (Foundation) — COMPLETE
- **Tests:** 414 passed, 0 skipped
- **Build:** clean
- **Repo:** public (adiyab25/warehouse)
- **Dev server:** http://localhost:3000 (or 3001)

## Filtering — Standard Across All List Screens
Every list screen (requisitions, stock, intake, returns, counts, reports, audit log)
supports the same filter pattern:

| Filter | Type |
|---|---|
| Search | Text — item name, doc number, SKU, branch name |
| Status | Multi-select badge picker |
| Date range | From / To date picker (presets: today, this week, this month, custom) |
| Branch | Dropdown — all branches or specific (hidden on branch-role screens) |
| Item / category | Dropdown or barcode scan |
| Created by | User picker (owner/manager screens only) |
| Sort | Column header click, asc/desc |

Filters are applied server-side. Active filters shown as dismissible chips above the table.
Filter state persists in URL query params — pages are shareable and bookmarkable.
On mobile, filters collapse into a bottom sheet.

## Scope Boundaries (what this app does NOT do)
- No customer sales, invoicing or e-commerce
- No multi-currency or tax / e-invoicing
- No HR, payroll or scheduling
- No student records
- No shipping carriers (internal delivery only)
- Integrations (WhatsApp, Shopify, Bosta) are Plan 2 / post-MVP

## Owner Decisions (defaults, reversible)
- Brand accent: deep teal `#0f766e`
- App name: "Warehouse"
- Logo: text logo
- Recorded in: `docs/adr/0001-default-brand-identity.md`

## Success Definition
The owner can see at any moment how much money is in stock, what every branch received
and spent in a period, and who did what. A manager and 14 branch coordinators can do
their full weekly workflow on a phone, in Arabic, without calling or texting each other.
