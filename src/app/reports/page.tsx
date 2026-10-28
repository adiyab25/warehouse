import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '../../auth/cookie';
import { configuredTenantId } from '../../auth/tenant';
import { ReplenishmentScreen } from '../../components/ReplenishmentScreen';
import { getAppPool } from '../../db/app-pool';
import { withTenant } from '../../db/client';
import { t } from '../../i18n';
import { SIGN_IN_PATH } from '../sign-in/contract';
import { REPORT_REFUSAL_MESSAGE_KEYS, getReplenishmentReport } from './handler';

export const metadata = { title: t('reports.heading') };

/**
 * THE REPLENISHMENT REPORT — what is at or below its minimum, per branch.
 *
 * The session is resolved by `getReplenishmentReport` inside ONE `withTenant`
 * boundary; the scope (the owner sees every branch, a branch user only their own)
 * comes from the SESSION server-side, never from the request. A coded refusal maps
 * to its OWN sentence; an expired session redirects to sign-in.
 */
export default async function ReportsPage() {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const report = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    getReplenishmentReport(db, cookie),
  );

  if (!report.ok && report.error === 'unauthenticated') redirect(SIGN_IN_PATH);

  return (
    <main dir="rtl">
      <h1>{t('reports.heading')}</h1>
      {report.ok ? (
        <ReplenishmentScreen
          groups={report.groups}
          days={report.days}
          truncated={report.truncated}
          limit={report.limit}
          branchLabel={report.scope === 'branch' ? report.branchLabel : null}
        />
      ) : (
        <p role="alert">{t(REPORT_REFUSAL_MESSAGE_KEYS[report.error])}</p>
      )}
      <p>
        <a href="/">{t('reports.back')}</a>
      </p>
    </main>
  );
}
