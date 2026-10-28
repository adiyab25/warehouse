import type { UsageRow } from '../db/usage';
import { formatCurrency, formatNumber, t } from '../i18n';
import { getRequestLang } from '../i18n/request';

/**
 * THE ACCOUNTS VIEW — usage and value by branch, for a date window.
 *
 * A READ-ONLY server component (no state, no action): the window is a plain GET
 * form (`?from=&to=`), which works on the cheapest phone without JavaScript and
 * makes the window EXPLICIT in the URL so a report can be shared.
 *
 * The language is read once (`getRequestLang`) and threaded through every label,
 * number, date and money amount, so English renders with English month names,
 * the EGP symbol in the English form, and English copy.
 */
export interface StockUsageScreenProps {
  /** The window actually run (echoed so the screen states it). */
  from: string;
  to: string;
  rows: UsageRow[];
  /** The exact `numeric(12,2)` total string from SQL. */
  totalEgp: string;
  /** True when more rows exist beyond the bound shown. */
  truncated: boolean;
}

export async function StockUsageScreen({ from, to, rows, totalEgp, truncated }: StockUsageScreenProps) {
  const lang = await getRequestLang();
  return (
    <div className="stock-usage">
      <p className="stock-usage-note">{t('stock.usage.subtitle', lang)}</p>
      <p className="stock-usage-note">{t('stock.usage.cost_note', lang)}</p>
      <p className="stock-usage-note">{t('stock.usage.transit_note', lang)}</p>

      {/* The window is a GET form, so it is server-side, shareable, and works
          with no JavaScript. The dates are machine values, so they stay
          LEFT-TO-RIGHT (`.ltr-value`). */}
      <form className="stock-search" method="get" action="/stock/usage">
        <label htmlFor="usage-from">{t('stock.usage.from', lang)}</label>
        <input id="usage-from" name="from" type="date" defaultValue={from} className="ltr-value" />
        <label htmlFor="usage-to">{t('stock.usage.to', lang)}</label>
        <input id="usage-to" name="to" type="date" defaultValue={to} className="ltr-value" />
        <button type="submit">{t('stock.usage.submit', lang)}</button>
      </form>

      <p className="stock-usage-window">{t('stock.usage.window', { lang, params: { from, to } })}</p>

      {rows.length === 0 ? (
        <p className="field-hint">{t('stock.usage.empty', lang)}</p>
      ) : (
        <ul className="stock-list">
          {rows.map((row) => (
            <li key={`${row.branch}:${row.variantId}`} className="stock-item stock-usage-item">
              <span className="stock-usage-head">
                <span className="stock-name">{row.nameAr}</span>
                <span className="ltr-value stock-sku">{row.sku}</span>
              </span>
              <span className="stock-usage-meta">
                <span className="stock-location">{row.branch}</span>
                <span className="stock-qty">
                  {t('stock.usage.qty', lang)}: {formatNumber(Number(row.issuedQty), lang)}
                </span>
                <span className="stock-value">
                  {t('stock.col.value', lang)}: {formatCurrency(Number(row.valueEgp), lang)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* The TOTAL is the database's own sum (`sum(...)::numeric(12,2)`), never
          a JS sum of the rows above. */}
      <p className="stock-usage-total">
        <span>{t('stock.usage.total', lang)}</span>
        <span className="stock-value">{formatCurrency(Number(totalEgp), lang)}</span>
      </p>

      {truncated ? (
        <p className="stock-truncated" role="status">
          {t('stock.usage.truncated', { lang, params: { count: formatNumber(rows.length, lang) } })}
        </p>
      ) : null}
    </div>
  );
}