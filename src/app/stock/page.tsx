import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '../../auth/cookie';
import { configuredTenantId } from '../../auth/tenant';
import { StockListScreen } from '../../components/StockListScreen';
import { getAppPool } from '../../db/app-pool';
import { withTenant } from '../../db/client';
import { t } from '../../i18n';
import { SIGN_IN_PATH } from '../sign-in/contract';
import { STOCK_REFUSAL_MESSAGE_KEYS, listStock } from './handler';

export const metadata = { title: t('stock.title') };

/**
 * THE STOCK LIST — "what do we have, where, how many".
 *
 * THE GATE IS HERE, AND IT IS THE SAME GATE AS EVERYWHERE ELSE. The session
 * cookie is resolved by `listStock` inside ONE `withTenant` boundary (the app's
 * own pool — `await getAppPool()`, which refuses to serve as a superuser — scoped
 * to the deployment's tenant). The page never opens a second boundary;
 * `withTenant` is not re-entrant.
 *
 * THE SCOPING IS THE SERVER'S. A `branch_user` is filtered to their OWN branch in
 * the QUERY (see handler.ts), so another branch's stock never leaves the
 * database — the markup is not a permission. A viewer who may see no stock gets
 * the refusal and NO stock was read for them at all.
 *
 * SEARCH IS SERVER-SIDE and BOUNDED. The needle comes from `?q=` (the GET form's
 * `q`), is passed into the query, and the list is capped — so typing cannot pull
 * an unbounded catalogue into a phone. Reading `searchParams` and a cookie makes
 * this page dynamic, which is the point.
 *
 * The page is Arabic and RIGHT-TO-LEFT (`dir="rtl"`, inherited from the root
 * layout and stated here so the screen stands alone).
 */
export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const sp = await searchParams;
  const search = typeof sp.q === 'string' ? sp.q : '';

  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const list = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    listStock(db, cookie, { search }),
  );

  if (!list.user) redirect(SIGN_IN_PATH);

  return (
    <main dir="rtl">
      <h1>{t('stock.title')}</h1>
      {list.maySee ? (
        <>
          <p>{t('stock.subtitle')}</p>
          <StockListScreen
            rows={list.rows}
            search={list.search}
            truncated={list.truncated}
            branchLabel={list.branchLabel}
          />
        </>
      ) : (
        <p role="alert">{t(STOCK_REFUSAL_MESSAGE_KEYS.forbidden)}</p>
      )}
      <p>
        <a href="/">{t('stock.back')}</a>
      </p>
    </main>
  );
}
