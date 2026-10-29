import type { MovementDetail } from '@/modules/branch-usage/index';
import { REASON_MESSAGE_KEYS } from '../domain/movement';
import { formatDate, formatNumber, t, type Lang } from '@/i18n';
import { getRequestLang } from '@/i18n/request';
import type { StockRowView } from '@/app/stock/handler';

/**
 * THE "WHERE DID IT GO" SCREEN — one item's balance per location and its FULL
 * movement history: reason, from, to, ACTOR and time, newest first.
 *
 * A READ-ONLY server component (no state, no action). It answers the owner's
 * question literally: what do we have, where, how many, who took it, and when.
 *
 * The language is read once (`getRequestLang`) and threaded through every label,
 * reason, date and number, so English renders English month names and copy.
 */
export interface StockHistoryScreenProps {
  sku: string;
  nameAr: string;
  onHand: StockRowView[];
  movements: MovementDetail[];
  /** True when more movements exist beyond the bound shown. */
  truncated: boolean;
  branchLabel: string | null;
}

/** The translated label for a movement reason — never the raw enum value. */
export function reasonLabel(reason: string, lang: Lang): string {
  const key = REASON_MESSAGE_KEYS[reason as keyof typeof REASON_MESSAGE_KEYS];
  return key ? t(key, lang) : reason;
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
    <div className="stock">
      <p className="stock-variant">
        <span className="stock-name">{nameAr}</span>{' '}
        <span className="ltr-value stock-sku">{sku}</span>
      </p>
      {branchLabel ? (
        <p className="stock-scope">{t('stock.scope.branch', { lang, params: { name: branchLabel } })}</p>
      ) : null}

      <section className="stock-section">
        <h2>{t('stock.detail.onhand', lang)}</h2>
        {onHand.length === 0 ? (
          <p className="field-hint">{t('stock.detail.onhand_empty', lang)}</p>
        ) : (
          <ul className="stock-list">
            {onHand.map((row) => (
              <li key={row.location} className="stock-balance">
                <span className="stock-location">{row.location}</span>
                <span className="stock-qty">
                  {t('stock.col.qty', lang)}: {formatNumber(Number(row.qty), lang)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="stock-section">
        <h2>{t('stock.detail.movements', lang)}</h2>
        {movements.length === 0 ? (
          <p className="field-hint">{t('stock.detail.empty_movements', lang)}</p>
        ) : (
          <ol className="stock-movements">
            {movements.map((m) => (
              <li key={m.seq} className="stock-movement">
                <div className="stock-movement-head">
                  <span className="stock-reason">{reasonLabel(m.reason, lang)}</span>
                  <span className="stock-qty">
                    {t('stock.movement.qty', lang)}: {formatNumber(Number(m.qty), lang)}
                  </span>
                </div>
                <dl className="stock-movement-detail">
                  <div className="stock-movement-pair">
                    <dt>{t('stock.movement.from', lang)}</dt>
                    <dd className="stock-location">{m.fromLocation ?? t('stock.none', lang)}</dd>
                  </div>
                  <div className="stock-movement-pair">
                    <dt>{t('stock.movement.to', lang)}</dt>
                    <dd className="stock-location">{m.toLocation ?? t('stock.none', lang)}</dd>
                  </div>
                  <div className="stock-movement-pair">
                    <dt>{t('stock.movement.actor', lang)}</dt>
                    <dd className="stock-actor">{m.actorName ?? t('stock.actor.system', lang)}</dd>
                  </div>
                  <div className="stock-movement-pair">
                    <dt>{t('stock.movement.at', lang)}</dt>
                    <dd className="stock-at">{formatDate(new Date(m.occurredAt), lang)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        )}
        {truncated ? (
          <p className="stock-truncated" role="status">
            {t('stock.detail.truncated', { lang, params: { count: formatNumber(movements.length, lang) } })}
          </p>
        ) : null}
      </section>
    </div>
  );
}