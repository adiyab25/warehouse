import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/modules/auth/schema';
import { configuredTenantId } from '@/modules/auth/index';
import { getAppPool, withTenant } from '@/modules/platform/index';
import { ADMIN_REFUSAL_MESSAGE_KEYS, tryUsersOverview } from '@/modules/admin/index';
import { UsersScreen } from '@/modules/admin/ui/UsersScreen';
import { PageHeader } from '@/modules/shell/ui/PageHeader';
import { t } from '../../../i18n';
import { getRequestLang } from '../../../i18n/request';
import { SIGN_IN_PATH } from '../../(auth)/sign-in/contract';

export async function generateMetadata() {
  const lang = await getRequestLang();
  return { title: t('admin.users.title', lang) };
}

/**
 * THE USERS SCREEN — the tenant's people, their roles and their branches.
 *
 * Same shape as the roles page: ONE `withTenant` boundary, resolved from the
 * request's own session cookie, refusing rather than rendering an empty screen
 * for a viewer who does not hold `auth:users:manage`.
 */
export default async function UsersPage() {
  const lang = await getRequestLang();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;

  const result = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    tryUsersOverview(db, cookie),
  );

  if (!result.ok) {
    if (result.code === 'unauthenticated') redirect(SIGN_IN_PATH);
    return (
      <main className="p-4">
        <PageHeader title={t('admin.users.title', lang)} />
        <p className="text-sm text-muted-foreground">{t(ADMIN_REFUSAL_MESSAGE_KEYS[result.code], lang)}</p>
      </main>
    );
  }

  return (
    <main className="p-4">
      <UsersScreen
        lang={lang}
        users={result.data.users}
        roles={result.data.roles}
        branches={result.data.branches}
        selfId={result.data.selfId}
      />
    </main>
  );
}
