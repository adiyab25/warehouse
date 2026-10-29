import { formatNumber, t } from '@/i18n';
import { getRequestLang } from '@/i18n/request';
import type { StockRowView } from '@/app/stock/handler';
import { DataTable } from '@/modules/shell/ui/DataTable';
import { EmptyState } from '@/modules/shell/ui/EmptyState';
import { FilterBar } from '@/modules/shell/ui/FilterBar';

export interface StockListScreenProps {
  rows: StockRowView[];
  search: string;
  truncated: boolean;
  branchLabel: string | null;
}

export async function StockListScreen({ rows, search, truncated, branchLabel }: StockListScreenProps) {
  const lang = await getRequestLang();
  return (
    <div className="space-y-4">
      {branchLabel ? (
        <p className="text-sm text-muted-foreground">{t('stock.scope.branch', { lang, params: { name: branchLabel } })}</p>
      ) : null}

      <FilterBar>
        <form className="flex w-full items-center gap-2" method="get" action="/stock">
          <label htmlFor="stock-q" className="sr-only">{t('stock.search.label', lang)}</label>
          <input
            id="stock-q"
            name="q"
            type="search"
            defaultValue={search}
            placeholder={t('stock.search.placeholder', lang)}
            className="ltr-value h-10 flex-1 rounded-md border px-3"
            autoComplete="off"
          />
          <button type="submit" className="h-10 rounded-md bg-primary px-4 text-primary-foreground">
            {t('stock.search.submit', lang)}
          </button>
          {search !== '' ? (
            <a className="text-sm text-primary" href="/stock">
              {t('stock.search.clear', lang)}
            </a>
          ) : null}
        </form>
      </FilterBar>

      {rows.length === 0 ? (
        <EmptyState title={t('stock.list.empty', lang)} />
      ) : (
        <DataTable
          data={rows as any}
          columns={[
            {
              key: 'item',
              header: t('stock.col.item', lang),
              render: (row: StockRowView) => (
                <a className="text-primary" href={`/stock/${row.variantId}`}>
                  <span className="font-medium">{row.nameAr}</span>
                  <span className="ltr-value ml-2 text-xs text-muted-foreground">{row.sku}</span>
                </a>
              ),
            },
            { key: 'location', header: t('stock.col.location', lang), render: (row: StockRowView) => row.location },
            { key: 'qty', header: t('stock.col.qty', lang), render: (row: StockRowView) => formatNumber(Number(row.qty), lang) },
          ]}
        />
      )}

      {truncated ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('stock.list.truncated', { lang, params: { count: formatNumber(rows.length, lang) } })}
        </p>
      ) : null}
    </div>
  );
}
