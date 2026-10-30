import type { MovementDetail } from '@/modules/branch-usage/index';
import { REASON_MESSAGE_KEYS } from '../schema';
import { formatDate, formatNumber, t, type Lang } from '@/i18n';
import { getRequestLang } from '@/i18n/request';
import type { StockRowView } from '@/app/stock/handler';
import { EmptyState } from '@/modules/shell/ui/EmptyState';
import { PageHeader } from '@/modules/shell/ui/PageHeader';

/** The translated label for a movement reason — never the raw enum value. */
export function reasonLabel(reason: string, lang: Lang): string {
  const key = REASON_MESSAGE_KEYS[reason as keyof typeof REASON_MESSAGE_KEYS];
  return key ? t(key, lang) : reason;
}

export interface StockHistoryScreenProps {
  sku: string;
  nameAr: string;
  onHand: StockRowView[];
  movements: MovementDetail[];
  /** True when more movements exist beyond the bound shown. */
  truncated: boolean;
  branchLabel: string | null;
}

export async function StockHistoryScreen({
  sku,
  nameAr,
  onHand,
  movements,
  truncated,
  branchLabel,
}: StockHistoryScreenProps) {
  const lang = await getRequestLang();
  return (
    <div className="space-y-4">
      <PageHeader title={nameAr} subtitle={sku} />
      {branchLabel ? (
        <p className="text-sm text-muted-foreground">{t('stock.scope.branch', { lang, params: { name: branchLabel } })}</p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('stock.detail.onhand', lang)}</h2>
        {onHand.length === 0 ? (
          <EmptyState title={t('stock.detail.onhand_empty', lang)} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left p-2">{t('stock.col.location', lang)}</th>
                <th className="text-left p-2">{t('stock.col.qty', lang)}</th>
              </tr>
            </thead>
            <tbody>
              {onHand.map((row) => (
                <tr key={row.variantId + row.location} className="border-t">
                  <td className="p-2">{row.location}</td>
                  <td className="p-2">{formatNumber(Number(row.qty), lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('stock.detail.movements', lang)}</h2>
        {movements.length === 0 ? (
          <EmptyState title={t('stock.detail.empty_movements', lang)} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left p-2">{t('stock.movement.reason', lang) ?? 'Reason'}</th>
                <th className="text-left p-2">{t('stock.movement.qty', lang)}</th>
                <th className="text-left p-2">{t('stock.movement.from', lang)}</th>
                <th className="text-left p-2">{t('stock.movement.to', lang)}</th>
                <th className="text-left p-2">{t('stock.movement.actor', lang)}</th>
                <th className="text-left p-2">{t('stock.movement.at', lang)}</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m, i) => (
                <tr key={i} className="border-t">
                  <td className="p-2">{reasonLabel(m.reason, lang)}</td>
                  <td className="p-2">{formatNumber(Number(m.qty), lang)}</td>
                  <td className="p-2">{m.fromLocation ?? t('stock.none', lang)}</td>
                  <td className="p-2">{m.toLocation ?? t('stock.none', lang)}</td>
                  <td className="p-2">{m.actorName ?? t('stock.actor.system', lang)}</td>
                  <td className="p-2">{formatDate(new Date(m.occurredAt), lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {truncated ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t('stock.detail.truncated', { lang, params: { count: formatNumber(movements.length, lang) } })}
          </p>
        ) : null}
      </section>
    </div>
  );
}
