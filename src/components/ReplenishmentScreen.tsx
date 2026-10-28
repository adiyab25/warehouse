import type { ReplenishmentGroup } from '../app/reports/handler';
import { formatNumber, t } from '../i18n';

/**
 * THE REPLENISHMENT REPORT — one table per branch, lowest cover first (the
 * handler hands the groups and the rows already in that order).
 *
 * A READ-ONLY server component. Quantities arrive as exact `numeric` STRINGS from
 * SQL (the cover and the rate are computed there too); they are FORMATTED here for
 * display (Latin digits, via `formatNumber`) and no arithmetic is done on them. A
 * cover of `null` is "not enough history", never a blank or an Infinity.
 * Layout is in globals.css; every catalogue string sits in a cell that carries
 * `min-width: 0` + `overflow-wrap: anywhere`, so a long name cannot blow 390px.
 */
export interface ReplenishmentScreenProps {
  groups: ReplenishmentGroup[];
  days: number;
  truncated: boolean;
  limit: number;
  /** The branch a branch user is confined to, to STATE the scope; `null` for the network. */
  branchLabel: string | null;
}

export function ReplenishmentScreen({ groups, days, truncated, limit, branchLabel }: ReplenishmentScreenProps) {
  return (
    <div className="replenishment">
      <p className="stock-usage-note">{t('reports.subtitle')}</p>
      <p className="stock-usage-note">{t('reports.window_note', { params: { days: formatNumber(days) } })}</p>
      {branchLabel ? (
        <p className="stock-usage-window">{t('reports.branch_scope', { params: { branch: branchLabel } })}</p>
      ) : null}

      {groups.length === 0 ? (
        <p className="field-hint">{t('reports.empty')}</p>
      ) : (
        groups.map((group) => (
          <section key={group.locationId} className="replenishment-branch">
            <h2 className="replenishment-branch-name">{group.location}</h2>
            <table className="replenishment-table">
              <thead>
                <tr>
                  <th scope="col" className="replenishment-item">{t('reports.col.item')}</th>
                  <th scope="col">{t('reports.col.on_hand')}</th>
                  <th scope="col">{t('reports.col.min')}</th>
                  <th scope="col">{t('reports.col.cover')}</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.itemId}>
                    <td className="replenishment-item">{row.nameAr}</td>
                    <td>{formatNumber(Number(row.onHand))}</td>
                    <td>{formatNumber(Number(row.minQty))}</td>
                    <td>
                      {row.coverDays === null ? (
                        <span className="field-hint">{t('reports.cover.none')}</span>
                      ) : (
                        <span>{formatNumber(Number(row.coverDays))}</span>
                      )}
                      <span className="replenishment-rate">
                        {t('reports.col.rate')}:{' '}
                        {row.ratePerDay === null ? t('reports.rate.none') : formatNumber(Number(row.ratePerDay))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}

      {truncated ? (
        <p className="field-hint" role="status">
          {t('reports.truncated', { params: { count: formatNumber(limit) } })}
        </p>
      ) : null}
    </div>
  );
}
