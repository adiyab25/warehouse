import type { Pool } from 'pg';

import { newPool, type Queryable } from './client.ts';

/**
 * The application's ONE connection pool.
 *
 * One pool per process, created LAZILY on first use rather than at module load:
 * importing a route (or a page) must not require `APP_DATABASE_URL` to be set,
 * or `next build` — which imports every module to render the static shell —
 * would fail on a machine that has no database. Every request boundary takes the
 * same pool and hands it to `withTenant`, which checks out (and releases) one
 * connection per request.
 *
 * THE APP HAS ITS OWN VARIABLE, AND ONLY ITS OWN. The connection string is
 * `APP_DATABASE_URL` — the NON-owner app role — and NOT `DATABASE_URL` /
 * `MIGRATE_DATABASE_URL`, which are the OWNER role the migration runner connects
 * as. Those are deliberately different roles: whoever creates a table owns it,
 * and a table's OWNER (or any superuser / `BYPASSRLS` role) bypasses that table's
 * own RLS policies — so serving the app as the owner would silently switch OFF
 * every tenant protection, and every test would still pass because tests connect
 * with `SQL_TEST_DATABASE_URL`. There is deliberately NO fallback to the owner
 * variable: a fallback is exactly how a deployment ends up silently served with
 * RLS off.
 *
 * THE ROLE IS ASSERTED AT BOOT. Before the pool serves a single request,
 * {@link assertServingRole} reads the resolved role and REFUSES a superuser or a
 * role with `rolbypassrls` — the inverse of the migration runner's app-role
 * refusal. The refusal fails the FIRST request (a 500, one clean line in the
 * server log) rather than the process, but it is never possible to serve a
 * request through a bypassing role.
 */

/** The one connection string the app serves on. */
export function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'app: APP_DATABASE_URL is not set — the app must connect as the NON-owner ' +
        'app role. It is deliberately NOT read from DATABASE_URL / ' +
        'MIGRATE_DATABASE_URL, which are the migration OWNER role: a table owner ' +
        '(or any superuser / BYPASSRLS role) bypasses RLS, so serving as the owner ' +
        'would silently defeat every tenant protection. See .env.example.',
    );
  }
  return url;
}

/**
 * REFUSES a connection whose resolved role would defeat row-level security.
 *
 * This is the inverse of the migration runner's app-role refusal
 * (`scripts/migrate.mjs`): the runner refuses to be the app role because it must
 * OWN the tables; the app refuses to be the owner (or any superuser / `BYPASSRLS`
 * role) because a bypassing role is not subject to the RLS policies that make the
 * tenancy model work. Detected from the CONNECTION, not the URL, so `postgres`
 * reached through any url shape is caught and only genuinely non-bypassing roles
 * pass. Throws one explanatory line, not a stack trace of its own.
 */
export async function assertServingRole(pool: Queryable): Promise<void> {
  const { rows } = await pool.query<{
    role: string;
    superuser: boolean;
    bypassrls: boolean;
  }>(
    `select current_user as role,
            r.rolsuper as superuser,
            r.rolbypassrls as bypassrls
       from pg_roles r
      where r.rolname = current_user`,
  );
  const role = rows[0];
  if (!role) {
    throw new Error('app: could not read the connection role');
  }
  if (role.superuser || role.bypassrls) {
    throw new Error(
      `app: refusing to serve as role "${role.role}" — it is ` +
        `${role.superuser ? 'a SUPERUSER' : 'granted BYPASSRLS'}, so row-level ` +
        `security would be silently defeated for every tenant. Point ` +
        `APP_DATABASE_URL at the non-owner app role (see .env.example): the ` +
        `owner/migration role must never serve requests.`,
    );
  }
}

/**
 * Creates a pool from `url` and REFUSES to return it unless the resolved role is
 * non-bypassing. On refusal the half-built pool is closed so it never serves a
 * request.
 */
export async function createAppPool(url: string): Promise<Pool> {
  const created = newPool(url);
  try {
    await assertServingRole(created);
  } catch (err) {
    await created.end().catch(() => {});
    throw err;
  }
  return created;
}

let ready: Promise<Pool> | undefined;

/**
 * The process-wide pool, resolved and role-checked on first call.
 *
 * Memoised as a PROMISE so concurrent first requests share one pool (and one
 * role check) instead of each opening a connection. A refusal is memoised too:
 * every later request keeps failing loudly until the deployment is fixed and the
 * process is restarted — which is the point; there is no path that quietly
 * serves a bypassing role.
 */
export function getAppPool(): Promise<Pool> {
  ready ??= createAppPool(appDatabaseUrl());
  return ready;
}
