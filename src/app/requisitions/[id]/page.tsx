import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '../../../auth/cookie';
import { configuredTenantId } from '../../../auth/tenant';
import { RequisitionDetailScreen } from '../../../components/RequisitionDetailScreen';
import { getAppPool } from '../../../db/app-pool';
import { withTenant } from '../../../db/client';
import { REFUSAL_MESSAGE_KEYS } from '../../../domain/requisition-ui';
import { t } from '../../../i18n';
import { SIGN_IN_PATH } from '../../sign-in/contract';
import { getRequisition } from '../handler';

export const metadata = { title: t('requisitions.detail.heading') };

/**
 * ONE REQUISITION — the state machine's buttons, for the person who may press
 * them.
 *
 * The session is resolved by `getRequisition` inside ONE `withTenant` boundary,
 * and the SAME read decides whether this viewer may open this document at all:
 * a `branch_user` is refused a requisition that is not for their own branch, and
 * the refusal is the SAME code a missing id gets (so it is not an existence
 * oracle). `withTenant` is opened exactly once, here.
 *
 * WHICH BUTTONS EXIST comes from the handler's `actions`, which is
 * `availableActions(status, role)` — the pure rule in
 * `src/domain/requisition-ui.ts` — so the state machine and the viewer's role
 * decide the markup, never the other way round. The handler re-asserts every
 * rule server-side, so a forged render changes nothing.
 *
 * The `key` on the screen is derived from the state and the per-line quantities,
 * so a successful flow RE-MOUNTS it with fresh defaults instead of leaving a
 * stale quantity in an input.
 */
export default async function RequisitionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const detail = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    getRequisition(db, cookie, id),
  );

  if (!detail.ok && detail.error === 'unauthenticated') redirect(SIGN_IN_PATH);

  return (
    <main dir="rtl">
      <h1>{t('requisitions.detail.heading')}</h1>
      {detail.ok ? (
        <RequisitionDetailScreen
          key={`${detail.id}:${detail.status}:${detail.lines
            .map((line) => `${line.issuedQty}/${line.receivedQty}`)
            .join(',')}`}
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
        <p role="alert">{t(REFUSAL_MESSAGE_KEYS[detail.error])}</p>
      )}
      <p>
        <a href="/requisitions">{t('requisitions.back')}</a>
      </p>
    </main>
  );
}
