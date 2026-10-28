import { currentUser, type CurrentUser } from '../../auth/current-user.ts';
import type { Queryable } from '../../db/client.ts';
import { findVariantById } from '../../db/items.ts';
import {
  MOVEMENT_HISTORY_LIMIT,
  ON_HAND_LIMIT,
  movementHistoryDetailed,
  onHandByLocation,
  usageByBranch,
  usageTotalEgp,
  type MovementDetail,
  type OnHandRow,
  type UsageRow,
} from '../../db/usage.ts';
import { canApproveOrIssue, canRequest } from '../../domain/requisition-ui.ts';
import { isUuid } from '../../domain/ids.ts';

/**
 * THE STOCK SCREENS' LOGIC, with the request boundary left OUT — the same seam
 * as `src/app/requisitions/handler.ts` and `src/app/intake/handler.ts`.
 *
 *   * every function takes an ALREADY tenant-scoped `db` plus the raw session
 *     cookie, so a test drives it against a real database with no HTTP layer
 *     (`withTenant` is NOT re-entrant, so the scope is opened at the boundary,
 *     never here);
 *   * `src/app/stock/page.tsx` and `[variantId]/page.tsx` read the request's
 *     cookie and open EXACTLY ONE `withTenant` each.
 *
 * THIS MODULE WRITES NOTHING — it is the payoff screen for the ledger, and it is
 * read-only by design.
 *
 * ---- WHO MAY SEE WHAT (decided here, enforced in SQL, proved by a test) -----
 *
 *   * `owner` and `warehouse_manager` see the WHOLE NETWORK — every location's
 *     on-hand, and every movement of any variant.
 *   * `branch_user` sees ONLY THEIR OWN BRANCH's stock and movements. The branch
 *     is resolved from the SESSION (`app_users.branch_location_id`), never from
 *     the request, and it is passed into the QUERY (`locationId`), so another
 *     branch's rows never leave the database — hiding them in the markup would
 *     not be a permission. A branch user with no branch sees nothing.
 *   * Any other role sees nothing.
 *
 * Every list is BOUNDED (see `src/db/usage.ts`) and the handler reports what lies
 * beyond the bound (`truncated`) so the screen can say so instead of silently
 * cutting — the branch request form's unbounded catalogue list was already
 * flagged as the same class of problem.
 */

/** The one place `app.tenant_id` is read for a read, so it is written once. */
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/** Why a stock read was refused — a machine-readable code the page switches on. */
export type StockRefusal = 'unauthenticated' | 'forbidden' | 'invalid';

/** The i18n key for each refusal CODE — the ONE place a code becomes a sentence. */
export const STOCK_REFUSAL_MESSAGE_KEYS: Record<StockRefusal, string> = {
  unauthenticated: 'stock.error.unauthenticated',
  forbidden: 'stock.error.forbidden',
  invalid: 'stock.error.invalid',
};

/** A stock read that was refused, carrying the code the page renders. */
export class StockError extends Error {
  readonly code: StockRefusal;
  constructor(code: StockRefusal, message: string) {
    super(message);
    this.name = 'StockError';
    this.code = code;
  }
}

/** Who is asking and how far they may see. */
export interface StockScope {
  user: CurrentUser;
  role: string;
  /** `network` for the warehouse; `branch` for one branch user. */
  scope: 'network' | 'branch';
  /** The branch location a branch user is confined to, or `null` for the network. */
  branchLocationId: string | null;
  /** The branch's own label ("فرع براعم (BR-01)"), for the screen to state it. */
  branchLabel: string | null;
}

/** One on-hand row as the stock list shows it (quantities are exact strings). */
export interface StockRowView {
  variantId: string;
  sku: string;
  nameAr: string;
  location: string;
  qty: string;
}

/** Everything the stock list needs, read in ONE pass inside the caller's scope. */
export interface StockListResult {
  user: CurrentUser | null;
  role: string | null;
  /** May this viewer see any stock at all? */
  maySee: boolean;
  scope: 'network' | 'branch' | null;
  branchLabel: string | null;
  /** The needle the viewer searched for, echoed back to the form. */
  search: string;
  rows: StockRowView[];
  /** True when more rows exist beyond the bound the screen shows. */
  truncated: boolean;
}

/**
 * Resolves the viewer's scope, or refuses with a CODE.
 *
 * A `branch_user`'s branch is read from `app_users.branch_location_id` (never
 * from the request) and its label from `locations`, so the screen can STATE what
 * the viewer is looking at. A branch user with no branch is refused (`invalid`),
 * exactly as the requisition screens refuse one.
 */
