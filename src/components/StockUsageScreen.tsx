import type { UsageRow } from '../db/usage';
import { formatCurrency, formatNumber, t } from '../i18n';

/**
 * THE ACCOUNTS VIEW — usage and value by branch, for a date window.
 *
 * A READ-ONLY server component (no state, no action): the window is a plain GET
 * form (`?from=&to=`), which works on the cheapest phone without JavaScript and
 * makes the window EXPLICIT in the URL so a report can be shared.
 *
 * Three rules it is built to honour:
 *
 *   * MONEY IS A COST FIGURE, LABELLED AS ONE. Every value goes through
 *     {@link formatCurrency} (EGP, Latin digits) — never `Number()` for
 *     arithmetic; the number is formatted only, and the exact string came from
 *     the database (`sum(qty * cost_egp)::numeric(12,2)`). The screen STATES that
 *     this is cost, not a selling price, so an owner does not read it as revenue.
 *   * EVERY CATALOGUE STRING carries the width budget the earlier overflow bugs
 *     paid for (`min-width: 0` + `overflow-wrap: anywhere`, in globals.css), so
 *     a long Arabic name or SKU cannot blow a 390px phone.
 *   * THE TOTAL IS SHOWN and is the database's own sum, not a JS sum of the
 *     formatted rows.
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

export function StockUsageScreen({ from, to, rows, totalEgp, truncated }: StockUsageScreenProps) {
  return (
    <div className="stock-usage">
      <p className="stock-usage-note">{t('stock.usage.subtitle')}</p>
      <p className="stock-usage-note">{t('stock.usage.cost_note')}</p>
      {/* Goods still in flight are NOT part of the branch total — stated on the
          screen so an owner reading the money figure knows what it excludes. */}
      <p className="stock-usage-note">{t('stock.usage.transit_note')}</p>

      {/* The window is a GET form, so it is server-side, shareable, and works
          with no JavaScript. The dates are machine values, so they stay
          LEFT-TO-RIGHT (`.ltr-value`). */}
      <form className="stock-search" method="get" action="/stock/usage" dir="rtl">
        <label htmlFor="usage-from">{t('stock.usage.from')}</label>
        <input id="usage-from" name="from" type="date" defaultValue={from} className="ltr-value" />
        <label htmlFor="usage-to">{t('stock.usage.to')}</label>
        <input id="usage-to" name="to" type="date" defaultValue={to} className="ltr-value" />
        <button type="submit">{t('stock.usage.submit')}</button>
      </form>

      <p className="stock-usage-window">
        {t('stock.usage.window', { params: { from, to } })}
      </p>

      {rows.length === 0 ? (
        <p className="field-hint">{t('stock.usage.empty')}</p>
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
                  {t('stock.usage.qty')}: {formatNumber(Number(row.issuedQty))}
                </span>
                {/* The value is a COST, formatted from the exact numeric string. */}
                <span className="stock-value">
                  {t('stock.col.value')}: {formatCurrency(Number(row.valueEgp))}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* The TOTAL is the database's own sum (`sum(...)::numeric(12,2)`), never
          a JS sum of the rows above. */}
      <p className="stock-usage-total">
        <span>{t('stock.usage.total')}</span>
        <span className="stock-value">{formatCurrency(Number(totalEgp))}</span>
      </p>

      {truncated ? (
        <p className="stock-truncated" role="status">
          {t('stock.usage.truncated', { params: { count: formatNumber(rows.length) } })}
        </p>
      ) : null}
    </div>
  );
}
