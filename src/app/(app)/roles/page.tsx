import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/modules/auth/schema';
import { configuredTenantId } from '@/modules/auth/index';
import { getAppPool, withTenant } from '@/modules/platform/index';
import { ADMIN_REFUSAL_MESSAGE_KEYS, tryRolesOverview } from '@/modules/admin/index';
import { RolesScreen } from '@/modules/admin/ui/RolesScreen';
import { PageHeader } from '@/modules/shell/ui/PageHeader';
import { t } from '../../../i18n';
import { getRequestLang } from '../../../i18n/request';
import { SIGN_IN_PATH } from '../../(auth)/sign-in/contract';

export async function generateMetadata() {
  const lang = await getRequestLang();
  return { title: t('admin.roles.title', lang) };
}

/**
 * THE ROLES SCREEN — who may do what, in the tenant's own words.
 *
 * The session cookie is resolved by `tryRolesOverview` inside ONE `withTenant`
 * boundary, and that pass also answers everything the screen renders. The page
 * never opens a second boundary (`withTenant` is not re-entrant).
 *
 * A visitor who is not signed in goes to the sign-in page; a signed-in person
 * who does not hold `auth:roles:manage` gets a plain refusal, not a 500 and not
 * an empty screen that looks broken.
 */
export default async function RolesPage() {
  const lang = await getRequestLang();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;

  const result = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    tryRolesOverview(db, cookie),
  );

  if (!result.ok) {
    if (result.code === 'unauthenticated') redirect(SIGN_IN_PATH);
    return (
      <main className="p-4">
        <PageHeader title={t('admin.roles.title', lang)} />
        <p className="text-sm text-muted-foreground">{t(ADMIN_REFUSAL_MESSAGE_KEYS[result.code], lang)}</p>
      </main>
    );
  }

  return (
    <main className="p-4">
      <RolesScreen lang={lang} roles={result.data.roles} permissions={result.data.permissions} />
    </main>
  );
}
