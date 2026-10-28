import type { Queryable } from '../db/client.ts';
import type { Role } from './session.ts';
import { readSession } from './session.ts';
import { SESSION_COOKIE } from './cookie.ts';

/**
 * The CURRENT USER — who the request's session cookie actually is.
 *
 * This is the one place a cookie is turned into a person, and it is deliberately
 * a thin layer: the trust decision (is this token live?) belongs to
 * {@link readSession}, and everything it returns is filtered by the tenant
 * `withTenant` pinned, so a cookie can never resolve outside the deployment's
 * tenant.
 *
 * TWO ENTRY POINTS, on purpose:
 *
 *   * {@link currentUser} — the SEAM. It takes an already tenant-scoped `db` and
 *     a cookie value, so a test can drive it against a real database with rows
 *     it provisioned, and with no HTTP layer at all.
 *   * {@link loadCurrentUser} — the REQUEST path. It reads the request's cookie
 *     via `next/headers`, opens EXACTLY ONE `withTenant` boundary (the
 *     deployment tenant is configuration, `configuredTenantId()`), and resolves
 *     the session inside it. A page calls this once and gets `null` or a user;
 *     it must not open its own `withTenant` (`withTenant` is not re-entrant —
 *     see src/db/client.ts).
 *
 * A MISS IS A NULL, never an error: an absent cookie, an unknown token, an
 * expired session, a revoked session and a deactivated user all mean the same
 * thing to the caller — not signed in.
 */

/** The signed-in person, as the app needs them. */
export interface CurrentUser {
  /** `app_users.id` — the identity the session was opened for. */
  userId: string;
  /** The tenant the session belongs to (always the deployment's tenant). */
  tenantId: string;
  /** What the person may do. Mirrors `app_users.role`. */
  role: Role;
  /** The person's name AS TYPED — display data, never a credential. */
  displayName: string;
  /** The assigned username the person signed in with. */
  username: string;
}

/**
 * Resolves a raw session cookie to the person behind it, or `null`.
 *
 * Call it with the `db` of an ALREADY-OPEN `withTenant` scope; it opens none of
 * its own. The session is resolved ONCE — one `readSession`, one follow-up read
 * of the person's display row — inside that single transaction, so a request
 * costs one connection checkout regardless of how many screens ask who is
 * signed in.
 */
export async function currentUser(
  db: Queryable,
  cookieValue: string | undefined | null,
): Promise<CurrentUser | null> {
  if (typeof cookieValue !== 'string' || cookieValue === '') return null;

  const session = await readSession(db, cookieValue);
  if (!session) return null;

  const { rows } = await db.query<{ name: string; username: string }>(
    `select name, username from app_users where id = $1`,
    [session.userId],
  );
  const person = rows[0];
  if (!person) return null;

  return {
    userId: session.userId,
    tenantId: session.tenantId,
    role: session.role,
    displayName: person.name,
    username: person.username,
  };
}

/**
 * The request-scoped version: reads the session cookie and resolves it inside
 * ONE `withTenant` boundary.
 *
 * `next/headers` is imported DYNAMICALLY so this module's static graph stays
 * free of the Next request layer — which is what lets tests import
 * {@link currentUser} directly (see tests/contract/current-user.test.ts).
 */
export async function loadCurrentUser(): Promise<CurrentUser | null> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;

  const { getAppPool } = await import('../db/app-pool.ts');
  const { withTenant } = await import('../db/client.ts');
  const { configuredTenantId } = await import('./tenant.ts');

  return withTenant(getAppPool(), configuredTenantId(), (db) => currentUser(db, value));
}
