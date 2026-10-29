import { formatNumber, t } from '@/i18n';
import { getRequestLang } from '@/i18n/request';
import type { StockRowView } from '@/app/stock/handler';

/**
 * THE STOCK LIST — "what do we have, where, how many".
 *
 * A READ-ONLY screen, so it is a SERVER component: there is no state to hold, no
 * action to post, and the search is a plain GET form (`?q=`), which works on the
 * cheapest phone without JavaScript. Every row links to its variant's history —
 * the "where did it go" answer.
 *
 * The language is read once (`getRequestLang`) and threaded through every label
 * and number, so the screen renders Arabic/RTL or English/LTR with the rest of
 * the app. A machine-read SKU keeps `.ltr-value`.
 */
export interface StockListScreenProps {
  rows: StockRowView[];
  /** The needle the viewer searched for, echoed back into the form. */
  search: string;
  /** True when more rows exist beyond the bound the screen shows. */
  truncated: boolean;
  /** The branch a branch viewer is confined to, or `null` for the network. */
  branchLabel: string | null;
}

export async function StockListScreen({ rows, search, truncated, branchLabel }: StockListScreenProps) {
  const lang = await getRequestLang();
  return (
    <div className="stock">
      {branchLabel ? (
        <p className="stock-scope">{t('stock.scope.branch', { lang, params: { name: branchLabel } })}</p>
      ) : null}

      {/* Search by name or by SKU. A GET form, so it is server-side and works
          with no JavaScript; the field holds a machine-read code, so it stays
          LEFT-TO-RIGHT (`.ltr-value`). */}
      <form className="stock-search" method="get" action="/stock">
        <label htmlFor="stock-q">{t('stock.search.label', lang)}</label>
        <input
          id="stock-q"
          name="q"
          type="search"
          defaultValue={search}
          placeholder={t('stock.search.placeholder', lang)}
          className="ltr-value"
          autoComplete="off"
        />
        <button type="submit">{t('stock.search.submit', lang)}</button>
        {search !== '' ? (
          <a className="stock-clear" href="/stock">
            {t('stock.search.clear', lang)}
          </a>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="field-hint">{t('stock.list.empty', lang)}</p>
      ) : (
        <ul className="stock-list">
          {rows.map((row) => (
            <li key={`${row.variantId}:${row.location}`} className="stock-item">
              <a className="stock-link" href={`/stock/${row.variantId}`}>
                <span className="stock-line-head">
                  <span className="stock-name">{row.nameAr}</span>
                  <span className="ltr-value stock-sku">{row.sku}</span>
                </span>
                <span className="stock-line-meta">
                  <span className="stock-location">{row.location}</span>
                  <span className="stock-qty">
                    {t('stock.col.qty', lang)}: {formatNumber(Number(row.qty), lang)}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {truncated ? (
        <p className="stock-truncated" role="status">
          {t('stock.list.truncated', { lang, params: { count: formatNumber(rows.length, lang) } })}
        </p>
      ) : null}
    </div>
  );
}