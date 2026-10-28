import type { MovementDetail } from '../db/usage';
import { REASON_MESSAGE_KEYS } from '../domain/movement';
import { formatDate, formatNumber, t } from '../i18n';
import type { StockRowView } from '../app/stock/handler';

/**
 * THE "WHERE DID IT GO" SCREEN — one item's balance per location and its FULL
 * movement history: reason, from, to, ACTOR and time, newest first.
 *
 * A READ-ONLY server component (no state, no action). It answers the owner's
 * question literally: what do we have, where, how many, who took it, and when.
 *
 * Three rules it is built to honour:
 *
 *   * THE ADDRESS IS A PLACE AND THE ACTOR IS A PERSON. Locations are shown by
 *     their Arabic NAME and the actor by their display NAME (joined in SQL), so
 *     no raw uuid reaches the screen. A movement with no human actor (a system
 *     correction) says "system" rather than showing a blank.
 *   * THE REASON IS A TRANSLATED LABEL, never a raw enum — every reason goes
 *     through {@link REASON_MESSAGE_KEYS}.
 *   * EVERY NUMBER AND DATE goes through the Task 11 formatters, so an `ar`
 *     screen shows Latin digits that match the ledger, and a quantity is EGP's
 *     only kind of number here.
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
export function reasonLabel(reason: string): string {
  const key = REASON_MESSAGE_KEYS[reason as keyof typeof REASON_MESSAGE_KEYS];
  return key ? t(key) : reason;
}

export function StockHistoryScreen({
  sku,
  nameAr,
  onHand,
  movements,
  truncated,
  branchLabel,
}: StockHistoryScreenProps) {
  return (
    <div className="stock">
      <p className="stock-variant">
        <span className="stock-name">{nameAr}</span>{' '}
        <span className="ltr-value stock-sku">{sku}</span>
      </p>
      {branchLabel ? (
        <p className="stock-scope">{t('stock.scope.branch', { params: { name: branchLabel } })}</p>
      ) : null}

      <section className="stock-section">
        <h2>{t('stock.detail.onhand')}</h2>
        {onHand.length === 0 ? (
          <p className="field-hint">{t('stock.detail.onhand_empty')}</p>
        ) : (
          <ul className="stock-list">
            {onHand.map((row) => (
              <li key={row.location} className="stock-balance">
                <span className="stock-location">{row.location}</span>
                <span className="stock-qty">
                  {t('stock.col.qty')}: {formatNumber(Number(row.qty))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="stock-section">
        <h2>{t('stock.detail.movements')}</h2>
        {movements.length === 0 ? (
          <p className="field-hint">{t('stock.detail.empty_movements')}</p>
        ) : (
          <ol className="stock-movements">
            {movements.map((m) => (
              <li key={m.seq} className="stock-movement">
                <div className="stock-movement-head">
                  <span className="stock-reason">{reasonLabel(m.reason)}</span>
                  <span className="stock-qty">
                    {t('stock.movement.qty')}: {formatNumber(Number(m.qty))}
                  </span>
                </div>
                <dl className="stock-movement-detail">
                  <div className="stock-movement-pair">
                    <dt>{t('stock.movement.from')}</dt>
                    {/* A location shown by its Arabic NAME; a one-sided movement
                        states the missing side with the shared dash, not blank. */}
                    <dd className="stock-location">
                      {m.fromLocation ?? t('stock.none')}
                    </dd>
                  </div>
                  <div className="stock-movement-pair">
                    <dt>{t('stock.movement.to')}</dt>
                    <dd className="stock-location">
                      {m.toLocation ?? t('stock.none')}
                    </dd>
                  </div>
                  <div className="stock-movement-pair">
                    <dt>{t('stock.movement.actor')}</dt>
                    <dd className="stock-actor">{m.actorName ?? t('stock.actor.system')}</dd>
                  </div>
                  <div className="stock-movement-pair">
                    <dt>{t('stock.movement.at')}</dt>
                    <dd className="stock-at">{formatDate(new Date(m.occurredAt))}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        )}
        {truncated ? (
          <p className="stock-truncated" role="status">
            {t('stock.detail.truncated', { params: { count: formatNumber(movements.length) } })}
          </p>
        ) : null}
      </section>
    </div>
  );
}
