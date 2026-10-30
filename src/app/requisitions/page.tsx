import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/modules/auth/schema';
import { configuredTenantId } from '@/modules/auth/index';
import { RequisitionListScreen } from '@/modules/requisitions/ui/RequisitionListScreen';
import { getAppPool } from '@/modules/platform/index';
import { withTenant } from '@/modules/platform/index';
import { REFUSAL_MESSAGE_KEYS } from '@/modules/requisitions/schema';
import { t } from '../../i18n';
import { getRequestLang } from '../../i18n/request';
import { SIGN_IN_PATH } from '../(auth)/sign-in/contract';
import { listRequisitions } from './handler';

export async function generateMetadata() {
  const lang = await getRequestLang();
  return { title: t('requisitions.title', lang) };
}

/**
 * THE REQUISITION LIST — the branch's asks and the warehouse's queue.
 *
 * The session cookie is resolved by `listRequisitions` inside ONE `withTenant`
 * boundary, and that one pass also answers what the screen needs. The page never
 * opens a second boundary. A `branch_user` is filtered to their OWN branch in
 * the QUERY, so another branch's requisition never leaves the database.
 */
export default async function RequisitionsPage() {
  const lang = await getRequestLang();
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const list = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    listRequisitions(db, cookie),
  );

  if (!list.user) redirect(SIGN_IN_PATH);

  const maySee = list.mayRequest || list.mayApprove;

  return (
    <main>
      <h1>{t('requisitions.title', lang)}</h1>
      {maySee ? (
        <>
          <p>{t('requisitions.subtitle', lang)}</p>
          <RequisitionListScreen
            lang={lang}
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
        <p role="alert">{t(REFUSAL_MESSAGE_KEYS.forbidden, lang)}</p>
      )}
      <p>
        <a href="/">{t('requisitions.back', lang)}</a>
      </p>
    </main>
  );
}