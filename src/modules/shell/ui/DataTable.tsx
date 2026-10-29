'use client';
import { useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

export interface Column<T> { key: string; header: string; render?: (row: T) => React.ReactNode; sortable?: boolean; }

export function DataTable<T extends Record<string, any>>({ columns, data, page, pageSize, total, onPageChange, sortable = true }: {
  columns: Column<T>[]; data: T[]; page?: number; pageSize?: number; total?: number; onPageChange?: (p: number) => void; sortable?: boolean;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [visible, setVisible] = useState<Record<string, boolean>>(() => Object.fromEntries(columns.map(c => [c.key, true])));

  const rows = [...data].sort((a, b) => {
    if (!sortKey) return 0;
    const av = a[sortKey], bv = b[sortKey];
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-sm">
        {columns.map(c => (
          <label key={c.key} className="inline-flex items-center gap-1">
            <Checkbox checked={visible[c.key]} onCheckedChange={(v) => setVisible(s => ({ ...s, [c.key]: !!v }))} />
            {c.header}
          </label>
        ))}
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.filter(c => visible[c.key]).map(c => (
                <TableHead key={c.key} className={sortable && c.sortable !== false ? 'cursor-pointer' : ''} onClick={() => { if (sortable && c.sortable !== false) { if (sortKey === c.key) setDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(c.key); setDir('asc'); } } }}>
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                {columns.filter(c => visible[c.key]).map(c => (
                  <TableCell key={c.key}>{c.render ? c.render(r) : r[c.key]}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {onPageChange && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={!page || page <= 1} onClick={() => onPageChange((page || 1) - 1)}>Prev</Button>
          <span className="text-sm">Page {page ?? 1}</span>
          <Button size="sm" variant="outline" disabled={!!total && !!pageSize && (page || 1) * (pageSize || 10) >= total} onClick={() => onPageChange((page || 1) + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}