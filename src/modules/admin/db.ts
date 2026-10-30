import type { Queryable } from '@/modules/platform/index';

import type { BranchOption, PermissionInfo, RoleSummary, UserSummary } from './schema.ts';

/**
 * The ADMIN data layer: roles, the permission catalogue, and people.
 *
 * Every function takes a `db` that is ALREADY inside a `withTenant` boundary, so
 * tenant scoping is the platform's (RLS + the pinned `app.tenant_id`) and never
 * a `where tenant_id = $1` this file has to remember. The tenant is read from
 * that setting, exactly as the rest of the app does it.
 */

/** The one place `app.tenant_id` is read for a write, so it is written once. */
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/** Every role of the tenant, with its holders and its permission keys. */
export async function listRoles(db: Queryable): Promise<RoleSummary[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    description: string | null;
    user_count: number;
    permission_keys: string[];
  }>(
    `select r.id,
            r.name,
            r.description,
            (select count(*)::int from app_users u where u.role_id = r.id) as user_count,
            coalesce(
              array_agg(rp.permission_key order by rp.permission_key)
                filter (where rp.permission_key is not null),
              '{}'
            ) as permission_keys
       from roles r
       left join role_permissions rp on rp.role_id = r.id
      where r.tenant_id = ${TENANT}
      group by r.id, r.name, r.description
      order by (r.name = 'Owner') desc, r.name`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    userCount: row.user_count,
    permissionKeys: row.permission_keys ?? [],
  }));
}

/** The permissions a tenant may grant. A GLOBAL table — same list for every tenant. */
export async function listPermissions(db: Queryable): Promise<PermissionInfo[]> {
  const { rows } = await db.query<{ key: string; description: string }>(
    `select key, description from permissions order by key`,
  );
  return rows;
}

/** Creates a role with no permissions yet and returns its id. */
export async function createRole(
  db: Queryable,
  input: { name: string; description: string | null },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into roles (tenant_id, name, description)
     values (${TENANT}, $1, $2)
     returning id`,
    [input.name, input.description],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('createRole: no row returned from insert');
  return id;
}

/**
 * Replaces a role's permission set in ONE statement pair.
 *
 * Delete-then-insert rather than a diff: the screen sends the whole set it wants,
 * and a diff would have to guess what an absent checkbox means when two tabs are
 * open. Both statements run on the caller's connection inside its transaction, so
 * a half-applied set is not observable.
 */
export async function setRolePermissions(
  db: Queryable,
  roleId: string,
  keys: readonly string[],
): Promise<void> {
  await db.query(`delete from role_permissions where role_id = $1 and tenant_id = ${TENANT}`, [roleId]);
  if (keys.length === 0) return;
  await db.query(
    `insert into role_permissions (role_id, tenant_id, permission_key)
     select $1, ${TENANT}, unnest($2::text[])`,
    [roleId, [...new Set(keys)]],
  );
}

/** Every account of the tenant, with its role and branch resolved for display. */
export async function listUsers(db: Queryable): Promise<UserSummary[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    username: string;
    role_id: string | null;
    role_name: string | null;
    branch_label: string | null;
    active: boolean;
  }>(
    `select u.id,
            u.name,
            u.username,
            u.role_id,
            r.name as role_name,
            case when l.id is null then null else l.name_ar || ' (' || l.code || ')' end as branch_label,
            u.active
       from app_users u
       left join roles r on r.id = u.role_id
       left join locations l on l.id = u.branch_location_id
      where u.tenant_id = ${TENANT}
      order by u.active desc, u.name`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    username: row.username,
    roleId: row.role_id,
    roleName: row.role_name,
    branchLabel: row.branch_label,
    active: row.active,
  }));
}

/** The branches a person may be attached to (active branch locations). */
export async function listBranchOptions(db: Queryable): Promise<BranchOption[]> {
  const { rows } = await db.query<{ id: string; label: string }>(
    `select id, name_ar || ' (' || code || ')' as label
       from locations
      where tenant_id = ${TENANT} and type = 'branch' and active
      order by code`,
  );
  return rows;
}

/** Creates a person. The caller has already hashed the password and picked the enum. */
export async function createUser(
  db: Queryable,
  input: {
    name: string;
    username: string;
    passwordHash: string;
    roleId: string;
    roleEnum: 'owner' | 'warehouse_manager' | 'branch_user';
    branchLocationId: string | null;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into app_users
       (tenant_id, name, name_normalised, username, role, password_hash, role_id, branch_location_id)
     values
       (${TENANT}, $1, public.normalise_name($1), $2, $3, $4, $5, $6)
     returning id`,
    [
      input.name,
      input.username,
      input.roleEnum,
      input.passwordHash,
      input.roleId,
      input.branchLocationId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('createUser: no row returned from insert');
  return id;
}

/** The role NAME behind an id — the caller needs it to keep the enum in step. */
export async function roleNameById(db: Queryable, roleId: string): Promise<string | null> {
  const { rows } = await db.query<{ name: string }>(
    `select name from roles where id = $1 and tenant_id = ${TENANT}`,
    [roleId],
  );
  return rows[0]?.name ?? null;
}

/** Moves a person to another role, keeping the legacy enum in step. */
export async function setUserRole(
  db: Queryable,
  userId: string,
  roleId: string,
  roleEnum: 'owner' | 'warehouse_manager' | 'branch_user',
): Promise<void> {
  await db.query(
    `update app_users set role_id = $2, role = $3 where id = $1 and tenant_id = ${TENANT}`,
    [userId, roleId, roleEnum],
  );
}

/** Enables or disables an account. Sessions of a disabled account stop resolving. */
export async function setUserActive(db: Queryable, userId: string, active: boolean): Promise<void> {
  await db.query(`update app_users set active = $2 where id = $1 and tenant_id = ${TENANT}`, [
    userId,
    active,
  ]);
}

/** Replaces a person's password hash, and ends their live sessions with it. */
export async function setUserPassword(
  db: Queryable,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db.query(
    `update app_users set password_hash = $2 where id = $1 and tenant_id = ${TENANT}`,
    [userId, passwordHash],
  );
  // A password reset is the usual response to a suspected compromise, so it
  // must not leave the old holder signed in on a phone somewhere.
  await db.query(
    `update sessions set revoked_at = now() where user_id = $1 and tenant_id = ${TENANT} and revoked_at is null`,
    [userId],
  );
}
