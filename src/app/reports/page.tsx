import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/modules/auth/domain/cookie';
import { configuredTenantId } from '@/modules/auth/index';
import { ReplenishmentScreen } from '@/modules/reports/ui/ReplenishmentScreen';
import { getAppPool } from '@/modules/platform/index';
import { withTenant } from '@/modules/platform/index';
import { t } from '../../i18n';
import { getRequestLang } from '../../i18n/request';
import { SIGN_IN_PATH } from '../sign-in/contract';
import { REPORT_REFUSAL_MESSAGE_KEYS, getReplenishmentReport } from './handler';

export async function generateMetadata() {
  const lang = await getRequestLang();
  return { title: t('reports.heading', lang) };
}

/**
 * THE REPLENISHMENT REPORT — what is at or below its minimum, per branch.
 *
 * The session is resolved by `getReplenishmentReport` inside ONE `withTenant`
 * boundary; the scope comes from the SESSION server-side, never from the request.
 * A coded refusal maps to its OWN sentence; an expired session redirects to
 * sign-in.
 */
export default async function ReportsPage() {
  const lang = await getRequestLang();
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const report = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    getReplenishmentReport(db, cookie),
  );

  if (!report.ok && report.error === 'unauthenticated') redirect(SIGN_IN_PATH);

  return (
    <main>
      <h1>{t('reports.heading', lang)}</h1>
      {report.ok ? (
        <ReplenishmentScreen
          groups={report.groups}
          days={report.days}
          truncated={report.truncated}
          limit={report.limit}
          branchLabel={report.scope === 'branch' ? report.branchLabel : null}
        />
      ) : (
        <p role="alert">{t(REPORT_REFUSAL_MESSAGE_KEYS[report.error], lang)}</p>
      )}
      <p>
        <a href="/">{t('reports.back', lang)}</a>
      </p>
    </main>
  );
}