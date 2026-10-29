'use client';
import { Badge } from '@/components/ui/badge';
import { statusEntry, type StatusToken } from '../domain/status';

const TOKEN_CLASS: Record<StatusToken, string> = {
  ok: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  waiting: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  short: 'bg-red-500/15 text-red-700 border-red-500/30',
  transit: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  draft: 'bg-zinc-500/15 text-zinc-700 border-zinc-500/30',
};

export function StatusBadge({ status }: { status: string }) {
  const entry = statusEntry(status);
  return (
    <Badge variant="outline" className={TOKEN_CLASS[entry.token]}>
      {entry.labelKey}
    </Badge>
  );
}