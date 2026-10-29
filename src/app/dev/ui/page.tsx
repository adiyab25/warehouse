import { PageHeader } from '@/modules/shell/ui/PageHeader';
import { DataTable } from '@/modules/shell/ui/DataTable';
import { StatusBadge } from '@/modules/shell/ui/StatusBadge';
import { KpiCard } from '@/modules/shell/ui/KpiCard';
import { QtyStepper } from '@/modules/shell/ui/QtyStepper';
import { EmptyState } from '@/modules/shell/ui/EmptyState';
import { DocNumber } from '@/modules/shell/ui/DocNumber';
import { Money, Qty, DateTime } from '@/modules/shell/ui/Formatters';

export default function DevUiPage() {
  const rows = [{ id: 1, name: 'Item', status: 'posted' }];
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="UI Components" subtitle="dev" />
      <div className="grid grid-cols-2 gap-4"><KpiCard label="KPI" value={42} /></div>
      <DataTable columns={[{ key: 'name', header: 'Name' }, { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} data={rows} />
      <QtyStepper value={2} onChange={() => {}} />
      <DocNumber value="REQ-2026-0042" />
      <Money value={12.5} /> <Qty value={3} /> <DateTime value={new Date().toISOString()} />
      <EmptyState title="Empty" description="no data" />
    </div>
  );
}