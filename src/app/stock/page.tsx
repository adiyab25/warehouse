import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/modules/auth/schema';
import { configuredTenantId } from '@/modules/auth/index';
import { StockListScreen } from '@/modules/ledger/ui/StockListScreen';
import { getAppPool } from '@/modules/platform/index';
import { withTenant } from '@/modules/platform/index';
import { t } from '../../i18n';
import { getRequestLang } from '../../i18n/request';
import { SIGN_IN_PATH } from '../(auth)/sign-in/contract';
import { STOCK_REFUSAL_MESSAGE_KEYS, listStock } from './handler';

export async function generateMetadata() {
  const lang = await getRequestLang();
  return { title: t('stock.title', lang) };
}

/**
 * THE STOCK LIST — "what do we have, where, how many".
 *
 * The session cookie is resolved by `listStock` inside ONE `withTenant` boundary.
 * A `branch_user` is filtered to their OWN branch in the QUERY, so another
 * branch's stock never leaves the database. Search is server-side and bounded.
 */
export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const lang = await getRequestLang();
  const sp = await searchParams;
  const search = typeof sp.q === 'string' ? sp.q : '';

  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const list = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    listStock(db, cookie, { search }),
  );

  if (!list.user) redirect(SIGN_IN_PATH);

  return (
    <main>
      <h1>{t('stock.title', lang)}</h1>
      {list.maySee ? (
        <>
          <p>{t('stock.subtitle', lang)}</p>
          <StockListScreen
            rows={list.rows}
            search={list.search}
            truncated={list.truncated}
            branchLabel={list.branchLabel}
          />
        </>
      ) : (
        <p role="alert">{t(STOCK_REFUSAL_MESSAGE_KEYS.forbidden, lang)}</p>
      )}
      <p>
        <a href="/">{t('stock.back', lang)}</a>
      </p>
    </main>
  );
}