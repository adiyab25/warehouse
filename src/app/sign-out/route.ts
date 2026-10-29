import { NextResponse } from 'next/server';

import { SESSION_COOKIE } from '@/modules/auth/domain/cookie';
import { SIGN_IN_PATH, sessionCookieOptions } from '../sign-in/contract';

/**
 * SIGN-OUT — the way out of the front door.
 *
 * Clears the session cookie and sends the person to the sign-in page. It is a
 * ROUTE HANDLER, not a server action, because signing out is a navigation a
 * plain link must be able to perform — a server action can only be invoked from
 * a form or client code, which would leave a signed-in person with no way out
 * if scripting failed.
 *
 * What it does NOT do: revoke the session ROW in the database. Clearing the
 * cookie ends the browser's access; the token itself stays live until it
 * expires or is revoked (see src/auth/session.ts). That is the deliberate v1
 * choice recorded there — an offboarding that must end a live session sets
 * `app_users.active = false`, which `readSession` enforces on the very next
 * request — and this route is deliberately kept dependency-free (no database
 * call) so signing out cannot fail because the database is unreachable.
 *
 * The cookie is DELETED with the SAME attributes it was set with (name, path,
 * and — in production — the `__Host-` name, which browsers only match on path):
 * a deletion that omits `path` would leave the original cookie in place and the
 * person still signed in.
 */
function signOut(request: Request): NextResponse {
  const response = NextResponse.redirect(new URL(SIGN_IN_PATH, request.url));
  // `expires` is the epoch and `maxAge` 0, so every browser (and every proxy)
  // treats it as deleted; `sessionCookieOptions` supplies the name's own
  // attributes (path, and the `secure`/`__Host-` pairing) from the same single
  // definition the sign-in action uses.
  response.cookies.set(SESSION_COOKIE, '', {
    ...sessionCookieOptions(new Date(0)),
    maxAge: 0,
  });
  return response;
}

export async function GET(request: Request): Promise<NextResponse> {
  return signOut(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return signOut(request);
}
