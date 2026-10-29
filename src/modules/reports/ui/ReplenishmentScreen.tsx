import type { ReplenishmentGroup } from '@/app/reports/handler';
import { formatNumber, t } from '@/i18n';
import { getRequestLang } from '@/i18n/request';

/**
 * THE REPLENISHMENT REPORT — one table per branch, lowest cover first (the
 * handler hands the groups and the rows already in that order).
 *
 * A READ-ONLY server component. Quantities arrive as exact `numeric` STRINGS from
 * SQL (the cover and the rate are computed there too); they are FORMATTED here for
 * display (Latin digits, via `formatNumber`) and no arithmetic is done on them. A
 * cover of `null` is "not enough history", never a blank or an Infinity. The
 * language is read once (`getRequestLang`) and threaded through every label.
 */
export interface ReplenishmentScreenProps {
  groups: ReplenishmentGroup[];
  days: number;
  truncated: boolean;
  limit: number;
  /** The branch a branch user is confined to, to STATE the scope; `null` for the network. */
  branchLabel: string | null;
}

export async function ReplenishmentScreen({ groups, days, truncated, limit, branchLabel }: ReplenishmentScreenProps) {
  const lang = await getRequestLang();
  return (
    <div className="replenishment">
      <p className="stock-usage-note">{t('reports.subtitle', lang)}</p>
      <p className="stock-usage-note">{t('reports.window_note', { lang, params: { days: formatNumber(days, lang) } })}</p>
      {branchLabel ? (
        <p className="stock-usage-window">{t('reports.branch_scope', { lang, params: { branch: branchLabel } })}</p>
      ) : null}

      {groups.length === 0 ? (
        <p className="field-hint">{t('reports.empty', lang)}</p>
      ) : (
        groups.map((group) => (
          <section key={group.locationId} className="replenishment-branch">
            <h2 className="replenishment-branch-name">{group.location}</h2>
            <table className="replenishment-table">
              <thead>
                <tr>
                  <th scope="col" className="replenishment-item">{t('reports.col.item', lang)}</th>
                  <th scope="col">{t('reports.col.on_hand', lang)}</th>
                  <th scope="col">{t('reports.col.min', lang)}</th>
                  <th scope="col">{t('reports.col.cover', lang)}</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.itemId}>
                    <td className="replenishment-item">{row.nameAr}</td>
                    <td>{formatNumber(Number(row.onHand), lang)}</td>
                    <td>{formatNumber(Number(row.minQty), lang)}</td>
                    <td>
                      {row.coverDays === null ? (
                        <span className="field-hint">{t('reports.cover.none', lang)}</span>
                      ) : (
                        <span>{formatNumber(Number(row.coverDays), lang)}</span>
                      )}
                      <span className="replenishment-rate">
                        {t('reports.col.rate', lang)}:{' '}
                        {row.ratePerDay === null ? t('reports.rate.none', lang) : formatNumber(Number(row.ratePerDay), lang)}
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
          {t('reports.truncated', { lang, params: { count: formatNumber(limit, lang) } })}
        </p>
      ) : null}
    </div>
  );
}