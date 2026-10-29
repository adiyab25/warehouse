// Maps every document/line status from DB CHECK constraints to a status token + i18n label key.
export type StatusToken = 'ok' | 'waiting' | 'short' | 'transit' | 'draft';

export interface StatusEntry {
  token: StatusToken;
  labelKey: string; // i18n key
}

export const STATUS_MAP: Record<string, StatusEntry> = {
  // receipts
  draft: { token: 'draft', labelKey: 'status.draft' },
  receiving: { token: 'waiting', labelKey: 'status.receiving' },
  posted: { token: 'ok', labelKey: 'status.posted' },
  // requisitions
  requested: { token: 'waiting', labelKey: 'status.requested' },
  approved: { token: 'ok', labelKey: 'status.approved' },
  partially_issued: { token: 'transit', labelKey: 'status.partially_issued' },
  issued: { token: 'transit', labelKey: 'status.issued' },
  received: { token: 'ok', labelKey: 'status.received' },
  closed: { token: 'draft', labelKey: 'status.closed' },
  rejected: { token: 'short', labelKey: 'status.rejected' },
  returned: { token: 'transit', labelKey: 'status.returned' },
  // requisition lines
  open: { token: 'waiting', labelKey: 'status.open' },
  fulfilled: { token: 'ok', labelKey: 'status.fulfilled' },
  short: { token: 'short', labelKey: 'status.short' },
  // counts
  // open/closed already covered
};

export const ALL_STATUSES = [
  'draft','receiving','posted',
  'requested','approved','partially_issued','issued','received','closed','rejected','returned',
  'open','fulfilled','short',
] as const;

export function statusEntry(status: string): StatusEntry {
  return STATUS_MAP[status] ?? { token: 'draft', labelKey: status };
}