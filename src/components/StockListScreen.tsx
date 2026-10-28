import { formatNumber, t } from '../i18n';
import type { StockRowView } from '../app/stock/handler';

/**
 * THE STOCK LIST — "what do we have, where, how many".
 *
 * A READ-ONLY screen, so it is a SERVER component: there is no state to hold, no
 * action to post, and the search is a plain GET form (`?q=`), which works on the
 * cheapest phone without JavaScript. Every row links to its variant's history —
 * the "where did it go" answer.
 *
 * The document is Arabic and RTL (inherited from the root layout and stated here
 * so the screen stands alone); a machine-read SKU keeps `.ltr-value`. Every
 * quantity goes through the Task 11 formatter, so an `ar` screen shows Latin
 * digits that match the ledger, and every catalogue string carries the width
 * budget the two earlier overflow bugs paid for (`min-width: 0` +
 * `overflow-wrap: anywhere`, in globals.css).
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

export function StockListScreen({ rows, search, truncated, branchLabel }: StockListScreenProps) {
  return (
    <div className="stock">
      {branchLabel ? (
        <p className="stock-scope">{t('stock.scope.branch', { params: { name: branchLabel } })}</p>
      ) : null}

      {/* Search by name or by SKU. A GET form, so it is server-side and works
          with no JavaScript; the field holds a machine-read code, so it stays
          LEFT-TO-RIGHT (`.ltr-value`). */}
      <form className="stock-search" method="get" action="/stock" dir="rtl">
        <label htmlFor="stock-q">{t('stock.search.label')}</label>
        <input
          id="stock-q"
          name="q"
          type="search"
          defaultValue={search}
          placeholder={t('stock.search.placeholder')}
          className="ltr-value"
          autoComplete="off"
        />
        <button type="submit">{t('stock.search.submit')}</button>
        {search !== '' ? (
          <a className="stock-clear" href="/stock">
            {t('stock.search.clear')}
          </a>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="field-hint">{t('stock.list.empty')}</p>
      ) : (
        <ul className="stock-list">
          {rows.map((row) => (
            <li key={`${row.variantId}:${row.location}`} className="stock-item">
              <a className="stock-link" href={`/stock/${row.variantId}`}>
                <span className="stock-line-head">
                  {/* The item's Arabic name: a right-to-left catalogue string in a
                      fixed column — allowed to shrink and to BREAK a long
                      unbroken token (see globals.css). */}
                  <span className="stock-name">{row.nameAr}</span>
                  <span className="ltr-value stock-sku">{row.sku}</span>
                </span>
                <span className="stock-line-meta">
                  <span className="stock-location">{row.location}</span>
                  <span className="stock-qty">
                    {t('stock.col.qty')}: {formatNumber(Number(row.qty))}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {truncated ? (
        <p className="stock-truncated" role="status">
          {t('stock.list.truncated', { params: { count: formatNumber(rows.length) } })}
        </p>
      ) : null}
    </div>
  );
}
