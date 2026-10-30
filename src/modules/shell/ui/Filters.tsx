"use client";
import * as React from "react";

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-11 w-full rounded-lg border px-3 pe-9 text-sm"
      />
      {value ? (
        <button type="button" onClick={() => onChange("")} className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-label="clear">
          ×
        </button>
      ) : null}
    </div>
  );
}

export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs">
      {label}
      <button type="button" onClick={onRemove} aria-label="remove">
        ×
      </button>
    </span>
  );
}

export function ActiveFilterChips({ chips, onClearAll }: { chips: { key: string; label: string; onRemove: () => void }[]; onClearAll?: () => void }) {
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <FilterChip key={c.key} label={c.label} onRemove={c.onRemove} />
      ))}
      {onClearAll ? (
        <button type="button" onClick={onClearAll} className="text-xs text-muted-foreground underline">
          Clear all
        </button>
      ) : null}
    </div>
  );
}

export function StatusMultiSelect({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <select
      multiple
      value={value}
      onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}
      className="h-11 rounded-lg border px-2 text-sm"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function BranchSelect({
  options,
  value,
  onChange,
  hidden,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-11 rounded-lg border px-2 text-sm">
      <option value="">All branches</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (f: string, t: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <input type="date" value={from} onChange={(e) => onChange(e.target.value, to)} className="h-11 rounded-lg border px-2 text-sm" />
      <input type="date" value={to} onChange={(e) => onChange(from, e.target.value)} className="h-11 rounded-lg border px-2 text-sm" />
    </div>
  );
}