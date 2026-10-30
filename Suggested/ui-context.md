# UI Context

## Design principles
1. **Phone first.** Design at 375px. Widen for tablet/desktop, never shrink.
2. **Arabic first.** RTL is the default. LTR is the exception (codes, numbers, barcodes).
3. **Flat and fast.** No shadows, no gradients, no animations on data. 1px borders, 0.5rem radius.
4. **44px minimum tap target.** Every interactive element, no exceptions.
5. **Permission-aware.** Hide, not just disable — controls the user has no permission for never render.

---

## Design tokens

| Token | Value | Usage |
|---|---|---|
| `--color-primary` | `#0f766e` (deep teal) | Buttons, active states, links |
| `--color-surface` | `#ffffff` | Card/page background |
| `--color-border` | `#e5e7eb` | All 1px borders |
| `--color-text` | `#111827` | Body copy |
| `--color-muted` | `#6b7280` | Labels, secondary text |
| `--color-ok` | green | Status: confirmed, in stock, approved |
| `--color-wait` | yellow | Status: pending, low stock, draft |
| `--color-bad` | red | Status: rejected, out of stock, error |
| `--color-transit` | blue | Status: in transit, dispatched |
| `--color-idle` | gray | Status: cancelled, inactive |

Font: **IBM Plex Sans Arabic** (Arabic + Latin), **IBM Plex Mono** (codes/doc numbers).

---

## Layout system

### Shell
```
┌─────────────────────────────┐
│  TopBar (56px)               │  ← breadcrumb, language, user menu
├─────────────────────────────┤
│  Sidebar (240px, collapsible)│
│  +  Page content             │
│     PageHeader               │
│     FilterBar                │
│     Body                     │
└─────────────────────────────┘
```
On mobile (< 640px): sidebar becomes a bottom sheet triggered by TopBar icon.

### Page anatomy
```tsx
<PageHeader title="الطلبات" description="..." actions={<Button>طلب جديد</Button>} />
<FilterBar>...</FilterBar>
<ActiveFilterChips />         {/* dismissible chips for active filters */}
<DataTable ... />             {/* or card list on mobile */}
<Pagination />
```

---

## FilterBar — standard on every list screen

Every list screen must include a `FilterBar` with the relevant subset of:

| Control | Component | Applies to |
|---|---|---|
| Text search | `SearchInput` | Name, doc number, SKU, branch name |
| Status | `StatusMultiSelect` | Multi-select badge picker |
| Date range | `DateRangePicker` | Created at, issued at, confirmed at |
| Branch | `BranchSelect` | Dropdown of all branches (hidden for branch role — fixed to own) |
| Item / category | `ItemSelect` / `CategorySelect` | Dropdown or barcode scan |
| Created by | `UserSelect` | Owner and manager screens only |
| Sort | Column header click | asc / desc toggle |

Rules:
- Active filters appear as dismissible `FilterChip` components above the table.
- A "Clear all" link removes all filters at once.
- Filter state lives in URL query params — page is shareable and bookmarkable.
- On mobile, filters collapse behind a "Filters" button that opens a bottom sheet.
- Empty state when filters return no results must show which filter is active and offer "Clear".

---

## Shared components (already built)

| Component | Use for |
|---|---|
| `AppSidebar` | Navigation — permission-filtered |
| `TopBar` | Breadcrumb, language switch, sign-out |
| `PageHeader` | Every page — title + optional action button |
| `DataTable` | Any list with sort, pagination, column visibility; auto switches to cards < 640px |
| `StatusBadge` | Any document/line status — maps to color tokens |
| `FilterBar` | Wrap filter inputs |
| `KpiCard` | Dashboard metric tiles |
| `QtyStepper` | Quantity input with +/- buttons |
| `EmptyState` | Empty list placeholder |
| `ConfirmDialog` | Destructive or irreversible actions |
| `DocNumber` | Styled display for document numbers |
| `Money / Qty / DateTime` | Formatted value display |

---

## Components to build (Plan 1)

| Component | Where used | Notes |
|---|---|---|
| `BarcodeScanner` | Intake, counts, item picker | Camera-based, fallback to text input |
| `ItemPicker` | Requisitions, intake, returns | Searchable by name/SKU/barcode, shows on-hand and unit cost |
| `FormField` | Every form | Label + input + error message, RTL-safe |
| `Toast` | All mutations | Success/error, 3s auto-dismiss |
| `Skeleton` | Any loading state | Matches the layout it's loading |
| `ErrorState` | Failed fetches | With retry button |
| `FileUpload` | Import screen | Drag + drop + file picker |
| `DateRangePicker` | Reports, filters | Arabic calendar, presets: today / this week / this month / custom |
| `Timeline` | Document detail | Status changes with user + time |
| `PhotoUpload` | Variance, scrap | Camera + file, thumbnail preview |
| `SearchInput` | FilterBar | Debounced, clears on ✕ |
| `StatusMultiSelect` | FilterBar | Badge-style multi-select |
| `BranchSelect` | FilterBar | Dropdown, hidden on branch-role screens |
| `FilterChip` | Active filters row | Dismissible, "Clear all" link |
| `MoneyDisplay` | Any cost/spend value | Integer piastres → formatted EGP |
| `PermissionGate` | Any conditional UI | Renders children only if user has the permission key |

