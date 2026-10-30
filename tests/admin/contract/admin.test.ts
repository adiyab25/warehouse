import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createSession } from '@/modules/auth/index';
import { PERMISSION } from '@/modules/auth/keys';
import { withTenant } from '@/modules/platform/index';
import {
  createRoleIn,
  createUserIn,
  resetPasswordIn,
  setRolePermissionsIn,
  setUserActiveIn,
  setUserRoleIn,
  tryRolesOverview,
  tryUsersOverview,
} from '@/modules/admin/index';
import { sqlTestUrl, withDb } from '../../harness/sql.ts';
import { cleanupTenants, provisionTenants } from '../../harness/tenants.ts';

/**
 * THE ADMIN SCREENS' RULES, against a real database.
 *
 * Three things are being proven here, and each of them is a way an admin screen
 * earns its keep or loses it:
 *
 *   1. THE GATE IS THE PERMISSION, not the role name — a tenant-invented role
 *      with `auth:roles:manage` gets in, and a role without it does not.
 *   2. THE EDIT LANDS — what the screen sends is what the next read returns, and
 *      it is what the next check obeys.
 *   3. THE TENANT CANNOT LOCK ITSELF OUT — the last administrator, your own
 *      role, your own account: each refusal is tested, because each of them is
 *      one click away from a deployment nobody can administer.
 */

after(async () => {
  if (!sqlTestUrl()) return;
  await cleanupTenants();
});

/** A session token for one person, inside their tenant's scope. */
async function tokenFor(
  conn: Parameters<typeof withTenant>[0],
  tenantId: string,
  userId: string,
): Promise<string> {
  const { token } = await withTenant(conn, tenantId, (tdb) => createSession(tdb, { userId }));
  return token;
}

/** Inserts a role with a permission set and returns its id. */
async function roleWith(
  conn: Parameters<typeof withTenant>[0],
  tenantId: string,
  name: string,
  keys: string[],
): Promise<string> {
  return withTenant(conn, tenantId, async (tdb) => {
    const { rows } = await tdb.query<{ id: string }>(
      `insert into roles (tenant_id, name) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1) returning id`,
      [name],
    );
    const roleId = rows[0]!.id;
    if (keys.length > 0) {
      await tdb.query(
        `insert into role_permissions (role_id, tenant_id, permission_key)
         select $1, nullif(current_setting('app.tenant_id', true), '')::uuid, unnest($2::text[])`,
        [roleId, keys],
      );
    }
    return roleId;
  });
}

/** Inserts a person on a role and returns their id. */
async function userWith(
  conn: Parameters<typeof withTenant>[0],
  tenantId: string,
  username: string,
  roleId: string,
): Promise<string> {
  return withTenant(conn, tenantId, async (tdb) => {
    const { rows } = await tdb.query<{ id: string }>(
      `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash, role_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, public.normalise_name($1), $2, 'branch_user', 'x', $3)
       returning id`,
      [username, username, roleId],
    );
    return rows[0]!.id;
  });
}

test('the gate is the permission: a role the tenant invented is obeyed', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (conn) => {
    const clerkRole = await roleWith(conn, t1, 'Clerk', [PERMISSION.stockView]);
    const clerk = await userWith(conn, t1, 'clerk_one', clerkRole);
    const clerkToken = await tokenFor(conn, t1, clerk);
    const ownerToken = await tokenFor(conn, t1, u1);

    const asOwner = await withTenant(conn, t1, (tdb) => tryRolesOverview(tdb, ownerToken));
    assert.equal(asOwner.ok, true, 'the seeded Owner holds roles:manage');

    const asClerk = await withTenant(conn, t1, (tdb) => tryRolesOverview(tdb, clerkToken));
    assert.equal(asClerk.ok, false);
    assert.equal((asClerk as { code: string }).code, 'forbidden', 'a role without roles:manage is refused');

    const clerkUsers = await withTenant(conn, t1, (tdb) => tryUsersOverview(tdb, clerkToken));
    assert.equal(clerkUsers.ok, false, 'and it is refused on the users screen too');

    const anonymous = await withTenant(conn, t1, (tdb) => tryRolesOverview(tdb, undefined));
    assert.equal((anonymous as { code: string }).code, 'unauthenticated');
  });
});

