# Action Plan — from backbone to a solid, complete warehouse application

> **Owner:** Jooubie · **Lead agent:** Hermes · **Date:** 2026-10-28
> Read with: `docs/architecture/MAP.md` (where everything lives),
> `docs/agents/ORCHESTRATION.md` (how agents work), `docs/design/DESIGN-DIRECTION.md` (how it looks),
> study `C:\Workspace\docs\superpowers\specs\2026-10-28-warehouse-complete-system-study.md` (why each feature).
> Every ticket below becomes one GitHub issue in `adiyab25/warehouse` with label `area:<module>` and milestone `P<n>`.

## 0. Where we start (verified 2026-10-28)
- `master`: 20 build tasks done, **411 tests pass, 0 skipped**, production build clean.
- Branch `chore/ui-foundation` (pushed): **shadcn/ui installed** (style `radix-nova`, RTL on, Tailwind v4, lucide icons) with 27 primitives in `src/components/ui/`, `src/lib/utils.ts`, `src/hooks/use-mobile.ts`, `components.json`, `next.config.mjs`. Gate still green (411/411).
- **Impeccable** installed for Hermes (global skill `impeccable` v4.8, engine 0.1.18).
- Not done: `/impeccable init` (needs the owner's answers — ticket `F-02`).

## 1. Phases at a glance
| Phase | Milestone | Goal | Tickets | Est. |
|---|---|---|---|---|
| **P0** | Foundation | Code structure, design system, app shell, CI/QA rails | F-01…F-12 | 1.5 wk |
| **P1** | Daily jobs | Every daily job has a screen | D-01…D-12 | 2.5 wk |
| **P2** | Control | Admin, permissions, approvals, history, API keys | A-01…A-09 | 1.5 wk |
| **P3** | Go live | Online, safe, real data, people trained | L-01…L-08 | 1 wk |
| **P4** | Smart stock | Expiry, suppliers/POs, bins, cycle counts, reorder | S-01…S-09 | 2 wk |
| **P5** | Money & reports | True cost, month-end, reports, exports | R-01…R-07 | 1.5 wk |
| **P6** | Phone first | PWA, offline queue, camera scan, printers | O-01…O-05 | 1 wk |
| **P7** | Connections | Webhooks, Shopify, Bosta, WhatsApp | C-01…C-07 | 2 wk+ |

Parallel lanes: inside a phase, tickets with no dependency between them run as parallel workers (max 3–4). Lane letters in the tables: **A** = data/ledger, **B** = screens, **C** = infra/QA.

---

## P0 — Foundation (must finish before P1 starts)

| ID | Title | Module | Lane | Size | Depends |
|---|---|---|---|---|---|
| F-01 | Move code into `src/modules/<m>/` + import-boundary lint | all | C | L | — |
| F-02 | Impeccable init → `PRODUCT.md`; `/impeccable document` → `DESIGN.md` | shell | B | S | owner answers |
| F-03 | Design tokens in `globals.css` (light + dark), Arabic font, retire old field CSS into shadcn tokens | shell | B | M | F-02 |
| F-04 | App frame: route groups `(app)`/`(auth)`, `AppSidebar`, `TopBar`, user menu, appearance toggle, `DirectionProvider`, mobile bottom bar | shell | B | M | F-03 |
| F-05 | Shared components: `PageHeader`, `DataTable`, `FilterBar`, `StatusBadge`, `KpiCard`, `QtyStepper`, `EmptyState`, `ConfirmDialog`, `DocNumber`, `Money/Qty/DateTime` | shell | B | M | F-03 |
| F-06 | GitHub Actions CI (Postgres service, migrate, `npm run ci`, build, `impeccable detect`), PR template, branch protection, labels `area:*`, milestones P0–P7 | platform | C | M | — |
| F-07 | Playwright harness: seed tenant, sign in per role, screenshot AR/EN × 390/1280 | platform | C | M | F-04 |
| F-08 | i18n parity test (ar/en same keys) + missing-key fails CI | shell | C | S | — |
| F-09 | Human document numbers (`RCV-/REQ-/TRF-/RET-/CNT-/ADJ-/PO-YYYY-NNNN`) | platform | A | M | F-01 |
| F-10 | "Every reason has a writer" CI test (MAP §4.2) | ledger | C | S | F-01 |
| F-11 | Restyle the 6 existing screens on the new frame/templates | shell+M05-07,M15 | B | M | F-04, F-05 |
| F-12 | Role dashboards v1 (tiles from existing data) | shell/reports | B | M | F-05 |

### F-01 Module restructure (mechanical, zero behaviour change)
- **Do:** create `src/modules/{platform,auth,shell,locations,catalog,ledger,receiving,requisitions,branch-usage,returns,counts,reports,api,events,import-export}/{domain,server,ui}/` + `index.ts`; `git mv` every file per MAP.md §3 "Target"; update imports to `@/modules/<m>`; move tests to `tests/<m>/…`; update `package.json` test glob.
- **Add** ESLint `no-restricted-imports` rules for MAP §1 (domain can't import server/ui/pg/react; cross-module only via `index.ts`).
- **Accept:** `git diff --stat -M` shows renames only (+ import lines); 411 tests, 0 skipped; `next build` ok; e2e ok; a deliberately bad import fails lint (prove, then remove).
- **Why first:** every later ticket's *owned paths* assume this layout.

### F-02 Impeccable init (needs the owner, 10 minutes)
- Lead runs `/impeccable init` in this repo; answers come from the owner (audience, purpose, constraints, voice — most are already in the study; the owner confirms brand colour/accent and name/logo).
- Then `/impeccable document` to generate root `DESIGN.md` from `docs/design/DESIGN-DIRECTION.md` + tokens.
- **Accept:** `PRODUCT.md`, `DESIGN.md` committed; `.impeccable/` config committed per Impeccable README; `AGENTS.md` links both.

### F-03 Tokens & type
- Map DESIGN.md tokens onto shadcn variables (`--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--ring`, `--sidebar-*`, `--chart-*`) + add `--status-ok|wait|bad|transit|idle`.
- Replace Geist (added by shadcn init) with **IBM Plex Sans Arabic** via `next/font/google` (subsets `arabic`,`latin`), mono = IBM Plex Mono.
- Keep `.ltr-value`; fold the old "shared form controls" block into shadcn `Input`/`Field` (existing test `form-controls-css.test.ts` updated to assert the new tokens still give a visible border + focus ring).
- **Accept:** both themes render; contrast AA on text/status; Arabic + Latin in one family; tests green.

### F-04 App frame
- `src/app/(auth)/sign-in`, `src/app/(app)/layout.tsx` with `SidebarProvider` + `AppSidebar` (nav from `shell/domain/nav.ts`, role-filtered, counts badges later) + `TopBar` (sidebar trigger, breadcrumb, `GlobalScan` placeholder, language switch, user menu with sign-out) + footer.
- `DirectionProvider dir={DIRECTION[lang]}`; portals get `dir`.
- Phone (< 768 px): sidebar becomes `Sheet`; branch role gets a bottom tab bar.
- **Accept:** Playwright: each role sees exactly its nav (extends `home-nav.test.ts`); AR mirrors; sign-out works from the menu; no horizontal scroll at 390 px.

### F-05 Shared components
- Built in `src/modules/shell/ui/`; each with a story-style demo route `/dev/ui` (dev only) for design review.
- `DataTable` = TanStack Table + shadcn Table: sort, column visibility, server pagination props, cards under 640 px.
- `StatusBadge` maps every document/line status (receipts, requisitions, counts, lines) → status token + i18n label — one map, tested.
- **Accept:** `/dev/ui` screenshot AR/EN; unit test of the status map covers every status in the CHECK constraints.

### F-06 CI on GitHub
- `.github/workflows/ci.yml`: `postgres:15` service → bootstrap SQL (`C:/Workspace/pg/bootstrap-supabase.sql` copied into `scripts/ci/bootstrap.sql`) → `npm ci` → `db:migrate` → `npm run ci` → `next build` → start → `npx impeccable detect http://localhost:3000/sign-in --github`.
- `.github/pull_request_template.md` (ticket, acceptance checklist, screenshots, gate output).
- Labels `area:<module>` for M00–M23, milestones P0–P7; protect `master`.
- **Accept:** a PR shows the green check; a failing test blocks merge.

### F-09 Document numbers
- Migration `0015_platform_doc_numbers.sql`: `doc_sequences(tenant_id, kind, year, next)`, function `next_doc_number(kind)` (row lock), `number` column on receipts/requisitions/count_sessions (unique per tenant), backfill.
- **Accept:** concurrent creation yields unique gap-free numbers per kind/year; RLS convention test passes; UI shows numbers, URLs keep UUIDs.

### F-10 Reason writer check — test reads the CHECK list from `pg_constraint` and greps `src/modules/**/server` for a writer of each reason; known gaps listed in an allow-list that must shrink to zero by end of P1.

### F-11 / F-12 — restyle Stock, Item history, Requisitions (list/detail), Intake, Usage, Replenishment on the templates; dashboards: owner (stock lines, below-min count, open requests, in-transit), manager (to approve / to issue / receipts receiving), branch (my open requests, to confirm).

**P0 exit:** owner sees a finished-looking app on the same features; CI on GitHub; structure ready for parallel work.

---

## P1 — Daily jobs complete

| ID | Title | Module | Lane | Size | Depends |
|---|---|---|---|---|---|
| D-01 | Branch policy (`consume_on_receipt` / `track_at_branch`) + auto-consume on confirm | branch-usage, requisitions | A | M | F-01 |
| D-02 | Branch usage entry screen (scan workflow) for tracked items | branch-usage | B | M | D-01, F-05 |
| D-03 | Items list + item page (tabs: details, variants, stock, levels, history) | catalog | B | L | F-05 |
| D-04 | Item create/edit + variant grid (sizes × colours → SKUs/barcodes) + categories table | catalog | A+B | L | F-01 |
| D-05 | Label printing UI (from item, receipt, selection, locations) | catalog | B | M | D-03 |
| D-06 | Locations admin (warehouse/branches/holders), min/max per location | locations, catalog | B | M | F-05 |
| D-07 | Returns screen (from branch/customer → restock/quarantine/scrap, reason, photo later) | returns | B | M | F-05 |
| D-08 | Stock count screen: open → blind scan/count → recount rule → close & post | counts | A+B | L | F-05 |
| D-09 | Branch-to-branch transfer document + screens | transfers | A+B | L | F-09 |
| D-10 | Pick list (by bin when bins exist) + printable dispatch note with QR | requisitions | B | M | F-09 |
| D-11 | Negative-stock refusal on issue + owner override window setting | requisitions, ledger | A | S | — |
| D-12 | Requisition UX: favourites / "same as last time", approve-all, in-transit ageing badge | requisitions | B | M | F-11 |

Key acceptance (each a test):
- **D-01:** confirm 10 of a consume item → branch on-hand 0 and one `consumption` row with the confirming user as actor and key `<line>:consume`; retry posts nothing; tracked item stays 10; replenishment rate uses consumption.
- **D-04:** variant grid creates n×m variants with unique SKU/barcode; barcode of a variant with movements cannot change; retired item cannot be received/requested; edit writes nothing to the ledger.
- **D-07:** each destination posts exactly the right from/to pair; write-off requires a reason; return of more than was issued refused.
- **D-08:** counter doesn't see expected qty; variance > threshold demands a second counter; close posts one `count_correction` per non-zero line; movements during an open count are reflected (existing reconciliation rule).
- **D-09:** A→transit on send, transit→B on confirm; partial confirm leaves the rest in transit and visible; B can't confirm its own send.
- **D-11:** issue above on-hand → `insufficient_stock` in AR/EN; owner override within window posts with `notes` = reason and is listed on the dashboard.
- **P1 exit:** F-10 allow-list empty (every reason has a UI writer); e2e extended with transfer, return, count, usage.

---

## P2 — Control

| ID | Title | Module | Size | Depends |
|---|---|---|---|---|
| A-01 | Permissions matrix (`role × action`) in `auth/domain/permissions.ts`, used by every action; add roles `warehouse_staff`, `viewer` (migration) | auth | M | P1 |
| A-02 | Users admin: create, deactivate, reset password, branch, language; "sign out everywhere"; password change revokes other sessions | auth | M | A-01 |
| A-03 | Settings: company name/logo, thresholds, negative-stock window, label size, default language | settings | M | — |
| A-04 | Approvals engine + inbox (write-off over X EGP, variance over Y%, override, over-max request) | approvals | L | A-03 |
| A-05 | In-app notifications (bell) + daily owner digest (in-app; email later) | approvals | M | A-04 |
| A-06 | Change log: `audit_log` + triggers on items, variants, levels, locations, users, api_clients, settings; "History" tab | audit-log | M | — |
| A-07 | API keys admin: create (show once), scopes, **allowed locations**, daily cap, revoke, last used | api | M | A-01 |
| A-08 | Actor name frozen at posting time (`actor_label` on movements) | ledger | S | — |
| A-09 | Login hardening: per-IP + global rate limit, purge job wiring | auth | S | — |

**P2 exit:** the owner runs users, branches, keys and approvals without SQL; every master-data change has a who/when/before/after.

---

## P3 — Go live

| ID | Title | Size |
|---|---|---|
| L-01 | Supabase project (Frankfurt) staging + prod; owner vs app roles; migrations via CI | M |
| L-02 | Vercel project; env vars; `TENANT_ID`; preview deploys per PR to staging | S |
| L-03 | Cron routes (`/api/cron/*`, secret-protected): purge, snapshots (later), digest | S |
| L-04 | Backups + PITR + weekly restore drill into staging (scripted) | S |
| L-05 | Monitoring: Sentry, `/api/health`, uptime check, nightly production ledger reconciliation alert | M |
| L-06 | Real catalogue import (Excel → CSV) + label print run + opening count → opening balances | M |
| L-07 | Arabic one-page guides per role (screenshots from Playwright) + training sessions | S |
| L-08 | Two-week parallel run checklist; go/no-go review | S |

---

## P4 — Smart stock
S-01 suppliers · S-02 expected deliveries / purchase orders feeding intake · S-03 attachments (Supabase Storage: delivery-note photos, damage photos) · S-04 quality check via quarantine + return to supplier · S-05 lots + expiry + FEFO + expiry dashboard · S-06 serials + asset register + custody form · S-07 bins + put-away rules + `on_hand_rollup` · S-08 cycle counts + ABC classification job · S-09 reorder suggestions → one-tap PO / requisition draft.
*(Detailed packets written by the lead at P4 start, from study §3.4–3.10.)*

## P5 — Money & reports
R-01 `unit_cost` on movements + moving average (`variant_costs`) · R-02 month-end close + `stock_snapshots` job + back-dating lock · R-03 report framework (filters, server pagination, Excel/PDF export) · R-04 the 14 reports (study §3.12) · R-05 owner dashboard with trends · R-06 receipt-variance-by-supplier & loss analysis · R-07 dead/slow stock.

## P6 — Phone first
O-01 PWA (manifest, icons, install prompt) · O-02 offline queue (IndexedDB, idempotent replay, "3 waiting" indicator) for confirm/usage/count · O-03 camera scanning (`BarcodeDetector` → `@zxing/browser` fallback) · O-04 scan sounds/vibration · O-05 label printer commissioning (Xprinter/Zebra, exact 50×30 PDF; ZPL optional).

## P7 — Connections
C-01 webhook delivery worker (HMAC signature, backoff, dead-letter) + delivery log UI · C-02 OpenAPI spec + `/docs/api` page · C-03 `external_ids` + integration accounts (encrypted) · C-04 reservations (`reserved` qty) **before** any availability push · C-05 Shopify: orders → `sale`, refunds → compensation, `inventorySetQuantities` push via outbox · C-06 Bosta: deliveries + COD + status mapping, returns → quarantine · C-07 WhatsApp Cloud API notifications.

---

## 2. Owner decisions blocking tickets
| Needed for | Question |
|---|---|
| F-02 / F-03 | Brand accent colour (proposal: deep teal `#0f766e`), app name, logo? |
| D-01 | Default branch policy: consumables "used on receipt", clothes/assets tracked? (recommended yes) |
| D-08 / A-04 | Approval thresholds (e.g. write-off > 500 EGP, variance > 5 %) |
| D-11 | Negative stock: refuse + owner override only in the first month? |
| L-01 | First live client: kindergarten or kids-wear store (decides whether P4 lots or P7 Shopify moves up) |
| O-05 | Label printer: Xprinter XP-365B or Zebra |

## 3. How to start (next 3 actions)
1. Owner answers the F-02 block (10 minutes) → lead runs `/impeccable init`.
2. Lead creates all P0 issues + labels + milestones on GitHub (`to-tickets`).
3. Dispatch in parallel: **F-01** (structure) and **F-06** (CI) and **F-08** (i18n parity) — no shared files; then F-03 → F-04/F-05 → F-07/F-11/F-12; F-09/F-10 after F-01.
