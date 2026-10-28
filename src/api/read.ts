import { getAppPool } from '../db/app-pool.ts';
import { withTenant, type Queryable } from '../db/client.ts';
import { requireScope } from './auth.ts';
import { ApiError, errorResponse, jsonResponse } from './errors.ts';

/**
 * THE ONE SHARED PATH for every read route: auth → `read` scope → ONE
 * `withTenant` (tenant from the TOKEN) → reader → error mapping. A route is a
 * thin adapter that supplies `(db, url) => body`; it cannot forget a check.
 *
 * SERVER-ONLY (reaches `pg`). Nothing here inserts or updates (the one write on
 * the request path is `authenticateClient`'s `last_used_at` stamp).
 *
 * Quantities (`numeric(12,3)`) and any money (`numeric(12,2)`) are returned as
 * DECIMAL STRINGS exactly as Postgres prints them; consumers must treat them as
 * decimal strings, never floats.
 */
export type ReadRunner = (db: Queryable, url: URL) => Promise<unknown>;

const ALLOW = 'GET, HEAD, OPTIONS';

export function readRoute(run: ReadRunner) {
  async function GET(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const { tenantId } = await requireScope(req, 'read');
      const pool = await getAppPool();
      const body = await withTenant(pool, tenantId, (db) => run(db, url));
      return jsonResponse(body);
    } catch (e) {
      return errorResponse(e);
    }
  }
  async function HEAD(req: Request): Promise<Response> {
    const res = await GET(req);
    return new Response(null, { status: res.status, headers: res.headers });
  }
  async function OPTIONS(): Promise<Response> {
    return new Response(null, { status: 204, headers: { allow: ALLOW, 'cache-control': 'no-store' } });
  }
  const notAllowed = async (_req?: Request): Promise<Response> =>
    errorResponse(new ApiError(405, 'method_not_allowed', 'Method not allowed', { allow: ALLOW }));
  return { GET, HEAD, OPTIONS, POST: notAllowed, PUT: notAllowed, PATCH: notAllowed, DELETE: notAllowed };
}
