'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { signIn } from '../../auth/login';
import { configuredTenantId } from '../../auth/tenant';
import { withTenant } from '../../db/client';
import { getAppPool } from '../../db/app-pool';
import { LANG_COOKIE, langCookieOptions } from '../../i18n/request';
import {
  SESSION_COOKIE,
  SIGNED_IN_REDIRECT,
  USERNAME_FIELD,
  failedSignInRedirect,
  sessionCookieOptions,
} from './contract';

/**
 * The sign-in server action.
 *
 * TENANCY AT THE BOUNDARY: the tenant is deployment configuration
 * ({@link configuredTenantId}), and `withTenant` is NOT re-entrant — so it is
 * opened exactly ONCE here, at the request boundary, and the scoped `db` is
 * passed inward to {@link signIn}. Nothing inside signIn re-opens it.
 *
 * The session token is set as a cookie via {@link sessionCookieOptions} — the
 * attributes (and the name) are defined once, next to the form's contract, so
 * they can be tested without running a server. A failed attempt redirects back
 * to the form with the reason AND the typed username; a password, a token and a
 * hash are never logged, and the password is never put in a URL.
 */
export async function signInAction(formData: FormData): Promise<void> {
  const username = String(formData.get(USERNAME_FIELD) ?? '');
  const password = String(formData.get('password') ?? '');

  const result = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    signIn(db, { username, password }),
  );

  if (result.ok) {
    const store = await cookies();
    store.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
    // The per-user language override rides in a cookie: set it to the user's
    // preference, or clear it so the browser's own language governs (they
    // chose "follow the browser first, override per user").
    if (result.preferredLang === 'ar' || result.preferredLang === 'en') {
      store.set(LANG_COOKIE, result.preferredLang, langCookieOptions());
    } else {
      store.delete(LANG_COOKIE);
    }
    // redirect() throws, so nothing below runs on success.
    redirect(SIGNED_IN_REDIRECT);
  }

  redirect(failedSignInRedirect(result.reason, username));
}
