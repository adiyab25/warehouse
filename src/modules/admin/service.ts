import { hashPassword } from '@/modules/auth/schema';
import { can, PERMISSION } from '@/modules/auth/keys';
import { currentUser, type CurrentUser } from '@/modules/auth/index';
import { isStoredUsername, normaliseUsername } from '@/modules/platform/schema';
import type { Queryable } from '@/modules/platform/index';

import {
  administratorsAfter,
  isPermissionLocked,
  passwordProblem,
  roleEnumFor,
  roleNameProblem,
  type AdminRefusal,
  type BranchOption,
  type PermissionInfo,
  type RoleSummary,
  type UserSummary,
} from './schema.ts';
import {
  createRole,
  createUser,
  listBranchOptions,
  listPermissions,
  listRoles,
  listUsers,
  roleNameById,
  setRolePermissions,
  setUserActive,
  setUserPassword,
  setUserRole,
} from './db.ts';

/**
 * THE ADMIN SEAMS — the roles and users screens' logic, with the request
 * boundary left out.
 *
 * Same shape as `src/app/requisitions/handler.ts`: a pure-ish layer that takes
 * an already tenant-scoped `db` and a session cookie, so `node --test` can drive
 * every rule against a real database with no HTTP layer. The server actions are
 * three lines of plumbing on top.
 *
 * EVERY ENTRY POINT ANSWERS, NONE THROWS — a refusal is a coded answer. The two
 * own goals this module is written to prevent:
 *
 *   * an ADMIN SCREEN THAT CAN LOCK THE TENANT OUT — removing the last
 *     `auth:roles:manage`, or deactivating / demoting yourself;
 *   * A ROLE EDIT THAT SILENTLY DOES NOT APPLY — the set is replaced whole and
 *     re-read by the next request, so what the screen shows is what is stored.
 */

/** A refusal the screen can render, carrying a machine-readable code. */
export class AdminError extends Error {
  readonly code: AdminRefusal;

  constructor(code: AdminRefusal, message: string) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
  }
}

/** Resolves the caller and asserts they hold `key`. */
async function requireAdmin(
  db: Queryable,
  cookie: string | undefined | null,
  key: string,
): Promise<CurrentUser> {
  const user = await currentUser(db, cookie);
  if (!user) {
    throw new AdminError('unauthenticated', 'Admin: you are not signed in (or the session has ended).');
  }
  if (!can(user.permissions, key)) {
    throw new AdminError(
      'forbidden',
      `Admin: this account's role does not hold "${key}", so it may not do this.`,
    );
  }
  return user;
}

