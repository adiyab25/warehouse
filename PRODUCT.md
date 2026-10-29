# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Small Egyptian clothing-e-commerce businesses operating on Shopify + Bosta courier + Meta ads. Primary users: warehouse staff (intake, stock movement, counts), branch staff (requisitions, usage), managers (approvals, oversight), and the business owner (dashboards, settings). Arabic-first, RTL, EGP currency.

## Product Purpose

A warehouse/stock operations console that replaces spreadsheets and manual tracking. Manages inventory across a central warehouse and multiple branches: receiving, storage, requisitions, transfers, returns, stock counts, and reporting. Every movement is auditable with an actor. Goal: accurate stock at all times, per-tenant isolation, append-only ledger.

## Positioning

An operations backbone for small clothing brands — not a full ERP, but the stock truth layer that Shopify and Bosta don't provide. Tenant-isolated, RLS-enforced, runs as a non-owner app role.

## Operating Context

- Workflows happen on phones (390px) in warehouses and branches, often standing, one-handed.
- Arabic (RTL) primary, English (LTR) secondary. Latin digits for numbers; codes/SKUs in LTR.
- Money and quantities in SQL numeric. Multi-tenant (tenant_id composite FKs).
- Ledger is append-only; only the ledger module writes stock_movements. Every row has an actor.

## Capabilities and Constraints

- Stack: Next.js 16 App Router, React 19, Tailwind v4, self-hosted Supabase (Postgres 15).
- Auth: Supabase auth, app runs as `authenticated` role (never owner).
- i18n: ar.json + en.json, parity enforced by CI.
- Tests: node:test + Playwright. Gate: `npm run ci` (tsc + eslint + tests, 0 skipped).
- Migration numbers assigned by lead; new files only, never edit applied ones.

## Brand Commitments

- Brand accent: deep teal `#0f766e` (default, reversible — owner to confirm).
- App name: "Warehouse" (default, reversible).
- Logo: text logo (default, reversible).
- Font: IBM Plex Sans Arabic (arabic + latin subsets), IBM Plex Mono for mono.
- RTL-first: `<html lang="ar" dir="rtl">`.

## Evidence on Hand

- 413 tests passing, 0 skipped. Production build clean.
- shadcn/ui installed (radix-nova style, RTL on, Tailwind v4, lucide icons), 27 primitives in src/components/ui/.
- Impeccable v4.8.0 installed globally.

## Product Principles

1. Stock truth is append-only and auditable — every movement has an actor.
2. Tenant isolation is non-negotiable — forced RLS, composite FKs, app runs as non-owner.
3. Phone-first, Arabic-first — 390px and RTL are the baseline, not afterthoughts.
4. Shared styling lives in one place — globals.css and shadcn tokens, never per-screen.
5. CI is the gate — 0 skipped tests, every PR green.

## Accessibility & Inclusion

- 44px minimum tap targets. Keyboard reachable. Empty/loading/error states required.
- Arabic + Latin in one font family. Latin digits for numbers.
- RTL mirrors layout; codes/SKUs stay LTR via .ltr-value.