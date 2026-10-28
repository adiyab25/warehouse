import type { Pool } from 'pg';

import { newPool } from './client.ts';

/**
 * The application's ONE connection pool.
 *
 * One pool per process, created LAZILY on first use rather than at module load:
 * importing a route (or a page) must not require `DATABASE_URL` to be set, or
 * `next build` — which imports every module to render the static shell — would
 * fail on a machine that has no database. Every request boundary takes the same
 * pool and hands it to `withTenant`, which checks out (and releases) one
 * connection per request. The url itself is resolved by {@link newPool}
 * (`DATABASE_URL`, then `SQL_TEST_DATABASE_URL`).
 */

let pool: Pool | undefined;

/** The process-wide pool, created on first call. */
export function getAppPool(): Pool {
  pool ??= newPool();
  return pool;
}
