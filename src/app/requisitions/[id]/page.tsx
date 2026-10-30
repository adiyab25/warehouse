import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/modules/auth/schema';
import { configuredTenantId } from '@/modules/auth/index';
import { RequisitionDetailScreen } from '@/modules/requisitions/ui/RequisitionDetailScreen';
import { getAppPool } from '@/modules/platform/index';
import { withTenant } from '@/modules/platform/index';
import { REFUSAL_MESSAGE_KEYS } from '@/modules/requisitions/schema';
import { t } from '../../../i18n';
import { getRequestLang } from '../../../i18n/request';
import { SIGN_IN_PATH } from '../../(auth)/sign-in/contract';
import { getRequisition } from '../handler';

export async function generateMetadata() {
  const lang = await getRequestLang();
  return { title: t('requisitions.detail.heading', lang) };
}

/**
 * ONE REQUISITION — the state machine's buttons, for the person who may press
 * them.
 *
 * The session is resolved by `getRequisition` inside ONE `withTenant` boundary,
 * and the SAME read decides whether this viewer may open this document at all:
 * a `branch_user` is refused a requisition that is not for their own branch, and
 * the refusal is the SAME code a missing id gets (so it is not an existence
 * oracle).
 */
export default async function RequisitionPage({ params }: { params: Promise<{ id: string }> }) {
  const lang = await getRequestLang();
  const { id } = await params;

  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const detail = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    getRequisition(db, cookie, id),
  );

  if (!detail.ok && detail.error === 'unauthenticated') redirect(SIGN_IN_PATH);

  return (
    <main>
      <h1>{t('requisitions.detail.heading', lang)}</h1>
      {detail.ok ? (
        <RequisitionDetailScreen
          lang={lang}
          id={detail.id}
          status={detail.status}
          branchNameAr={detail.branchNameAr}
          branchCode={detail.branchCode}
          requestedAt={detail.requestedAt}
          requestedByName={detail.requestedByName}
          notes={detail.notes}
          lines={detail.lines}
          actions={detail.actions}
        />
      ) : (
        <p role="alert">{t(REFUSAL_MESSAGE_KEYS[detail.error], lang)}</p>
      )}
      <p>
        <a href="/requisitions">{t('requisitions.back', lang)}</a>
      </p>
    </main>
  );
}