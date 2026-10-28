import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '../../../auth/cookie';
import { configuredTenantId } from '../../../auth/tenant';
import { StockHistoryScreen } from '../../../components/StockHistoryScreen';
import { getAppPool } from '../../../db/app-pool';
import { withTenant } from '../../../db/client';
import { t } from '../../../i18n';
import { SIGN_IN_PATH } from '../../sign-in/contract';
import { STOCK_REFUSAL_MESSAGE_KEYS, getVariantHistory } from '../handler';

export const metadata = { title: t('stock.detail.heading') };

/**
 * ONE ITEM'S STORY — its balance per location and its full movement history.
 *
 * The session is resolved by `getVariantHistory` inside ONE `withTenant`
 * boundary, and the SAME read decides whether this viewer may open this item at
 * all: a `branch_user` is refused a variant their branch does not hold, and the
 * refusal is the SAME code a missing id gets (so it is not an existence oracle
 * for the network's stock). `withTenant` is opened exactly once, here.
 *
 * Next 16 hands a dynamic route its params as a PROMISE, so they are awaited.
 */
export default async function StockVariantPage({
  params,
}: {
  params: Promise<{ variantId: string }>;
}) {
  const { variantId } = await params;

  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const detail = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    getVariantHistory(db, cookie, variantId),
  );

  if (!detail.ok && detail.error === 'unauthenticated') redirect(SIGN_IN_PATH);

  return (
    <main dir="rtl">
      <h1>{t('stock.detail.heading')}</h1>
      {detail.ok ? (
        <StockHistoryScreen
          sku={detail.sku}
          nameAr={detail.nameAr}
          onHand={detail.onHand}
          movements={detail.movements}
          truncated={detail.truncated}
          branchLabel={detail.branchLabel}
        />
      ) : (
        <p role="alert">{t(STOCK_REFUSAL_MESSAGE_KEYS[detail.error])}</p>
      )}
      <p>
        <a href="/stock">{t('stock.detail.back')}</a>
      </p>
    </main>
  );
}
