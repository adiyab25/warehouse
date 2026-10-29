/**
 * The session cookie — its NAME, in one place, and WHY that name.
 *
 * `__Host-` in PRODUCTION. A `__Host-` prefixed cookie is only accepted by a
 * browser when it is `Secure`, has `Path=/`, and carries NO `Domain` — which is
 * precisely what a session cookie wants: it cannot be set or overwritten by a
 * sibling subdomain (a compromised `blog.example.com` cannot fixate
 * `example.com`'s session), and it cannot be read over plain http. None of that
 * is enforceable by a name alone, so the name and the attributes must agree —
 * see `sessionCookieOptions` in src/app/sign-in/contract.ts, which sets
 * `secure` whenever this name is used.
 *
 * The exception is DEVELOPMENT, which serves plain `http://localhost`. A
 * `__Host-` cookie requires `Secure`, and a browser on plain http will drop a
 * `Secure` cookie, so a development server using `__Host-session` would look
 * signed-in in the database and signed-out in the browser. Outside production
 * the name is therefore the plain, unambiguous `session`.
 *
 * This module is DELIBERATELY dependency-free (no `next/*`, no `pg`): the
 * middleware runs it on the edge runtime, and the server action on Node, and
 * both must resolve the same name.
 */

/**
 * The cookie name for a given Node environment. Pure, so a test can ask what
 * the PRODUCTION name is without pretending to be production.
 */
export function sessionCookieName(nodeEnv: string | undefined = process.env.NODE_ENV): string {
  return nodeEnv === 'production' ? '__Host-session' : 'session';
}

/** The cookie the raw session token lives in, for THIS process. */
export const SESSION_COOKIE = sessionCookieName();