async function resolveScope(db: Queryable, cookie: string | undefined | null): Promise<StockScope> {
  const user = await currentUser(db, cookie);
  if (!user) {
    throw new StockError('unauthenticated', 'Stock: you are not signed in (or the session has ended).');
  }
  if (canApproveOrIssue(user.role)) {
    return { user, role: user.role, scope: 'network', branchLocationId: null, branchLabel: null };
  }
  if (canRequest(user.role)) {
    const { rows } = await db.query<{ branch_location_id: string | null }>(
      `select branch_location_id from app_users where id = $1 and tenant_id = ${TENANT}`,
      [user.userId],
    );
    const branchLocationId = rows[0]?.branch_location_id ?? null;
    if (!branchLocationId) {
      throw new StockError(
        'invalid',
        `Stock: the account "${user.username}" is not assigned to a branch, so it has no stock to show.`,
      );
    }
    const { rows: branch } = await db.query<{ name_ar: string; code: string }>(
      `select name_ar, code from locations where id = $1 and tenant_id = ${TENANT}`,
      [branchLocationId],
    );
    const label = branch[0] ? `${branch[0].name_ar} (${branch[0].code})` : null;
    return { user, role: user.role, scope: 'branch', branchLocationId, branchLabel: label };
  }
  throw new StockError('forbidden', `Stock: role "${user.role}" may not view stock.`);
}

/**
 * The on-hand list, role-scoped to the viewer, searchable by name or SKU, and
 * BOUNDED.
 *
 * NEVER THROWS for a viewer who simply may not see stock: an unauthenticated
 * request and a role with no access both come back as a result with `maySee:
 * false` and no rows (the first with `user: null`), so the page renders the
 * right sentence and no query for stock was issued for them at all.
 */
export async function listStock(
  db: Queryable,
  cookie: string | undefined | null,
  options: { search?: string } = {},
): Promise<StockListResult> {
  const search = typeof options.search === 'string' ? options.search.trim() : '';

  let scope: StockScope;
  try {
    scope = await resolveScope(db, cookie);
  } catch (err) {
    if (err instanceof StockError) {
      const user = err.code === 'unauthenticated' ? null : await currentUser(db, cookie);
      return {
        user,
        role: user?.role ?? null,
        maySee: false,
        scope: null,
        branchLabel: null,
        search,
        rows: [],
        truncated: false,
      };
    }
    throw err;
  }

  // Ask for ONE row more than the bound, so truncation is provable without a
  // second COUNT query: an overflow row means "there is more".
  const fetched = await onHandByLocation(db, {
    locationId: scope.branchLocationId,
    search: search === '' ? null : search,
    limit: ON_HAND_LIMIT + 1,
  });
  const truncated = fetched.length > ON_HAND_LIMIT;
  const rows = truncated ? fetched.slice(0, ON_HAND_LIMIT) : fetched;

  return {
    user: scope.user,
    role: scope.role,
    maySee: true,
    scope: scope.scope,
    branchLabel: scope.branchLabel,
    search,
    rows: rows.map((row: OnHandRow) => ({
      variantId: row.variantId,
      sku: row.sku,
      nameAr: row.nameAr,
      location: row.location,
      qty: row.qty,
    })),
    truncated,
  };
}

/** What the detail read answers: the item and its story, or a refusal CODE. */
export type StockHistoryOutcome =
  | {
      ok: true;
      sku: string;
      nameAr: string;
      /** The variant's balance per visible location. */
      onHand: StockRowView[];
      /** The variant's movements, newest first and bounded. */
      movements: MovementDetail[];
      /** True when more movements exist beyond the bound shown. */
      truncated: boolean;
      branchLabel: string | null;
    }
  | { ok: false; error: StockRefusal };

/**
 * ONE VARIANT'S STORY — its on-hand per location and its FULL movement history,
 * newest first, role-scoped.
 *
 * A variant the viewer may not see (another tenant's, missing, deactivated) and
 * one that is real but outside a branch viewer's branch are answered with the
 * SAME code (`invalid`), so the response is not an existence oracle for stock a
 * branch user is not entitled to.
 */
export async function getVariantHistory(
  db: Queryable,
  cookie: string | undefined | null,
  variantId: string,
): Promise<StockHistoryOutcome> {
  // A malformed id (a stale or hand-edited link, `not-a-uuid`) gets the SAME
  // graceful refusal a missing one does — checked by SHAPE before any query, so
  // an uncastable text id can never reach Postgres and 500 the page.
  if (!isUuid(variantId)) {
    return { ok: false, error: 'invalid' };
  }

  let scope: StockScope;
  try {
    scope = await resolveScope(db, cookie);
  } catch (err) {
    if (err instanceof StockError) return { ok: false, error: err.code };
    throw err;
  }

  const found = await findVariantById(db, variantId);
  if (!found) return { ok: false, error: 'invalid' };

  const onHandRows = await onHandByLocation(db, {
    variantId,
    locationId: scope.branchLocationId,
    limit: ON_HAND_LIMIT,
  });

  // A branch viewer may look at a variant only if their branch holds it — the
  // same "not yours to open" answer as an unknown id, so this cannot probe the
  // network's stock one variant at a time.
  if (scope.scope === 'branch' && onHandRows.length === 0) {
    return { ok: false, error: 'invalid' };
  }

  const fetched = await movementHistoryDetailed(db, variantId, MOVEMENT_HISTORY_LIMIT + 1);
  const truncated = fetched.length > MOVEMENT_HISTORY_LIMIT;
  const movements = truncated ? fetched.slice(0, MOVEMENT_HISTORY_LIMIT) : fetched;

  return {
    ok: true,
    sku: found.variant.sku,
    nameAr: found.itemNameAr,
    onHand: onHandRows.map((row) => ({
      variantId: row.variantId,
      sku: row.sku,
      nameAr: row.nameAr,
      location: row.location,
      qty: row.qty,
    })),
    movements,
    truncated,
    branchLabel: scope.branchLabel,
  };
}

