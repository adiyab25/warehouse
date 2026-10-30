"use client";
import { useCallback, useState } from "react";
import { parseListFilter, toSearchParams } from "@/lib/list-filter";

export function useListFilter() {
  const [sp, setSp] = useState(() => new URLSearchParams(window.location.search));
  const filter = parseListFilter(sp);
  const update = useCallback((next: typeof filter) => {
    const params = toSearchParams(next);
    const url = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", url);
    setSp(new URLSearchParams(params));
  }, []);
  return { filter, update };
}