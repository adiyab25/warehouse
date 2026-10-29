import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/modules/auth/domain/cookie';
import { configuredTenantId } from '@/modules/auth/index';
import { StockUsageScreen } from '@/modules/branch-usage/ui/StockUsageScreen';
import { getAppPool } from '@/modules/platform/index';
import { withTenant } from '@/modules/platform/index';
import { t } from '../../../i18n';
import { getRequestLang } from '../../../i18n/request';
import { SIGN_IN_PATH } from '../../(auth)/sign-in/contract';
import { STOCK_REFUSAL_MESSAGE_KEYS, getUsageReport, monthWindow } from '../handler';

export async function generateMetadata() {
  const lang = await getRequestLang();
  return { title: t('stock.usage.heading', lang) };
}

/**
 * THE ACCOUNTS VIEW — usage and value by branch (the financials role).
 *
 * Only `owner` and `warehouse_manager` may read a WHOLE-NETWORK money figure; a
 * `branch_user` is refused SERVER-SIDE. The window is explicit in the URL: when
 * `from`/`to` are absent the page REDIRECTS to this route with the default (THIS
 * MONTH) spelled out. `withTenant` is opened exactly once, here.
 */
export default async function StockUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  const lang = await getRequestLang();
  const sp = await searchParams;
  const from = typeof sp.from === 'string' ? sp.from : '';
  const to = typeof sp.to === 'string' ? sp.to : '';

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
    <main>
      <h1>{t('stock.usage.heading', lang)}</h1>
      {report.ok ? (
        <StockUsageScreen
          from={report.from}
          to={report.to}
          rows={report.rows}
          totalEgp={report.totalEgp}
          truncated={report.truncated}
        />
      ) : (
        <p role="alert">{t(STOCK_REFUSAL_MESSAGE_KEYS[report.error], lang)}</p>
      )}
      <p className="stock-usage-note">{t('stock.usage.default_window', lang)}</p>
      <p>
        <a href="/stock">{t('stock.detail.back', lang)}</a>
      </p>
    </main>
  );
}