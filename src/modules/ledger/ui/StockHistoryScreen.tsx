import type { MovementDetail } from '@/modules/branch-usage/index';
import { REASON_MESSAGE_KEYS } from '../domain/movement';
import { formatDate, formatNumber, t, type Lang } from '@/i18n';
import { getRequestLang } from '@/i18n/request';
import type { StockRowView } from '@/app/stock/handler';
import { DataTable } from '@/modules/shell/ui/DataTable';
import { EmptyState } from '@/modules/shell/ui/EmptyState';
import { FilterBar } from '@/modules/shell/ui/FilterBar';
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
          <DataTable
            data={onHand as any}
            columns={[
              { key: 'location', header: t('stock.col.location', lang), render: (row: StockRowView) => row.location },
              { key: 'qty', header: t('stock.col.qty', lang), render: (row: StockRowView) => formatNumber(Number(row.qty), lang) },
            ]}
          />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('stock.detail.movements', lang)}</h2>
        {movements.length === 0 ? (
          <EmptyState title={t('stock.detail.empty_movements', lang)} />
        ) : (
          <FilterBar>
            <DataTable
              data={movements as any}
              columns={[
                { key: 'reason', header: t('stock.movement.reason', lang) ?? 'Reason', render: (m: MovementDetail) => reasonLabel(m.reason, lang) },
                { key: 'qty', header: t('stock.movement.qty', lang), render: (m: MovementDetail) => formatNumber(Number(m.qty), lang) },
                { key: 'from', header: t('stock.movement.from', lang), render: (m: MovementDetail) => m.fromLocation ?? t('stock.none', lang) },
                { key: 'to', header: t('stock.movement.to', lang), render: (m: MovementDetail) => m.toLocation ?? t('stock.none', lang) },
                { key: 'actor', header: t('stock.movement.actor', lang), render: (m: MovementDetail) => m.actorName ?? t('stock.actor.system', lang) },
                { key: 'at', header: t('stock.movement.at', lang), render: (m: MovementDetail) => formatDate(new Date(m.occurredAt), lang) },
              ]}
            />
          </FilterBar>
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
