import Link from 'next/link';
import { redirect } from 'next/navigation';

import { loadCurrentUser } from '../auth/current-user';
import { navLinksForRole } from '../domain/home-nav';
import { t } from '../i18n';
import { SIGN_IN_PATH } from './sign-in/contract';

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
 * The links are role-aware (`navLinksForRole`): the warehouse side sees intake
 * and the reports, a branch sees exactly the screens it participates in. A home
 * page with no way onwards is a dead end that reads as a blank page after
 * sign-in, so the landing page always carries the way in.
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
      <nav>
        <ul>
          {navLinksForRole(user.role).map((l) => (
            <li key={l.href}>
              <Link href={l.href}>{t(l.key)}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <a href="/sign-out">{t('home.sign_out')}</a>
    </main>
  );
}
