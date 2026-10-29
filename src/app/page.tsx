import Link from 'next/link';
import { redirect } from 'next/navigation';

import { loadCurrentUser } from '@/modules/auth/index';
import { navLinksForRole } from '@/modules/shell/domain/nav';
import { t } from '../i18n';
import { getRequestLang } from '../i18n/request';
import { SIGN_IN_PATH } from './(auth)/sign-in/contract';

/**
 * The home page — the post-sign-in landing, and THE GATE.
 *
 * It is the app's front door, so it is where the session is checked: an
 * unauthenticated visitor is redirected to the sign-in page. `loadCurrentUser`
 * resolves the session ONCE, inside one `withTenant` boundary.
 *
 * The links are role-aware (`navLinksForRole`): the warehouse side sees intake
 * and the reports, a branch sees exactly the screens it participates in. Every
 * label follows the request's resolved language.
 */
export default async function HomePage() {
  const lang = await getRequestLang();
  const user = await loadCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);

  return (
    <main>
      <h1>{t('home.title', lang)}</h1>
      <p>{t('home.tagline', lang)}</p>
      {/* The DISPLAY NAME, never the username: the person sees the name they
          were hired under, while the account behind it is the username. */}
      <p>{t('home.signed_in_as', { lang, params: { name: user.displayName } })}</p>
      <nav>
        <ul>
          {navLinksForRole(user.role).map((l) => (
            <li key={l.href}>
              <Link href={l.href}>{t(l.key, lang)}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <a href="/sign-out">{t('home.sign_out', lang)}</a>
    </main>
  );
}