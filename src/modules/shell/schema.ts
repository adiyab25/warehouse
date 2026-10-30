import { can, PERMISSION } from '@/modules/auth/keys';

/**
 * A signed-in user's navigation, as a pure list of links.
 *
 * Kept here (not inline in the layout) so the behaviour is testable: the nav is
 * the only way into most screens, and a dead-end front door is the "white page
 * after login" defect this app already shipped once.
 *
 * EACH LINK NAMES THE PERMISSION THAT REACHES IT. It used to ask the role enum,
 * which means a role the tenant created saw no menu at all — the screens existed
 * and the permissions were granted, but nothing linked to them. The permission
 * set is what the session carries, so the menu now follows the tenant's own
 * roles.
 */
export interface HomeNavLink {
  href: string;
  /** The i18n key for the link's label. */
  key: string;
  /** The permission key that puts this link on the menu. */
  permission: string;
}

/** Every screen the app has, in menu order. */
const LINKS: HomeNavLink[] = [
  { href: '/stock', key: 'stock.title', permission: PERMISSION.stockView },
  { href: '/requisitions', key: 'requisitions.title', permission: PERMISSION.requisitionsView },
  { href: '/intake', key: 'intake.title', permission: PERMISSION.intakeView },
  { href: '/stock/usage', key: 'stock.usage.heading', permission: PERMISSION.usageView },
  { href: '/reports', key: 'reports.heading', permission: PERMISSION.reportsBasic },
  { href: '/roles', key: 'admin.roles.title', permission: PERMISSION.rolesManage },
  { href: '/users', key: 'admin.users.title', permission: PERMISSION.usersManage },
];

/**
 * The menu for a permission set — least privilege by default.
 *
 * A missing set, an empty set or an unknown key yields no link, which is the
 * safe default for a navigation that is also the only route to administration.
 */
export function navLinksForPermissions(
  permissions: readonly string[] | null | undefined,
): HomeNavLink[] {
  return LINKS.filter((link) => can(permissions, link.permission));
}

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