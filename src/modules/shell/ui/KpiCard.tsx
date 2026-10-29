import { Card, CardContent } from '@/components/ui/card';

export function KpiCard({ label, value, trend }: { label: string; value: string | number; trend?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {trend && <div className="text-xs text-muted-foreground">{trend}</div>}
      </CardContent>
    </Card>
  );
}