test('a created role holds exactly the keys the screen sent', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (conn) => {
    const token = await tokenFor(conn, t1, u1);

    const created = await withTenant(conn, t1, (tdb) =>
      createRoleIn(tdb, token, {
        name: 'Storekeeper',
        description: 'Receives and issues',
        keys: [PERMISSION.intakeCreate, PERMISSION.requisitionsIssue],
      }),
    );

    const overview = await withTenant(conn, t1, (tdb) => tryRolesOverview(tdb, token));
    assert.equal(overview.ok, true);
    const stored = overview.ok ? overview.data.roles.find((role) => role.id === created.roleId) : undefined;
    assert.ok(stored, 'the new role is listed');
    assert.deepEqual(stored!.permissionKeys, [PERMISSION.intakeCreate, PERMISSION.requisitionsIssue]);
    assert.equal(stored!.userCount, 0);

    // A key that does not exist grants nothing and is refused, not silently kept.
    await assert.rejects(
      () => withTenant(conn, t1, (tdb) => createRoleIn(tdb, token, { name: 'Bogus', keys: ['made:up:key'] })),
      (err: Error & { code?: string }) => err.code === 'invalid',
    );
  });
});

test('an edit is replaced whole, and the next check obeys it', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provisionTenants();

  await withDb(async (conn) => {
    const adminRole = await roleWith(conn, t1, 'Admin Two', [
      PERMISSION.rolesManage,
      PERMISSION.usersManage,
    ]);
    const admin = await userWith(conn, t1, 'admin_two', adminRole);
    const token = await tokenFor(conn, t1, admin);

    // It may administer right now…
    assert.equal((await withTenant(conn, t1, (tdb) => tryRolesOverview(tdb, token))).ok, true);

    // …and it may not, the moment the keys are taken away — no re-login.
    const kept = await withTenant(conn, t1, (tdb) =>
      setRolePermissionsIn(tdb, token, { roleId: adminRole, keys: [PERMISSION.usersManage] }),
    );
    assert.deepEqual(kept.keys, [PERMISSION.usersManage]);

    const after = await withTenant(conn, t1, (tdb) => tryRolesOverview(tdb, token));
    assert.equal(after.ok, false, 'the next request is refused without a new sign-in');
    assert.equal((after as { code: string }).code, 'forbidden');
  });
});

test('the tenant cannot remove its last administrator', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (conn) => {
    const token = await tokenFor(conn, t1, u1);

    // The seeded Owner's roles:manage is locked: it is how a fresh deployment
    // stays recoverable before anyone has been given a custom role.
    const ownerRole = await withTenant(conn, t1, (tdb) => ownerRoleId(tdb));
    await assert.rejects(
      () =>
        withTenant(conn, t1, (tdb) =>
          setRolePermissionsIn(tdb, token, { roleId: ownerRole, keys: [PERMISSION.usersManage] }),
        ),
      (err: Error & { code?: string }) => err.code === 'conflict',
      'the Owner role always keeps auth:roles:manage',
    );

    // A second administrator lets the first be reduced — the rule is "always at
    // least one", not "the Owner forever".
    const second = await roleWith(conn, t1, 'Admin Two', [PERMISSION.rolesManage]);
    await userWith(conn, t1, 'second_admin', second);
    const ok = await withTenant(conn, t1, (tdb) =>
      setRolePermissionsIn(tdb, token, { roleId: second, keys: [] }),
    );
    assert.deepEqual(ok.keys, [], 'with the Owner still holding it, emptying another role is fine');
  });
});

/** The built-in Owner role's id. */
async function ownerRoleId(tdb: { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> }) {
  const { rows } = await tdb.query<{ id: string }>(`select id from roles where name = 'Owner'`);
  return rows[0]!.id;
}

