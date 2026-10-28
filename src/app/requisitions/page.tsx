import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '../../auth/cookie';
import { configuredTenantId } from '../../auth/tenant';
import { RequisitionListScreen } from '../../components/RequisitionListScreen';
import { getAppPool } from '../../db/app-pool';
import { withTenant } from '../../db/client';
import { REFUSAL_MESSAGE_KEYS } from '../../domain/requisition-ui';
import { t } from '../../i18n';
import { SIGN_IN_PATH } from '../sign-in/contract';
import { listRequisitions } from './handler';

export const metadata = { title: t('requisitions.title') };

/**
 * THE REQUISITION LIST — the branch's asks and the warehouse's queue.
 *
 * THE GATE IS HERE, AND IT IS THE SAME GATE AS EVERYWHERE ELSE. The session
 * cookie is resolved by `listRequisitions` inside ONE `withTenant` boundary (the
 * app's own pool — `await getAppPool()`, which refuses to serve as a superuser —
 * scoped to the deployment's tenant), and that one pass also answers what the
 * screen needs: which requisitions this viewer may see, whether they may ask for
 * stock, and the catalogue the request form offers. The page never opens a
 * second boundary; `withTenant` is not re-entrant.
 *
 * THE SCOPING IS THE SERVER'S. A `branch_user` is filtered to their OWN branch in
 * the QUERY, so another branch's requisition never leaves the database — the
 * markup is not a permission. A viewer in neither role is shown the refusal and
 * NO data was read for them at all.
 *
 * The page is Arabic and RIGHT-TO-LEFT (`dir="rtl"`, inherited from the root
 * layout and stated here so the screen stands alone).
 *
 * Reading a cookie makes this page DYNAMIC, which is the point: a static list is
 * a page that cannot tell who is asking.
 */
export default async function RequisitionsPage() {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const list = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    listRequisitions(db, cookie),
  );

  if (!list.user) redirect(SIGN_IN_PATH);

  const maySee = list.mayRequest || list.mayApprove;

  return (
    <main dir="rtl">
      <h1>{t('requisitions.title')}</h1>
      {maySee ? (
        <>
          <p>{t('requisitions.subtitle')}</p>
          <RequisitionListScreen
            mayRequest={list.mayRequest}
            branchLabel={list.branchLabel}
            variants={list.variants}
            requisitions={list.requisitions.map((row) => ({
              id: row.id,
              status: row.status,
              branchNameAr: row.branchNameAr,
              branchCode: row.branchCode,
              requestedAt: row.requestedAt,
              lineCount: row.lineCount,
            }))}
          />
        </>
      ) : (
        <p role="alert">{t(REFUSAL_MESSAGE_KEYS.forbidden)}</p>
      )}
      <p>
        <a href="/">{t('requisitions.back')}</a>
      </p>
    </main>
  );
}
