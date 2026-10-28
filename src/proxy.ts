import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE } from './auth/cookie';
import { SIGN_IN_PATH } from './app/sign-in/contract';

/**
 * The FIRST half of the session gate: send a request with NO session cookie to
 * the sign-in page.
 *
 * (Next 16 calls this file convention `proxy` — it is the renamed `middleware`,
 * running on the Node.js runtime before a request is rendered. The logic is
 * unchanged. See https://nextjs.org/docs/app/api-reference/file-conventions/proxy.)
 *
 * WHY IT EXISTS, given the page checks too: this runs before ANY rendering, for
 * every matched request, and it deliberately does not touch the database — so it
 * is the cheap answer to the common case (a stranger hitting `/`), and it keeps
 * the front door shut even on a route someone adds later without a check of its
 * own.
 *
 * WHY IT IS NOT ENOUGH ON ITS OWN: it can only ask "is there a cookie", never
 * "is this cookie a LIVE session". A random, forged or expired cookie passes
 * here and is refused by the page itself (src/app/page.tsx, via
 * src/auth/current-user.ts, which is what reads the database). Both halves are
 * load-bearing; neither is sufficient.
 *
 * WHAT IT DOES NOT MATCH: the sign-in page, the sign-out route, and Next's own
 * assets. The matcher is deliberately an ALLOW-LIST of the routes that need a
 * session (`/`) rather than a deny-list, so a route added later is protected by
 * default instead of silently public.
 */
export function proxy(request: NextRequest): NextResponse {
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (hasSessionCookie) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = SIGN_IN_PATH;
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/'],
};
