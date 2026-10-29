'use client';
import { Button } from '@/components/ui/button';

export function DocNumber({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono">
      <span className="ltr-value">{value}</span>
      <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(value)}>Copy</Button>
    </span>
  );
}