import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/modules/auth/schema';
import { configuredTenantId } from '@/modules/auth/index';
import { StockHistoryScreen } from '@/modules/ledger/ui/StockHistoryScreen';
import { getAppPool } from '@/modules/platform/index';
import { withTenant } from '@/modules/platform/index';
import { t } from '../../../i18n';
import { getRequestLang } from '../../../i18n/request';
import { SIGN_IN_PATH } from '../../(auth)/sign-in/contract';
import { STOCK_REFUSAL_MESSAGE_KEYS, getVariantHistory } from '../handler';

export async function generateMetadata() {
  const lang = await getRequestLang();
  return { title: t('stock.detail.heading', lang) };
}

/**
 * ONE ITEM'S STORY — its balance per location and its full movement history.
 *
 * The session is resolved by `getVariantHistory` inside ONE `withTenant`
 * boundary, and the SAME read decides whether this viewer may open this item at
 * all: a `branch_user` is refused a variant their branch does not hold, and the
 * refusal is the SAME code a missing id gets. Next 16 hands params as a PROMISE.
 */
export default async function StockVariantPage({
  params,
}: {
  params: Promise<{ variantId: string }>;
}) {
  const lang = await getRequestLang();
  const { variantId } = await params;

  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const detail = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    getVariantHistory(db, cookie, variantId),
  );

  if (!detail.ok && detail.error === 'unauthenticated') redirect(SIGN_IN_PATH);

  return (
    <main>
      <h1>{t('stock.detail.heading', lang)}</h1>
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
        <p role="alert">{t(STOCK_REFUSAL_MESSAGE_KEYS[detail.error], lang)}</p>
      )}
      <p>
        <a href="/stock">{t('stock.detail.back', lang)}</a>
      </p>
    </main>
  );
}