test('creating a person validates the username, the password and the role', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (conn) => {
    const token = await tokenFor(conn, t1, u1);
    const roleId = await withTenant(conn, t1, (tdb) => ownerRoleId(tdb));

    const created = await withTenant(conn, t1, (tdb) =>
      createUserIn(tdb, token, {
        name: 'Sara Zaki',
        username: 'SARA.ZAKI',
        password: 'a-long-enough-password',
        roleId,
      }),
    );
    assert.ok(created.userId);

    const stored = await withTenant(conn, t1, (tdb) =>
      tdb.query<{ username: string }>(`select username from app_users where id = $1`, [created.userId]),
    );
    assert.equal(stored.rows[0]!.username, 'sara.zaki', 'the username is stored normalised');

    await assert.rejects(
      () =>
        withTenant(conn, t1, (tdb) =>
          createUserIn(tdb, token, {
            name: 'Copy Cat',
            username: 'sara.zaki',
            password: 'a-long-enough-password',
            roleId,
          }),
        ),
      (err: Error & { code?: string }) => err.code === 'conflict',
      'a duplicate username is refused, not silently merged',
    );

    await assert.rejects(
      () =>
        withTenant(conn, t1, (tdb) =>
          createUserIn(tdb, token, { name: 'Short', username: 'short_pw', password: 'short', roleId }),
        ),
      (err: Error & { code?: string }) => err.code === 'invalid',
    );

    await assert.rejects(
      () =>
        withTenant(conn, t1, (tdb) =>
          createUserIn(tdb, token, { name: 'No Role', username: 'no_role', password: 'a-long-enough-password', roleId: '' }),
        ),
      (err: Error & { code?: string }) => err.code === 'invalid',
    );
  });
});

test('nobody may disable themselves or change their own role', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (conn) => {
    const token = await tokenFor(conn, t1, u1);
    const ownerRole = await withTenant(conn, t1, (tdb) => ownerRoleId(tdb));

    await assert.rejects(
      () => withTenant(conn, t1, (tdb) => setUserActiveIn(tdb, token, { userId: u1, active: false })),
      (err: Error & { code?: string }) => err.code === 'conflict',
      'disabling yourself ends the only session that could re-enable you',
    );

    await assert.rejects(
      () => withTenant(conn, t1, (tdb) => setUserRoleIn(tdb, token, { userId: u1, roleId: ownerRole })),
      (err: Error & { code?: string }) => err.code === 'conflict',
    );

    // Somebody ELSE may be disabled, and that is the offboarding hook.
    const clerkRole = await roleWith(conn, t1, 'Clerk', [PERMISSION.stockView]);
    const clerk = await userWith(conn, t1, 'clerk_two', clerkRole);
    await withTenant(conn, t1, (tdb) => setUserActiveIn(tdb, token, { userId: clerk, active: false }));
    const { rows } = await withTenant(conn, t1, (tdb) =>
      tdb.query<{ active: boolean }>(`select active from app_users where id = $1`, [clerk]),
    );
    assert.equal(rows[0]!.active, false);
  });
});

test('a password reset ends that person\'s live sessions', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (conn) => {
    const adminToken = await tokenFor(conn, t1, u1);
    const clerkRole = await roleWith(conn, t1, 'Clerk', [PERMISSION.stockView]);
    const clerk = await userWith(conn, t1, 'clerk_three', clerkRole);
    await tokenFor(conn, t1, clerk); // the clerk's own live session

    await withTenant(conn, t1, (tdb) =>
      resetPasswordIn(tdb, adminToken, { userId: clerk, password: 'a-brand-new-password' }),
    );

    const { rows } = await withTenant(conn, t1, (tdb) =>
      tdb.query<{ live: number }>(
        `select count(*)::int as live from sessions where user_id = $1 and revoked_at is null`,
        [clerk],
      ),
    );
    assert.equal(
      rows[0]!.live,
      0,
      'a reset is the response to a suspected compromise — it must not leave the old holder signed in',
    );
  });
});
