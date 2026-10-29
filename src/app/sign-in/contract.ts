import { SESSION_COOKIE, sessionCookieName } from '@/modules/auth/domain/cookie';

/**
 * The sign-in form's GET contract — the shapes the action produces and the form
 * consumes, pulled out of the `'use server'` module so they can be TESTED.
 *
 * A `'use server'` file may export ONLY async functions (Next enforces it at
 * build time), and this is not one — so the cookie's attributes, the redirect
 * targets and the reason/username round-trip live here, in a plain module the
 * action imports and the tests import directly. See
 * tests/domain/sign-in-contract.test.ts.
 */

/** Where a signed-in person lands. */
export const SIGNED_IN_REDIRECT = '/';

/** The sign-in page. */
export const SIGN_IN_PATH = '/sign-in';

/** The form field the typed username arrives in, and is echoed back in. */
export const USERNAME_FIELD = 'username';

/** The query parameter that carries the failure reason back to the form. */
export const ERROR_PARAM = 'error';

/** The outcome of a sign-in attempt, as the form needs it. */
export type SignInReason = 'invalid' | 'locked';

/** The cookie attributes a session token is set with. */
export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  expires: Date;
}

/**
 * The attributes the session cookie is set with.
 *
 * NOTHING HERE IS OPTIONAL. `httpOnly` keeps the token out of `document.cookie`
 * (an XSS on any page cannot read it); `sameSite: 'lax'` stops a cross-site form
 * from carrying it (CSRF); `path: '/'` is what the whole app needs AND one of
 * the three conditions a `__Host-` name requires; and `secure` is tied to the
 * SAME decision as the name — see {@link sessionCookieName} — because a
 * `__Host-` cookie that is not `Secure` is REJECTED by the browser, which would
 * look exactly like a failed sign-in. `expires` is the session's own
 * `expires_at`, from the database clock, so the cookie dies with the session it
 * carries rather than outliving it.
 */
export function sessionCookieOptions(
  expiresAt: Date,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: nodeEnv === 'production',
    path: '/',
    expires: expiresAt,
  };
}

/** The name the cookie must be set with, for the same reason as the attributes. */
export { SESSION_COOKIE };

/**
 * Where a FAILED sign-in redirects: back to the form, carrying the reason and
 * the typed username.
 *
 * The username rides back so a person who mistyped their PASSWORD does not have
 * to type their username again — a failure is not a reason to make them re-enter
 * what they already got right. It is carried as a query parameter (encoded, so
 * an Arabic name or a stray `&` cannot break the URL) and never paired with the
 * password.
 */
export function failedSignInRedirect(
  reason: SignInReason,
  typedUsername: string,
): string {
  const params = new URLSearchParams({
    [ERROR_PARAM]: reason,
    [USERNAME_FIELD]: typedUsername,
  });
  return `${SIGN_IN_PATH}?${params.toString()}`;
}
