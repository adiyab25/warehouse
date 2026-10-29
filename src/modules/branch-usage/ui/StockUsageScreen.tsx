import type { UsageRow } from '../server/usage';
import { formatCurrency, formatNumber, t } from '@/i18n';
import { getRequestLang } from '@/i18n/request';
import { PageHeader } from '@/modules/shell/ui/PageHeader';
import { DataTable } from '@/modules/shell/ui/DataTable';
import { EmptyState } from '@/modules/shell/ui/EmptyState';
import { FilterBar } from '@/modules/shell/ui/FilterBar';

/**
 * THE ACCOUNTS VIEW — usage and value by branch, for a date window.
 */
export interface StockUsageScreenProps {
  from: string;
  to: string;
  rows: UsageRow[];
  totalEgp: string;
  truncated: boolean;
}

export async function StockUsageScreen({ from, to, rows, totalEgp, truncated }: StockUsageScreenProps) {
  const lang = await getRequestLang();
  return (
    <div className="space-y-4">
      <PageHeader title={t('stock.usage.heading', lang)} subtitle={t('stock.usage.subtitle', lang)} />

      <p className="text-sm text-muted-foreground">{t('stock.usage.cost_note', lang)}</p>
      <p className="text-sm text-muted-foreground">{t('stock.usage.transit_note', lang)}</p>

      <FilterBar>
        <form className="flex w-full flex-wrap items-end gap-2" method="get" action="/stock/usage">
          <div className="flex flex-col gap-1">
            <label htmlFor="usage-from" className="text-sm">{t('stock.usage.from', lang)}</label>
            <input id="usage-from" name="from" type="date" defaultValue={from} className="ltr-value h-10 rounded-md border px-3" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="usage-to" className="text-sm">{t('stock.usage.to', lang)}</label>
            <input id="usage-to" name="to" type="date" defaultValue={to} className="ltr-value h-10 rounded-md border px-3" />
          </div>
          <button type="submit" className="h-10 rounded-md bg-primary px-4 text-primary-foreground">
            {t('stock.usage.submit', lang)}
          </button>
        </form>
      </FilterBar>

      <p className="text-sm text-muted-foreground">{t('stock.usage.window', { lang, params: { from, to } })}</p>

      {rows.length === 0 ? (
        <EmptyState title={t('stock.usage.empty', lang)} />
      ) : (
        <DataTable
          data={rows as any}
          columns={[
            {
              key: 'item',
              header: t('stock.col.item', lang),
              render: (row: UsageRow) => (
                <span>
                  <span className="font-medium">{row.nameAr}</span>
                  <span className="ltr-value ml-2 text-xs text-muted-foreground">{row.sku}</span>
                </span>
              ),
            },
            { key: 'branch', header: t('stock.col.location', lang), render: (row: UsageRow) => row.branch },
            { key: 'qty', header: t('stock.usage.qty', lang), render: (row: UsageRow) => formatNumber(Number(row.issuedQty), lang) },
            { key: 'value', header: t('stock.col.value', lang), render: (row: UsageRow) => formatCurrency(Number(row.valueEgp), lang) },
          ]}
        />
      )}

      <p className="text-sm font-medium">
        <span>{t('stock.usage.total', lang)}: </span>
        <span className="stock-value">{formatCurrency(Number(totalEgp), lang)}</span>
      </p>

      {truncated ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('stock.usage.truncated', { lang, params: { count: formatNumber(rows.length, lang) } })}
        </p>
      ) : null}
    </div>
  );
}