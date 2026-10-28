import { redirect } from 'next/navigation';

import { loadCurrentUser } from '../auth/current-user';
import { SIGN_IN_PATH } from './sign-in/contract';
import { t } from '../i18n';

/**
 * The home page — the post-sign-in landing, and THE GATE.
 *
 * It is the app's front door, so it is where the session is checked: an
 * unauthenticated visitor (no cookie, an unknown token, an expired or revoked
 * session, or a deactivated user) is redirected to the sign-in page rather than
 * shown a shell. `loadCurrentUser` resolves the session ONCE, inside one
 * `withTenant` boundary, and every one of those cases comes back as `null` —
 * see src/auth/current-user.ts.
 *
 * THE CHECK IS HERE, NOT ONLY IN THE MIDDLEWARE. src/middleware.ts redirects a
 * request that carries NO session cookie at all — cheap, and it never touches
 * the database. It cannot decide whether a cookie is VALID (that needs the
 * database, which the edge runtime does not have), so a forged or stale cookie
 * passes the middleware and is refused HERE. Both halves are needed; neither is
 * sufficient.
 *
 * Reading the cookie makes this page DYNAMIC (it can no longer be prerendered),
 * which is the point: a static `/` is a page that cannot tell who is asking.
 *
 * Content is still deliberately minimal — Tasks 12-16 add the real,
 * role-aware screens.
 */
export default async function HomePage() {
  const user = await loadCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);

  return (
    <main>
      <h1>{t('home.title')}</h1>
      <p>{t('home.tagline')}</p>
      {/* The DISPLAY NAME, never the username: the person sees the name they
          were hired under, while the account behind it is the username. */}
      <p>{t('home.signed_in_as', { params: { name: user.displayName } })}</p>
      <a href="/sign-out">{t('home.sign_out')}</a>
    </main>
  );
}
