import { PERMISSION } from '@/modules/auth/keys';

/**
 * The ADMIN rules — who may be given which role, and what a role may be edited
 * into. Pure functions, no database, no Node built-ins: the screens import this
 * module on the client as well as the server, so it must stay importable
 * anywhere (the only import is the permission-key table).
 *
 * The one invariant this file exists for: **the tenant can never lock itself out
 * of administration.** Removing `auth:roles:manage` from every role that any
 * active person holds is refused — not because the owner is special, but because
 * a screen that can do that can brick the account with one click and no way back
 * short of SQL.
 */

/** Why an admin action was refused — a named condition, never a bare throw. */
export type AdminRefusal = 'unauthenticated' | 'forbidden' | 'invalid' | 'conflict';

/** The i18n key for each refusal CODE — the one place a code becomes a sentence. */
export const ADMIN_REFUSAL_MESSAGE_KEYS: Record<AdminRefusal, string> = {
  unauthenticated: 'admin.error.unauthenticated',
  forbidden: 'admin.error.forbidden',
  invalid: 'admin.error.invalid',
  conflict: 'admin.error.conflict',
};

/** One permission the tenant may grant. `key` is the machine name, shown as-is. */
export interface PermissionInfo {
  key: string;
  /** The English description stored with the key — a technical catalogue. */
  description: string;
}

/** A role, as the roles screen lists it. */
export interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  /** How many accounts hold it — the number that makes deleting a role unwise. */
  userCount: number;
  permissionKeys: string[];
}

/** A branch the user screen may assign a person to. */
export interface BranchOption {
  id: string;
  label: string;
}

/** A person, as the users screen lists them. */
export interface UserSummary {
  id: string;
  name: string;
  username: string;
  roleId: string | null;
  roleName: string | null;
  branchLabel: string | null;
  active: boolean;
}

/** The module a permission key belongs to: `requisitions:requisitions:approve` → `requisitions`. */
export function permissionModule(key: string): string {
  const head = String(key ?? '').split(':')[0];
  return head === '' ? 'other' : head;
}

/**
 * The permissions catalogue, grouped by module, in a stable order.
 *
 * Grouping is by the key's own prefix rather than by a hand-maintained list, so
 * a permission added to the database tomorrow appears on the screen without a
 * code change — which is the point of a permission TABLE.
 */
export function groupPermissions(
  permissions: readonly PermissionInfo[],
): { module: string; items: PermissionInfo[] }[] {
  const groups = new Map<string, PermissionInfo[]>();
  for (const permission of permissions) {
    // `module` is a reserved name to Next's lint (webpack's own variable), so
    // this local is `moduleName` on purpose.
    const moduleName = permissionModule(permission.key);
    const bucket = groups.get(moduleName);
    if (bucket) bucket.push(permission);
    else groups.set(moduleName, [permission]);
  }
  return [...groups.entries()]
    .map(([moduleName, items]) => ({
      module: moduleName,
      items: [...items].sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

/** A display name: 2–40 characters, letters/digits/spaces/`._-`. */
const ROLE_NAME = /^[\p{L}\p{N} ._-]{2,40}$/u;

/** The shortest password this screen will set. */
export const MIN_PASSWORD_LENGTH = 12;

/** Why a role name is not usable, or `null` when it is. */
export function roleNameProblem(raw: unknown): 'invalid' | null {
  const name = typeof raw === 'string' ? raw.trim() : '';
  return ROLE_NAME.test(name) ? null : 'invalid';
}

/** Why a password is not usable, or `null` when it is. */
export function passwordProblem(raw: unknown): 'invalid' | null {
  const password = typeof raw === 'string' ? raw : '';
  return password.length >= MIN_PASSWORD_LENGTH ? null : 'invalid';
}

/**
 * The legacy `app_users.role` enum value for a tenant-defined role name.
 *
 * `app_users.role` predates the roles table and is still `NOT NULL` with a CHECK
 * of three values, while the tenant may name its roles anything. The enum is kept
 * in step as a crude classification — Owner / Manager / Branch — purely because
 * old code paths still read it; NOTHING decides access from it any more. A
 * tenant-invented role is classified `branch_user`, the least-privileged value,
 * because the safe default for a value nothing authorises from is "the smallest".
 */
export function roleEnumFor(roleName: string | null | undefined): 'owner' | 'warehouse_manager' | 'branch_user' {
  const name = typeof roleName === 'string' ? roleName.trim().toLowerCase() : '';
  if (name === 'owner') return 'owner';
  if (name === 'manager' || name === 'warehouse manager') return 'warehouse_manager';
  return 'branch_user';
}

/**
 * Would this edit leave NOBODY able to administer roles?
 *
 * `roles` is the tenant's own list with the number of people holding each one;
 * `nextKeys` is what the edited role would hold afterwards. Returns the number of
 * active people who would still hold `auth:roles:manage` — the caller refuses the
 * edit when that is zero.
 */
export function administratorsAfter(
  roles: readonly RoleSummary[],
  editedRoleId: string,
  nextKeys: readonly string[],
): number {
  return roles.reduce((total, role) => {
    const keys = role.id === editedRoleId ? nextKeys : role.permissionKeys;
    return keys.includes(PERMISSION.rolesManage) ? total + role.userCount : total;
  }, 0);
}

/**
 * Is this permission row LOCKED for this role — i.e. may it not be removed?
 *
 * The built-in Owner role always keeps `auth:roles:manage`: a tenant may rename
 * roles and reshape them freely, but the role the system shipped as "Owner" is
 * how a new deployment stays recoverable before anyone has been given a custom
 * role.
 */
export function isPermissionLocked(roleName: string | null, key: string): boolean {
  return roleName === 'Owner' && key === PERMISSION.rolesManage;
}