---

## Screen patterns

### List screen
```
PageHeader (title + New button, guarded by permission)
FilterBar (search + status + date range + branch + sort)
ActiveFilterChips
DataTable or CardList (with cost column where relevant)
Pagination
```

### Detail screen
```
PageHeader (doc number + status badge + action buttons, each guarded)
Summary section (who, when, branch, total cost)
Lines table (item, qty, unit cost, line total, status per line)
Timeline (status history — user + timestamp + action)
Action bar (approve / issue / confirm / cancel — permission-gated)
```

### Form screen (new document)
```
PageHeader (back button + title)
Form sections (use FormField for every input)
Item lines: ItemPicker + QtyStepper + unit cost display + line total
Grand total display (auto-calculated)
Bottom action bar (cancel + submit) — sticky on mobile
```

### Dashboard
```
KpiCard row (key numbers for the role / permissions)
Spending KpiCards (this month spend, branch totals — shown if reports:cost permission)
Alert section (below min, pending approvals)
Quick action buttons
```

### Reports screen
```
PageHeader (report title + Export button)
FilterBar (date range + branch + item/category)
Summary numbers (total spend, total qty)
Table (sortable, paginated)
Export: Excel / PDF
```

### Role management screen (owner only)
```
PageHeader ("الصلاحيات والأدوار") + New Role button
Roles list (name, user count, system badge)
Role detail panel:
  — Role name (editable)
  — Permissions grouped by module (toggle per permission key)
  — Save button
  — Delete button (disabled on system roles)
Users table (assign role per user)
```

---

## Mobile-specific rules

- Action buttons fixed to bottom of screen (`position: sticky bottom-0`).
- No hover-only interactions. Everything works on touch.
- Lists are card-based below 640px — no horizontal scroll on tables.
- Barcode scanner opens full-screen, tap outside to dismiss.
- Forms scroll naturally — no fixed inner scroll containers on mobile.
- Filters collapse into a bottom sheet on mobile — not an inline row.
- Bottom navigation (if added) accounts for iOS safe area: `pb-safe` or `env(safe-area-inset-bottom)`.
- Cost/spend columns collapse last on narrow screens (qty more important than cost for branch role).

---

## RTL rules (must follow everywhere)

Use Tailwind logical properties — never directional:

| ❌ Don't use | ✅ Use instead |
|---|---|
| `ml-*`, `mr-*` | `ms-*`, `me-*` |
| `pl-*`, `pr-*` | `ps-*`, `pe-*` |
| `text-left` | `text-start` |
| `text-right` | `text-end` |
| `left-0` | `start-0` |
| `right-0` | `end-0` |
| `border-l` | `border-s` |

Codes, SKUs, doc numbers, barcodes, and EGP amounts wrap in `<span className="ltr-value">` which applies `direction: ltr; unicode-bidi: embed`.

---

## Status badge mapping

| Status value | Color token | Arabic label | English label |
|---|---|---|---|
| `draft` | idle | مسودة | Draft |
| `submitted` | wait | مقدم | Submitted |
| `approved` | wait | موافق عليه | Approved |
| `issued` | transit | صادر | Issued |
| `in_transit` | transit | في الطريق | In Transit |
| `confirmed` | ok | مؤكد | Confirmed |
| `cancelled` | bad | ملغي | Cancelled |
| `rejected` | bad | مرفوض | Rejected |
| `partial` | wait | جزئي | Partial |
| `completed` | ok | مكتمل | Completed |

---

## i18n conventions

- Namespaced keys: `module.object.action` — e.g. `requisitions.status.approved`
- Plural forms for Arabic: use `_zero`, `_one`, `_two`, `_few`, `_many`, `_other`
- Dynamic values: `t('stock.below_min', { count: 3 })` — never concatenate strings
- Date format: `DD/MM/YYYY` for Arabic, same for English in this app (Egyptian convention)
- Numbers: Latin digits (`0–9`) even in Arabic mode
- Currency: `١٬٢٥٠٫٠٠ ج.م` (formatted, LTR in ltr-value span)
