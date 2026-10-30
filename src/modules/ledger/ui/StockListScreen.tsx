import { formatNumber, t } from '@/i18n';
import { getRequestLang } from '@/i18n/request';
import type { StockRowView } from '@/app/stock/handler';
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
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left p-2">{t('stock.col.item', lang)}</th>
              <th className="text-left p-2">{t('stock.col.location', lang)}</th>
              <th className="text-left p-2">{t('stock.col.qty', lang)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
                          <tr key={row.variantId + '-' + row.location + '-' + i} className="border-t">
                <td className="p-2">
                  <a className="text-primary" href={`/stock/${row.variantId}`}>
                    <span className="font-medium">{row.nameAr}</span>
                    <span className="ltr-value ml-2 text-xs text-muted-foreground">{row.sku}</span>
                  </a>
                </td>
                <td className="p-2">{row.location}</td>
                <td className="p-2">{formatNumber(Number(row.qty), lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {truncated ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('stock.list.truncated', { lang, params: { count: formatNumber(rows.length, lang) } })}
        </p>
      ) : null}
    </div>
  );
}