// ---------------------------------------------------------------------------
// THE ACCOUNTS VIEW — usage and value by branch (financials role).
// ---------------------------------------------------------------------------

/** Two zero-padded digits, for building a `YYYY-MM-DD` string. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The DEFAULT window: THIS MONTH — from the 1st (inclusive) to the 1st of next
 * month (exclusive), in UTC, as `YYYY-MM-DD`. A half-open month-to-month window
 * so two adjacent months never double-count a movement on the boundary instant,
 * matching {@link usageByBranch}'s contract.
 *
 * The choice is stated on the screen, and the page makes it EXPLICIT in the URL
 * (it redirects to `?from=…&to=…`), so a report can be shared or bookmarked and
 * a later reader sees exactly which window produced the figure.
 */
export function monthWindow(now: Date = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const from = `${y}-${pad2(m + 1)}-01`;
  const next = new Date(Date.UTC(y, m + 1, 1));
  const to = `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-01`;
  return { from, to };
}

/** Is `[from, to)` a well-formed, non-empty window? */
export function isValidWindow(from: string, to: string): boolean {
  const f = Date.parse(from);
  const t = Date.parse(to);
  return Number.isFinite(f) && Number.isFinite(t) && f < t;
}

/** The window the accounts view runs for; `from`/`to` come from the URL. */
export interface UsageWindow {
  from?: string | null;
  to?: string | null;
}

/** A successful read: the rows, the exact SQL total and the window echoed back. */
export interface UsageReport {
  ok: true;
  /** Always the network — money across branches is not a branch-level fact. */
  scope: 'network';
  /** The window actually run, echoed so the screen states it. */
  from: string;
  to: string;
  rows: UsageRow[];
  /** The TOTAL, an exact `numeric(12,2)` STRING computed in SQL. */
  totalEgp: string;
  /** True when more rows exist beyond the bound the screen shows. */
  truncated: boolean;
}

/** What the accounts read answers: the report, or a refusal CODE. */
export type UsageReportOutcome = UsageReport | { ok: false; error: StockRefusal };

/**
 * USAGE AND VALUE BY BRANCH, for a date window — the financials surface.
 *
 * ROLE: only `owner` and `warehouse_manager` may read it, because it is a
 * WHOLE-NETWORK money figure and money across the network is not a branch-level
 * fact. A `branch_user` is refused SERVER-SIDE (`forbidden`) — there is no
 * scoped variant for them here: a branch's own consumption value is a different
 * question, and answering it with the network total would be a leak. Any other
 * role is refused too, and an unauthenticated request is refused.
 *
 * MONEY: `totalEgp` and every row's `valueEgp` are exact numeric STRINGS
 * computed in SQL (`sum(qty * cost_egp)::numeric(12,2)`); nothing here sums
 * money in JavaScript. The screen formats the string; it never does maths on it.
 *
 * The window defaults to THIS MONTH ({@link monthWindow}) when the caller omits
 * it, and a malformed window is refused as `invalid`. The list is BOUNDED
 * ({@link ON_HAND_LIMIT}) and `truncated` says when there is more.
 */
export async function getUsageReport(
  db: Queryable,
  cookie: string | undefined | null,
  window: UsageWindow = {},
): Promise<UsageReportOutcome> {
  const user = await currentUser(db, cookie);
  if (!user) {
    return { ok: false, error: 'unauthenticated' };
  }
  // A branch user — and any role that is neither owner nor warehouse_manager —
  // is refused before any money is read.
  if (!canApproveOrIssue(user.role)) {
    return { ok: false, error: 'forbidden' };
  }

  const fallback = monthWindow();
  const from = (window.from ?? '').trim() || fallback.from;
  const to = (window.to ?? '').trim() || fallback.to;
  if (!isValidWindow(from, to)) {
    return { ok: false, error: 'invalid' };
  }

  // Ask for ONE row more than the bound, so truncation is provable without a
  // second COUNT query (the same trick the stock list uses).
  const fetched = await usageByBranch(db, { from, to, limit: ON_HAND_LIMIT + 1 });
  const truncated = fetched.length > ON_HAND_LIMIT;
  const rows = truncated ? fetched.slice(0, ON_HAND_LIMIT) : fetched;
  const totalEgp = await usageTotalEgp(db, { from, to });

  return { ok: true, scope: 'network', from, to, rows, totalEgp, truncated };
}
