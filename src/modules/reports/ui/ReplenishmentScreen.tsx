import type { ReplenishmentGroup } from '@/app/reports/handler';
import { formatNumber, t } from '@/i18n';
import { getRequestLang } from '@/i18n/request';
import { PageHeader } from '@/modules/shell/ui/PageHeader';
import { DataTable } from '@/modules/shell/ui/DataTable';
import { EmptyState } from '@/modules/shell/ui/EmptyState';

/**
 * THE REPLENISHMENT REPORT — one table per branch, lowest cover first (the
 * handler hands the groups and the rows already in that order).
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
    <div className="space-y-4">
      <PageHeader title={t('reports.heading', lang)} subtitle={t('reports.subtitle', lang)} />

      <p className="text-sm text-muted-foreground">
        {t('reports.window_note', { lang, params: { days: formatNumber(days, lang) } })}
      </p>
      {branchLabel ? (
        <p className="text-sm text-muted-foreground">
          {t('reports.branch_scope', { lang, params: { branch: branchLabel } })}
        </p>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState title={t('reports.empty', lang)} />
      ) : (
        groups.map((group) => (
          <section key={group.locationId} className="space-y-2">
            <h2 className="text-lg font-semibold">{group.location}</h2>
            <DataTable
              data={group.rows as any}
              columns={[
                {
                  key: 'item',
                  header: t('reports.col.item', lang),
                  render: (row: any) => row.nameAr,
                },
                {
                  key: 'onHand',
                  header: t('reports.col.on_hand', lang),
                  render: (row: any) => formatNumber(Number(row.onHand), lang),
                },
                {
                  key: 'minQty',
                  header: t('reports.col.min', lang),
                  render: (row: any) => formatNumber(Number(row.minQty), lang),
                },
                {
                  key: 'cover',
                  header: t('reports.col.cover', lang),
                  render: (row: any) => (
                    <span>
                      {row.coverDays === null ? (
                        <span className="text-muted-foreground">{t('reports.cover.none', lang)}</span>
                      ) : (
                        <span>{formatNumber(Number(row.coverDays), lang)}</span>
                      )}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t('reports.col.rate', lang)}:{' '}
                        {row.ratePerDay === null ? t('reports.rate.none', lang) : formatNumber(Number(row.ratePerDay), lang)}
                      </span>
                    </span>
                  ),
                },
              ]}
            />
          </section>
        ))
      )}

      {truncated ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('reports.truncated', { lang, params: { count: formatNumber(limit, lang) } })}
        </p>
      ) : null}
    </div>
  );
}
