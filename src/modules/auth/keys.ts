/**
 * Permission KEYS and the one pure check — no Node built-ins, no database.
 *
 * This file exists so that anything may ask "may this person do X?" without
 * dragging the server-only crypto module (`auth/schema.ts`) into a client
 * bundle: a screen's affordances and a server action's gate must be able to
 * import the SAME keys, or they drift and the UI offers a button the server
 * refuses.
 */

/**
 * The permission keys this build knows about.
 *
 * A key is `<module>:<area>:<action>`, and `permissions.key` in the database is
 * the SAME string — this map exists so a caller cannot mistype a key and
 * silently deny (a typo in a deny-list is invisible: the check simply never
 * passes). A key that is not in the database grants nothing; a key that is not
 * in this map is not used by any gate.
 */
export const PERMISSION = {
  usersView: 'auth:users:view',
  usersManage: 'auth:users:manage',
  rolesManage: 'auth:roles:manage',

  itemsView: 'catalog:items:view',
  itemsManage: 'catalog:items:manage',
  locationsView: 'locations:locations:view',
  locationsManage: 'locations:locations:manage',
  stockView: 'ledger:stock:view',

  intakeView: 'receiving:intake:view',
  intakeCreate: 'receiving:intake:create',

  requisitionsView: 'requisitions:requisitions:view',
  requisitionsCreate: 'requisitions:requisitions:create',
  requisitionsApprove: 'requisitions:requisitions:approve',
  requisitionsIssue: 'requisitions:requisitions:issue',
  requisitionsConfirm: 'requisitions:requisitions:confirm',
  requisitionsCancel: 'requisitions:requisitions:cancel',

  returnsView: 'returns:returns:view',
  returnsCreate: 'returns:returns:create',
  returnsProcess: 'returns:returns:process',

  countsView: 'counts:counts:view',
  countsCreate: 'counts:counts:create',
  countsPost: 'counts:counts:post',

  usageView: 'branch-usage:usage:view',
  usageCreate: 'branch-usage:usage:create',

  reportsBasic: 'reports:reports:basic',
  reportsCost: 'reports:reports:cost',
  reportsAudit: 'reports:reports:audit',

  apiManage: 'api:api:manage',
  settingsManage: 'settings:settings:manage',
} as const;

/** One key from {@link PERMISSION}. */
export type PermissionKey = (typeof PERMISSION)[keyof typeof PERMISSION];

/**
 * Does this permission set hold `key`?
 *
 * THE authority check, and deliberately pure: the same function answers for a
 * server action (with `user.permissions`), for a screen's affordances, and for
 * a test — so a route and its button cannot disagree about who may act.
 *
 * TAKES THE SET, NOT THE USER, on purpose: there is no role name in the
 * signature, so no caller can "helpfully" fall back to `role === 'owner'` when
 * it does not have a set. Unknown keys deny: the safe default for a stock
 * system is "no".
 */
export function can(permissions: readonly string[] | null | undefined, key: string): boolean {
  if (!Array.isArray(permissions) || typeof key !== 'string' || key === '') return false;
  return permissions.includes(key);
}

/** Whether this set holds EVERY one of `keys`. */
export function canAll(
  permissions: readonly string[] | null | undefined,
  keys: readonly string[],
): boolean {
  return keys.every((key) => can(permissions, key));
}
