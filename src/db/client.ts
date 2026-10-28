import { AsyncLocalStorage } from 'node:async_hooks';

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
 * otherwise `APP_DATABASE_URL` — the app's OWN variable, the non-owner role the
 * app serves as. It deliberately does NOT fall back to `DATABASE_URL` /
 * `MIGRATE_DATABASE_URL`: those are the migration OWNER role, and a table owner
 * (or any superuser / `BYPASSRLS` role) bypasses RLS, so a fallback to it would
 * silently serve the app with every tenant protection switched off. Callers that
 * need another role (tests, the migration runner) pass an explicit `url`.
 */
function resolveUrl(url?: string): string {
  const resolved = url ?? process.env.APP_DATABASE_URL;
  if (!resolved) {
    throw new Error(
      'newPool: no connection string — pass a url or set APP_DATABASE_URL',
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

/**
 * Narrowing helper: is this a source that can hand out a *separately releasable*
 * connection (a pool), or a single connection itself?
 *
 * Deliberately structural, not `instanceof Pool`. `instanceof` is defeated by a
 * pool-like wrapper (a Proxy, a decorator) or by a second copy of the `pg`
 * module, both of which would silently fall into the single-connection branch:
 * no `connect()`, no `release()`, and `BEGIN` plus the transaction-local
 * `set_config` landing on whichever backend each statement happens to get.
 *
 * A pool is recognised by a `connect` method **plus** either a `release` hook or
 * the pool counters (`totalCount`). A bare `pg.Client` exposes `connect` but
 * neither — and a plain `{ query }` stub exposes no `connect` at all — so both
 * correctly take the single-connection branch.
 */
function isPool(source: Pool | Queryable): source is Pool {
  const s = source as unknown as Record<string, unknown>;
  if (typeof s.connect !== 'function') return false;
  return typeof s.release === 'function' || typeof s.totalCount === 'number';
}

/**
 * Marks the dynamic extent of a {@link withTenant} call so a nested call can be
 * refused before it issues `BEGIN`. See the contract note on `withTenant`.
 */
const inWithTenant = new AsyncLocalStorage<true>();

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
 * The connection is injected: pass a pool-like source (a `Pool`, or any object
 * with `connect`/`release` — detected *structurally*, not via `instanceof`), a
 * single `Client`, or a stub. The pool is never constructed here, so tests can
 * substitute a fake.
 *
 * **Not re-entrant.** `withTenant` is deliberately NOT re-entrant and must not
 * be called from inside its own `fn`. Postgres does not nest `BEGIN`: a second
 * `BEGIN` on the same connection only emits
 * `WARNING: there is already a transaction in progress`, and the inner `COMMIT`
 * then commits the *outer* transaction — so a later rollback silently fails to
 * undo the "inner" work. To make that impossible rather than merely
 * discouraged, a nested call is refused *before* `BEGIN` with the named error
 * `withTenant: already inside a transaction`, leaving the already-open
 * transaction untouched. A defensive
 * `pg_current_xact_id_if_assigned()` check catches the case where the
 * connection was handed to us already mid-transaction.
 */
export async function withTenant<T>(
  source: Pool | Queryable,
  tenantId: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  if (inWithTenant.getStore()) {
    throw new Error('withTenant: already inside a transaction');
  }
  return inWithTenant.run(true, () => runWithTenant(source, tenantId, fn));
}

async function runWithTenant<T>(
  source: Pool | Queryable,
  tenantId: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const pooled = isPool(source);
  const client = pooled
    ? ((await (source as Pool).connect()) as unknown as PoolClient)
    : undefined;
  const db: Queryable = client ?? (source as Queryable);

  let failure: Error | undefined;
  try {
    // Defensive: never issue BEGIN onto a connection that already has a
    // transaction open. If one is open, its commit/rollback is not ours to
    // control — refuse rather than corrupt it.
    const { rows } = await db.query<{ xid: string | null }>(
      'select pg_current_xact_id_if_assigned() as xid',
    );
    if (rows[0]?.xid != null) {
      throw new Error('withTenant: already inside a transaction');
    }

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
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    // Pass the error on the throw path so a broken connection is destroyed
    // rather than returned to the pool as healthy.
    if (client) client.release(failure);
  }
}
