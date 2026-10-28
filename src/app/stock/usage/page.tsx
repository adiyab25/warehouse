import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '../../../auth/cookie';
import { configuredTenantId } from '../../../auth/tenant';
import { StockUsageScreen } from '../../../components/StockUsageScreen';
import { getAppPool } from '../../../db/app-pool';
import { withTenant } from '../../../db/client';
import { t } from '../../../i18n';
import { SIGN_IN_PATH } from '../../sign-in/contract';
import { STOCK_REFUSAL_MESSAGE_KEYS, getUsageReport, monthWindow } from '../handler';

export const metadata = { title: t('stock.usage.heading') };

/**
 * THE ACCOUNTS VIEW — usage and value by branch (the financials role).
 *
 * The session is resolved by `getUsageReport` inside ONE `withTenant` boundary,
 * and the SAME read is the gate: only `owner` and `warehouse_manager` may read
 * a WHOLE-NETWORK money figure, and a `branch_user` is refused SERVER-SIDE
 * (there is no branch-scoped variant — money across the network is not a
 * branch-level fact).
 *
 * THE WINDOW IS EXPLICIT IN THE URL. When `from`/`to` are absent the page
 * REDIRECTS to this same route with the default (THIS MONTH) spelled out, so a
 * report is shareable and a later reader sees exactly which window produced the
 * figure. The default itself is stated on the screen.
 *
 * `withTenant` is opened exactly once, here.
 */
export default async function StockUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  const sp = await searchParams;
  const from = typeof sp.from === 'string' ? sp.from : '';
  const to = typeof sp.to === 'string' ? sp.to : '';

  // Make the window explicit in the URL, so the page can be shared/bookmarked.
  // `redirect` throws, so it is deliberately outside any try/catch.
  if (from === '' || to === '') {
    const w = monthWindow();
    redirect(`/stock/usage?from=${w.from}&to=${w.to}`);
  }

  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const report = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    getUsageReport(db, cookie, { from, to }),
  );

  if (!report.ok && report.error === 'unauthenticated') redirect(SIGN_IN_PATH);

  return (
    <main dir="rtl">
      <h1>{t('stock.usage.heading')}</h1>
      {report.ok ? (
        <StockUsageScreen
          from={report.from}
          to={report.to}
          rows={report.rows}
          totalEgp={report.totalEgp}
          truncated={report.truncated}
        />
      ) : (
        <p role="alert">{t(STOCK_REFUSAL_MESSAGE_KEYS[report.error])}</p>
      )}
      <p className="stock-usage-note">{t('stock.usage.default_window')}</p>
      <p>
        <a href="/stock">{t('stock.detail.back')}</a>
      </p>
    </main>
  );
}
