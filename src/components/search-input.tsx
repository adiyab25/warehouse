'use client';

import { useState, useCallback } from 'react';
import { Input } from '@/components/ui/input';

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setLocal(e.target.value);
      onChange(e.target.value);
    },
    [onChange],
  );
  return (
    <Input
      value={local}
      onChange={handleChange}
      placeholder={placeholder}
      className="w-full"
    />
  );
}