/** Wraps a handler so a throw becomes an answer the screen can switch on. */
async function answered<T>(
  body: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; code: AdminRefusal }> {
  try {
    return { ok: true, data: await body() };
  } catch (err) {
    if (err instanceof AdminError) return { ok: false, code: err.code };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export interface RolesOverview {
  roles: RoleSummary[];
  permissions: PermissionInfo[];
}

/** Everything the roles screen renders, in ONE pass's worth of reads. */
export async function rolesOverview(
  db: Queryable,
  cookie: string | undefined | null,
): Promise<RolesOverview> {
  await requireAdmin(db, cookie, PERMISSION.rolesManage);
  const [roles, permissions] = await Promise.all([listRoles(db), listPermissions(db)]);
  return { roles, permissions };
}

/** Creates a role and grants it the keys the form ticked. */
export async function createRoleIn(
  db: Queryable,
  cookie: string | undefined | null,
  input: { name?: string; description?: string; keys?: string[] },
): Promise<{ roleId: string }> {
  await requireAdmin(db, cookie, PERMISSION.rolesManage);

  if (roleNameProblem(input?.name) !== null) {
    throw new AdminError('invalid', 'Admin: a role needs a name of 2-40 letters or digits.');
  }
  const name = String(input.name).trim();
  const description = typeof input.description === 'string' && input.description.trim() !== ''
    ? input.description.trim()
    : null;

  const known = new Set((await listPermissions(db)).map((permission) => permission.key));
  const requested = Array.isArray(input.keys) ? input.keys : [];
  const unknown = requested.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new AdminError('invalid', `Admin: unknown permission key(s): ${unknown.join(', ')}`);
  }

  const roleId = await createRole(db, { name, description });
  await setRolePermissions(db, roleId, requested);
  return { roleId };
}

/**
 * Replaces a role's permission set.
 *
 * Two refusals protect the tenant from itself: the built-in Owner keeps
 * `auth:roles:manage`, and NO edit may leave zero active people able to manage
 * roles — because the screen that could do that is the only screen that could
 * undo it.
 */
export async function setRolePermissionsIn(
  db: Queryable,
  cookie: string | undefined | null,
  input: { roleId?: string; keys?: string[] },
): Promise<{ keys: string[] }> {
  await requireAdmin(db, cookie, PERMISSION.rolesManage);

  const roleId = typeof input?.roleId === 'string' ? input.roleId : '';
  if (roleId === '') throw new AdminError('invalid', 'Admin: no role was named.');

  const roles = await listRoles(db);
  const role = roles.find((candidate) => candidate.id === roleId);
  if (!role) throw new AdminError('invalid', 'Admin: that role does not exist in this tenant.');

  const nextKeys = [...new Set(Array.isArray(input.keys) ? input.keys : [])];

  const removed = role.permissionKeys.filter((key) => !nextKeys.includes(key));
  const locked = removed.find((key) => isPermissionLocked(role.name, key));
  if (locked !== undefined) {
    throw new AdminError(
      'conflict',
      `Admin: "${locked}" cannot be removed from the Owner role — it is how a deployment stays recoverable.`,
    );
  }

  if (administratorsAfter(roles, role.id, nextKeys) === 0) {
    throw new AdminError(
      'conflict',
      'Admin: that change would leave nobody able to manage roles. Grant the permission to another role first.',
    );
  }

  await setRolePermissions(db, role.id, nextKeys);
  return { keys: nextKeys };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface UsersOverview {
  users: UserSummary[];
  roles: RoleSummary[];
  branches: BranchOption[];
  /** The caller's own id — the screen hides the controls that would end their access. */
  selfId: string;
}

/** Everything the users screen renders. */
export async function usersOverview(
  db: Queryable,
  cookie: string | undefined | null,
): Promise<UsersOverview> {
  const user = await requireAdmin(db, cookie, PERMISSION.usersManage);
  const [users, roles, branches] = await Promise.all([
    listUsers(db),
    listRoles(db),
    listBranchOptions(db),
  ]);
  return { users, roles, branches, selfId: user.userId };
}

/** Creates a person with a role and, optionally, a branch. */
export async function createUserIn(
  db: Queryable,
  cookie: string | undefined | null,
  input: {
    name?: string;
    username?: string;
    password?: string;
    roleId?: string;
    branchLocationId?: string | null;
  },
): Promise<{ userId: string }> {
  await requireAdmin(db, cookie, PERMISSION.usersManage);

  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (name === '') throw new AdminError('invalid', 'Admin: a person needs a name.');

  const username = normaliseUsername(typeof input?.username === 'string' ? input.username : '');
  if (!isStoredUsername(username)) {
    throw new AdminError(
      'invalid',
      'Admin: a username is 3-32 lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.',
    );
  }

  if (passwordProblem(input?.password) !== null) {
    throw new AdminError('invalid', 'Admin: the password must be at least 12 characters.');
  }

  const roleId = typeof input.roleId === 'string' ? input.roleId : '';
  const roleName = roleId === '' ? null : await roleNameById(db, roleId);
  if (!roleName) throw new AdminError('invalid', 'Admin: that role does not exist in this tenant.');

  const taken = await db.query<{ n: number }>(
    `select count(*)::int as n from app_users where username = $1`,
    [username],
  );
  if ((taken.rows[0]?.n ?? 0) > 0) {
    throw new AdminError('conflict', 'Admin: that username is already taken in this tenant.');
  }

  const branchLocationId =
    typeof input.branchLocationId === 'string' && input.branchLocationId !== ''
      ? input.branchLocationId
      : null;

  const userId = await createUser(db, {
    name,
    username,
    passwordHash: await hashPassword(String(input.password)),
    roleId,
    roleEnum: roleEnumFor(roleName),
    branchLocationId,
  });
  return { userId };
}

/** Moves someone to another role. A person may not change their OWN role. */
export async function setUserRoleIn(
  db: Queryable,
  cookie: string | undefined | null,
  input: { userId?: string; roleId?: string },
): Promise<{ roleId: string }> {
  const actor = await requireAdmin(db, cookie, PERMISSION.usersManage);

  const userId = typeof input?.userId === 'string' ? input.userId : '';
  const roleId = typeof input?.roleId === 'string' ? input.roleId : '';
  if (userId === '' || roleId === '') throw new AdminError('invalid', 'Admin: a person and a role are required.');

  if (userId === actor.userId) {
    throw new AdminError('conflict', 'Admin: you cannot change your own role — ask another administrator.');
  }

  const roleName = await roleNameById(db, roleId);
  if (!roleName) throw new AdminError('invalid', 'Admin: that role does not exist in this tenant.');

  await setUserRole(db, userId, roleId, roleEnumFor(roleName));
  return { roleId };
}

/**
 * Enables or disables an account.
 *
 * Disabling ends that person's live sessions on their next request (`readSession`
 * requires `active`), which is the offboarding hook — so disabling YOURSELF is
 * refused last an administrator sign themselves out of the only screen that could
 * let them back in.
 */
export async function setUserActiveIn(
  db: Queryable,
  cookie: string | undefined | null,
  input: { userId?: string; active?: boolean },
): Promise<{ active: boolean }> {
  const actor = await requireAdmin(db, cookie, PERMISSION.usersManage);

  const userId = typeof input?.userId === 'string' ? input.userId : '';
  if (userId === '') throw new AdminError('invalid', 'Admin: no person was named.');
  if (typeof input.active !== 'boolean') throw new AdminError('invalid', 'Admin: the new state must be true or false.');

  if (userId === actor.userId && !input.active) {
    throw new AdminError('conflict', 'Admin: you cannot disable your own account — ask another administrator.');
  }

  await setUserActive(db, userId, input.active);
  return { active: input.active };
}

/** Resets a password (and ends that person's sessions with it). */
export async function resetPasswordIn(
  db: Queryable,
  cookie: string | undefined | null,
  input: { userId?: string; password?: string },
): Promise<{ userId: string }> {
  await requireAdmin(db, cookie, PERMISSION.usersManage);

  const userId = typeof input?.userId === 'string' ? input.userId : '';
  if (userId === '') throw new AdminError('invalid', 'Admin: no person was named.');
  if (passwordProblem(input?.password) !== null) {
    throw new AdminError('invalid', 'Admin: the password must be at least 12 characters.');
  }

  await setUserPassword(db, userId, await hashPassword(String(input.password)));
  return { userId };
}

// ---------------------------------------------------------------------------
// Page-shaped entry points: the same calls, with the refusal as an ANSWER.
//
// A page cannot switch on a thrown error without a try/catch around its data
// read, and a page that forgot one would render a 500 for a plain "you may not
// see this". These wrappers are what the route files call.
// ---------------------------------------------------------------------------

/** {@link rolesOverview}, answering a refusal instead of throwing it. */
export async function tryRolesOverview(
  db: Queryable,
  cookie: string | undefined | null,
): Promise<{ ok: true; data: RolesOverview } | { ok: false; code: AdminRefusal }> {
  return answered(() => rolesOverview(db, cookie));
}

/** {@link usersOverview}, answering a refusal instead of throwing it. */
export async function tryUsersOverview(
  db: Queryable,
  cookie: string | undefined | null,
): Promise<{ ok: true; data: UsersOverview } | { ok: false; code: AdminRefusal }> {
  return answered(() => usersOverview(db, cookie));
}

/** The answer shape every admin server action returns. */
export type AdminAnswer<T> = { ok: true; data: T } | { ok: false; code: AdminRefusal };

/**
 * Runs a handler and turns its refusal into an ANSWER.
 *
 * Only an {@link AdminError} is a refusal; anything else is a real fault and is
 * re-thrown, because reporting a broken query as "you are not permitted" buries
 * the bug behind a permission message nobody investigates. Exported so the two
 * route files share ONE implementation instead of two drifting copies.
 */
export async function asAnswer<T>(body: () => Promise<T>): Promise<AdminAnswer<T>> {
  return answered(body);
}
