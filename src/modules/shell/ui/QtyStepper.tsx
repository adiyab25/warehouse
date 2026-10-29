'use client';
import { Button } from '@/components/ui/button';

export function QtyStepper({ value, onChange, min = 0 }: { value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <div className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => onChange(Math.max(min, value - 1))}>-</Button>
      <span className="min-w-8 text-center tabular-nums">{value}</span>
      <Button size="sm" variant="outline" onClick={() => onChange(value + 1)}>+</Button>
    </div>
  );
}