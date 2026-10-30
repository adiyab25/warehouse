export type ListFilter = {
  search?: string;
  statuses?: string[];
  dateFrom?: string;
  dateTo?: string;
  branchId?: string;
  itemId?: string;
  categoryId?: string;
  createdBy?: string;
  sort?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
};

export function parseListFilter(params: Record<string, string | string[] | undefined>): ListFilter {
  const get = (key: string) => {
    const v = params[key];
    return Array.isArray(v) ? v[0] : v;
  };
  const getAll = (key: string) => {
    const v = params[key];
    return Array.isArray(v) ? v : v ? [v] : [];
  };

  return {
    search: get('search') || undefined,
    statuses: getAll('status').length ? getAll('status') : undefined,
    dateFrom: get('dateFrom') || undefined,
    dateTo: get('dateTo') || undefined,
    branchId: get('branch') || undefined,
    itemId: get('item') || undefined,
    categoryId: get('category') || undefined,
    createdBy: get('createdBy') || undefined,
    sort: get('sort') || undefined,
    sortDir: (get('sortDir') as 'asc' | 'desc') || undefined,
    page: get('page') ? Number(get('page')) : undefined,
    pageSize: get('pageSize') ? Number(get('pageSize')) : undefined,
  };
}
