import Link from 'next/link';
import { redirect } from 'next/navigation';

import { loadCurrentUser } from '@/modules/auth/index';
import { KpiCard } from '@/modules/shell/ui/KpiCard';
import { PageHeader } from '@/modules/shell/ui/PageHeader';
import { navLinksForPermissions } from '@/modules/shell/schema';
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
 * The links are PERMISSION-aware (`navLinksForPermissions`): each screen names
 * the permission that reaches it, so a role the tenant created sees exactly the
 * screens it was granted — including the admin screens, which no role enum
 * could ever have offered. Every label follows the request's resolved language.
 */
export default async function HomePage() {
  const lang = await getRequestLang();
  const user = await loadCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);

  const role = user.role;
  const isOwner = role === 'owner';
  const isManager = role === 'warehouse_manager';
  const isBranch = role === 'branch_user';

  return (
    <main className="p-4">
      <PageHeader title={t('home.title', lang)} subtitle={t('home.tagline', lang)} />
      <p className="text-sm text-muted-foreground">{t('home.signed_in_as', { lang, params: { name: user.displayName } })}</p>

      <div className="grid grid-cols-2 gap-3 mt-4">
        {isOwner && (
          <>
            <KpiCard label={t('home.dashboard.owner.stock_lines', lang)} value="—" />
            <KpiCard label={t('home.dashboard.owner.below_min', lang)} value="—" />
            <KpiCard label={t('home.dashboard.owner.open_requests', lang)} value="—" />
            <KpiCard label={t('home.dashboard.owner.in_transit', lang)} value="—" />
          </>
        )}
        {isManager && (
          <>
            <KpiCard label={t('home.dashboard.manager.to_approve', lang)} value="—" />
            <KpiCard label={t('home.dashboard.manager.to_issue', lang)} value="—" />
            <KpiCard label={t('home.dashboard.manager.receipts_receiving', lang)} value="—" />
          </>
        )}
        {isBranch && (
          <>
            <KpiCard label={t('home.dashboard.branch.my_requests', lang)} value="—" />
            <KpiCard label={t('home.dashboard.branch.to_confirm', lang)} value="—" />
          </>
        )}
      </div>

      <nav className="mt-6">
        <ul className="space-y-1">
          {navLinksForPermissions(user.permissions).map((l) => (
            <li key={l.href}>
              <Link href={l.href}>{t(l.key, lang)}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <a href="/sign-out" className="block mt-4">{t('home.sign_out', lang)}</a>
    </main>
  );
}