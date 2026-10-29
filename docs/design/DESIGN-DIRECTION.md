# Design Direction — proposal for `DESIGN.md`

> Status: **proposal, 2026-10-28.** Ticket `F-02` turns this into the root
> `PRODUCT.md` + `DESIGN.md` by running Impeccable (`/impeccable init`, then
> `/impeccable document`). After that, `DESIGN.md` is the single source of truth
> for how the app looks; this file becomes history.

## 1. What we are designing
An **operations tool** (Impeccable mode: *Operate*) used all day by a warehouse
manager at a desk with a scanner, by branch staff on cheap Android phones, and
by an owner who checks numbers. Arabic first, English equal. Precision and
calm beat flair: ambition shows as clarity, speed and zero ambiguity about a
number.

## 2. References and what we take from each
| Reference | Take | Leave |
|---|---|---|
| **FastAPI full-stack template** (the owner's pick) — shadcn/ui + Tailwind, light sidebar, page title + subtitle on the start side, one primary button on the end side, bordered rounded table with small uppercase headers, row ⋮ menu, appearance toggle + user menu at the sidebar bottom, dark mode | **The whole app frame and list-page pattern** | Teal brand colour (we choose our own), UUIDs shown to users |
| **Cal.com** DESIGN.md (awesome-design-md) — white canvas, near-black primary buttons `#111111`, grey ladder `#374151 / #6b7280 / #e5e7eb`, 8–12 px radii, semantic `#10b981 / #f59e0b / #ef4444` | Neutral palette, radii, spacing scale (4/8/12/16/24/32/48) | Marketing display type |
| **Linear** DESIGN.md — single scarce accent, hairline borders, dense but calm tables, status badges as small pills | Accent discipline, density, status pills, keyboard-friendliness | Near-black canvas as default |
| **Supabase / Vercel** DESIGN.md | Technical clarity for codes/SKUs in mono | Dark-first |

## 3. Tokens (proposal — map onto shadcn CSS variables in `src/app/globals.css`)
- **Neutrals (light):** background `#ffffff`, sidebar `#fafafa`, muted surface `#f5f5f5`, border `#e5e7eb`, text `#111111`, secondary text `#4b5563`, tertiary `#6b7280`.
- **Neutrals (dark):** background `#0b0b0c`, surface `#141416`, border `#26272b`, text `#f4f4f5`, secondary `#a1a1aa`.
- **Primary (actions):** near-black `#111111` (light) / white (dark) — Cal.com style.
- **Brand accent (scarce: logo, focus ring, active nav item, links):** deep teal-green **`#0f766e`** — warehouse/"in stock" feeling, distinct from the status green. *Owner may swap in one word.*
- **Status (fixed meaning everywhere, never decorative):**
  `ok/posted #10b981` · `waiting/partial #f59e0b` · `short/expired/negative #ef4444` · `in transit #3b82f6` · `draft/closed #6b7280`.
- **Radius:** 8 px controls, 12 px cards/tables, pill for badges.
- **Spacing:** 4-pt scale; page padding 24 px desktop / 16 px phone.
- **Type:** **IBM Plex Sans Arabic** for both scripts (one family, good Latin + Arabic, free) — replace the Geist default the shadcn init added; **Geist Mono / IBM Plex Mono** for SKUs, barcodes, document numbers, quantities in tables (tabular numerals).
  Scale: page title 24/600, section 18/600, body 14–16/400, caption 12–13/500, table header 12/500 uppercase (Latin only — Arabic has no case, use 600 weight instead).
- **Numerals:** Latin digits always (existing rule), `font-variant-numeric: tabular-nums` in tables.
- **Touch:** ≥ 44 px targets on phone; quantity steppers 48 px.
- **Motion:** 150–200 ms ease-out for drawers/menus only; no bounce.

## 4. The app frame (from the FastAPI template, adapted)
```
Desktop (LTR shown; Arabic mirrors — sidebar on the right)
┌───────────────┬──────────────────────────────────────────────────────────┐
│ ▣ Warehouse   │ [≡]  Breadcrumb / Page          [🔍 Scan or search  ⌘K] 🔔│
│               ├──────────────────────────────────────────────────────────┤
│ ⌂ Dashboard   │  Items                                     [+ Add item]  │
│ ▦ Stock       │  Everything we stock, by family and category             │
│ ⇩ Receiving   │  [Search…] [Family ▾] [Category ▾] [Active ▾]   ⤓ Export │
│ ⇄ Requests  3 │  ┌────────────────────────────────────────────────────┐  │
│ ↔ Transfers   │  │ CODE      NAME            FAMILY   ON HAND  STATUS ⋮│  │
│ ↺ Returns     │  │ RIC-0001  أرز مصري        Consum.  150.5    ● OK   ⋮│  │
│ ☑ Counts      │  │ PRJ-0001  جهاز عرض        Asset    2        ● Low  ⋮│  │
│ ◫ Items       │  └────────────────────────────────────────────────────┘  │
│ ▤ Reports     │                                    ‹ 1 2 3 ›             │
│ ─────────     │                                                          │
│ ⚙ Settings    │                                                          │
│ ◐ Appearance  │                                                          │
│ (A) owner  ⌄  │  footer: version · tenant name                           │
└───────────────┴──────────────────────────────────────────────────────────┘
Phone (branch user): top bar + bottom tab bar
  [ Home ] [ Request ] [ Receive ] [ Use ] [ Count ]
```
- shadcn `Sidebar` (collapsible to icons), `Breadcrumb`, `Command` (⌘K / scan box), `DropdownMenu` (user menu), `Sheet` (mobile nav, detail drawers), `Sonner` (toasts).
- RTL: `components.json` has `"rtl": true` (the CLI writes logical classes); wrap the tree in shadcn `DirectionProvider` with the request's direction; pass `dir` to portals (known `tw-animate-css` issue).

## 5. Page templates (every screen is one of these five)
1. **List page** — header (title, subtitle, primary action) · filter bar · data table (sortable, sticky header; becomes cards < 640 px) · pagination · empty state with the next action.
2. **Detail page** — header with document number + status badge + actions · summary cards · tabs (Lines · History · Attachments · Change log).
3. **Form page / drawer** — `Field` components, inline validation, sticky footer with Cancel / Save; long forms split into steps.
4. **Scan workflow** — big scan field always focused, running list of scanned lines with steppers, counter "12 lines · 340 units", one big confirm button; sounds on good/bad scan. Used by receiving, picking, confirming, counting, usage.
5. **Dashboard** — KPI tiles (value + trend vs last month + link), "needs your action" list, small charts (shadcn `Chart`/Recharts).

## 6. Component inventory (build once in `src/modules/shell/ui/` on top of shadcn)
`AppSidebar`, `TopBar`, `GlobalScan` (Command palette), `PageHeader`, `DataTable` (TanStack Table + shadcn Table), `FilterBar`, `StatusBadge` (maps document/line status → token), `KpiCard`, `QtyStepper`, `ScanField` (existing, restyled), `ItemPicker`, `LocationPicker`, `DocNumber` (mono, copy button), `EmptyState` (shadcn Empty), `ConfirmDialog` (AlertDialog, required reason input), `PrintButton`, `ExportButton`, `Money`, `Qty`, `DateTime` (wrapping the existing Latin-digit formatters).

## 7. Impeccable workflow for every screen
1. `/impeccable shape <screen>` before building a new screen (writes the surface brief).
2. Build with the templates above.
3. `/impeccable critique <screen>` → fix → `/impeccable audit <screen>` (a11y, responsive) → `/impeccable harden <screen>` (errors, empty/loading, long Arabic names, offline) → `/impeccable polish <screen>`.
4. CI runs `npx impeccable detect` on the built pages (ticket `F-06`); exit code 2 fails the job.

## 8. Do / Don't (project-specific)
- **Do** show human document numbers (`REQ-2026-0042`), never UUIDs.
- **Do** colour only status. Everything else neutral.
- **Do** put codes/SKUs/barcodes in `.ltr-value` + mono, even inside Arabic text.
- **Don't** nest cards in cards; don't use gradients; don't use grey text on coloured backgrounds; don't use Inter/system default.
- **Don't** hide the number that matters: on-hand, expected vs received, variance are always the largest text on their row/card.
