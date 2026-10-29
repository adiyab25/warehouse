import type { Queryable } from '@/modules/platform/index';
import {
  DEFAULT_RATE_DAYS,
  REPLENISHMENT_LIMIT,
  belowMinimum,
  type BelowMinimumRow,
} from '@/modules/reports/index';
import { StockError, resolveScope } from '../stock/handler.ts';

/**
 * THE REPLENISHMENT SCREEN'S LOGIC, request boundary left OUT (same seam as
 * `src/app/stock/handler.ts`): it takes an ALREADY tenant-scoped `db` plus the raw
 * session cookie; `src/app/reports/page.tsx` opens EXACTLY ONE `withTenant`.
 * READ-ONLY.
 *
 * WHO MAY SEE WHAT — decided from the SESSION, never the request:
 *   * `owner` / `warehouse_manager`: every branch (and the warehouse's own levels).
 *   * `branch_user`: ONLY their own branch (`app_users.branch_location_id`), passed
 *     INTO THE QUERY as `locationId`, so another branch's rows never leave the
 *     database. A branch user with no branch is REFUSED (`invalid`), not shown the
 *     network. Other roles are refused (`forbidden`).
 *
 * The scope rules are the stock screens' own (`resolveScope`), reused rather than
 * copied so the two screens cannot drift apart.
 */

export type ReportRefusal = 'unauthenticated' | 'forbidden' | 'invalid';

/** The i18n key for each refusal CODE — each code has its OWN sentence. */
export const REPORT_REFUSAL_MESSAGE_KEYS: Record<ReportRefusal, string> = {
  unauthenticated: 'reports.error.unauthenticated',
  forbidden: 'reports.error.forbidden',
  invalid: 'reports.error.invalid',
};

/** One location's table: its rows are lowest cover first. */
export interface ReplenishmentGroup {
  locationId: string;
  location: string;
  rows: BelowMinimumRow[];
}

export type ReplenishmentOutcome =
  | {
      ok: true;
      scope: 'network' | 'branch';
      branchLabel: string | null;
      days: number;
      /** One table per location, ordered by each location's most urgent row. */
      groups: ReplenishmentGroup[];
      /** True when more rows exist beyond the bound shown. */
      truncated: boolean;
      limit: number;
    }
  | { ok: false; error: ReportRefusal };

// NOTE: if a `days` URL parameter is ever added it MUST be validated into a coded 'invalid' refusal before reaching this function (assertDays throws a plain Error).
export async function getReplenishmentReport(
  db: Queryable,
  cookie: string | undefined | null,
  options: { limit?: number; days?: number } = {},
): Promise<ReplenishmentOutcome> {
  let scope;
  try {
    scope = await resolveScope(db, cookie);
  } catch (err) {
    if (err instanceof StockError) return { ok: false, error: err.code };
    throw err;
  }

  const limit = options.limit ?? REPLENISHMENT_LIMIT;
  const days = options.days ?? DEFAULT_RATE_DAYS;
  // One row past the bound, so truncation is provable without a COUNT.
  const fetched = await belowMinimum(db, { locationId: scope.branchLocationId, days, limit: limit + 1 });
  const truncated = fetched.length > limit;
  const rows = truncated ? fetched.slice(0, limit) : fetched;

  // The query's order is global lowest-cover-first; grouping by first appearance
  // keeps that order inside each table and ranks tables by their most urgent row.
  const byLocation = new Map<string, ReplenishmentGroup>();
  for (const row of rows) {
    let g = byLocation.get(row.locationId);
    if (!g) {
      g = { locationId: row.locationId, location: row.location, rows: [] };
      byLocation.set(row.locationId, g);
    }
    g.rows.push(row);
  }

  return {
    ok: true,
    scope: scope.scope,
    branchLabel: scope.branchLabel,
    days,
    groups: [...byLocation.values()],
    truncated,
    limit,
  };
}
