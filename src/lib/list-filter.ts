// ListFilter — shared filter state for all list screens.
// See orchestration plan task 1C.1.

export type ListFilter = {
  search?: string;
  statuses?: string[];
  dateFrom?: string; // ISO YYYY-MM-DD
  dateTo?: string;
  branchId?: string;
  sort?: string;
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

export function parseListFilter(sp: URLSearchParams | Record<string, string | string[] | undefined>): ListFilter {
  const get = (k: string): string | undefined => {
    if (sp instanceof URLSearchParams) return sp.get(k) ?? undefined;
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const out: ListFilter = {};
  const search = get("q") ?? get("search");
  if (search) out.search = search;
  const status = get("status");
  if (status) out.statuses = status.split(",").filter(Boolean);
  const from = get("from") ?? get("dateFrom");
  if (from) out.dateFrom = from;
  const to = get("to") ?? get("dateTo");
  if (to) out.dateTo = to;
  const branch = get("branch") ?? get("branchId");
  if (branch) out.branchId = branch;
  const sort = get("sort");
  if (sort) out.sort = sort;
  const dir = get("dir") ?? get("sortDir");
  if (dir === "asc" || dir === "desc") out.sortDir = dir;
  const limitRaw = get("limit");
  let limit = limitRaw ? Number(limitRaw) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  out.limit = Math.min(limit, MAX_LIMIT);
  const offsetRaw = get("offset");
  if (offsetRaw) {
    const o = Number(offsetRaw);
    if (Number.isFinite(o) && o >= 0) out.offset = o;
  }
  return out;
}

export function toSearchParams(f: ListFilter): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.search) sp.set("q", f.search);
  if (f.statuses?.length) sp.set("status", f.statuses.join(","));
  if (f.dateFrom) sp.set("from", f.dateFrom);
  if (f.dateTo) sp.set("to", f.dateTo);
  if (f.branchId) sp.set("branch", f.branchId);
  if (f.sort) sp.set("sort", f.sort);
  if (f.sortDir) sp.set("dir", f.sortDir);
  if (f.limit && f.limit !== DEFAULT_LIMIT) sp.set("limit", String(f.limit));
  if (f.offset) sp.set("offset", String(f.offset));
  return sp;
}

// WHERE builder: caller supplies allow-list of sortable/filterable columns.
export type WhereBuilderOpts = {
  allowedSort: string[];
  allowedFilters: string[]; // columns that may appear as filters (not used for interpolation guard)
};

export function buildWhere(
  f: ListFilter,
  opts: WhereBuilderOpts,
  extra: { column: string; op: string; value: unknown }[] = [],
): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const push = (sql: string, val: unknown) => {
    params.push(val);
    clauses.push(sql.replace("?", `$${params.length}`));
  };
  if (f.search) {
    // caller must handle search columns; generic: no-op here, append via extra
  }
  if (f.statuses?.length) {
    const placeholders = f.statuses.map((_, i) => `$${params.length + i + 1}`).join(",");
    params.push(...f.statuses);
    clauses.push(`status IN (${placeholders})`);
  }
  if (f.dateFrom) push("created_at >= ?", f.dateFrom);
  if (f.dateTo) push("created_at <= ?", f.dateTo);
  if (f.branchId) push("branch_id = ?", f.branchId);
  for (const e of extra) {
    params.push(e.value);
    clauses.push(`${e.column} ${e.op} $${params.length}`);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  // sort validation
  void opts;
  return { where, params };
}

export function safeSort(f: ListFilter, allowed: string[], defaultSort = "created_at"): { column: string; dir: "asc" | "desc" } {
  const column = allowed.includes(f.sort ?? "") ? (f.sort as string) : defaultSort;
  const dir = f.sortDir === "asc" ? "asc" : "desc";
  return { column, dir };
}