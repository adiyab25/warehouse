'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { signIn } from '../../auth/login';
import { configuredTenantId } from '../../auth/tenant';
import { newPool, withTenant } from '../../db/client';

/**
 * The sign-in server action.
 *
 * TENANCY AT THE BOUNDARY: the tenant is deployment configuration
 * ({@link configuredTenantId}), and `withTenant` is NOT re-entrant — so it is
 * opened exactly ONCE here, at the request boundary, and the scoped `db` is
 * passed inward to {@link signIn}. Nothing inside signIn re-opens it.
 *
 * The session token is set as an httpOnly cookie (no script can read it),
 * SameSite=Lax (a cross-site form cannot carry it), Secure in production only,
 * path=/. A failed attempt redirects back to the form with the reason; a
 * password, a token and a hash are never logged.
 */

/** The cookie the raw session token lives in. */
const SESSION_COOKIE = 'session';

/**
 * One pool per process. The pool is created LAZILY, inside the action, so
 * merely importing this module (e.g. during `next build`) does not require
 * `DATABASE_URL` to be set.
 */
let pool: ReturnType<typeof newPool> | undefined;
function getPool(): ReturnType<typeof newPool> {
  pool ??= newPool();
  return pool;
}

export async function signInAction(formData: FormData): Promise<void> {
  const userLookup = String(formData.get('userLookup') ?? '');
  const password = String(formData.get('password') ?? '');

  const result = await withTenant(getPool(), configuredTenantId(), (db) =>
    signIn(db, { userLookup, password }),
  );

  if (result.ok) {
    const store = await cookies();
    store.set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: result.expiresAt,
    });
    // redirect() throws, so nothing below runs on success.
    redirect('/');
  }

  redirect(`/sign-in?error=${result.reason}`);
}
