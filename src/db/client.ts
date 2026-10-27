import { Pool, type PoolClient } from 'pg';

/**
 * Anything that can run a parameterised query — a `Pool`, a `Client` or a test
 * stub. Kept structurally identical to `tests/harness/sql.ts::Queryable` so the
 * two are interchangeable.
 */
export type Queryable = {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
};

/**
 * Resolves the connection string for {@link newPool}. An explicit `url` wins;
 * otherwise `DATABASE_URL` (which, in production, is the *non-owner* role the
 * app runs as — a superuser would bypass RLS), then `SQL_TEST_DATABASE_URL`.
 */
function resolveUrl(url?: string): string {
  const resolved =
    url ?? process.env.DATABASE_URL ?? process.env.SQL_TEST_DATABASE_URL;
  if (!resolved) {
    throw new Error(
      'newPool: no connection string — pass a url or set DATABASE_URL',
    );
  }
  return resolved;
}

/**
 * Creates a connection pool for the app. Routes hold one pool for the process
 * and hand it to {@link withTenant} per request.
 */
export function newPool(url?: string): Pool {
  return new Pool({
    connectionString: resolveUrl(url),
    application_name: 'warehouse-app',
  });
}

/** Narrowing helper: is this a pool of many connections, or one connection? */
function isPool(source: Pool | Queryable): source is Pool {
  return source instanceof Pool;
}

/**
 * Runs `fn` on a single connection with the current tenant pinned, inside one
 * transaction.
 *
 * The tenant is set with `select set_config('app.tenant_id', $1, true)` — the
 * `true` makes it transaction-local. `SET LOCAL app.tenant_id = $1` cannot take
 * a parameter and would error; never write it. Because the setting is local to
 * the transaction, every query `fn` issues through `db` must ride the *same*
 * connection — which is why this checks out one connection and never uses
 * bare `pool.query`.
 *
 * The connection is injected: pass a `Pool` (one is checked out and released),
 * a single `Client`, or a stub. The pool is never constructed here, so tests
 * can substitute a fake.
 */
export async function withTenant<T>(
  source: Pool | Queryable,
  tenantId: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const pooled = isPool(source);
  const db: Queryable = pooled
    ? ((await (source as Pool).connect()) as unknown as PoolClient as Queryable)
    : (source as Queryable);

  try {
    await db.query('begin');
    try {
      await db.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(db);
      await db.query('commit');
      return result;
    } catch (err) {
      await db.query('rollback').catch(() => {});
      throw err;
    }
  } finally {
    if (pooled) (db as unknown as PoolClient).release();
  }
}
