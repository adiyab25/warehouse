import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { can, PERMISSION } from '@/modules/auth/keys';
import { currentUser } from '@/modules/auth/index';
import { createSession, readSession } from '@/modules/auth/index';
import { withTenant } from '@/modules/platform/index';
import { sqlTestUrl, withDb } from '../../harness/sql.ts';
import { cleanupTenants, provisionTenants } from '../../harness/tenants.ts';

/**
 * `currentUser(db, cookieValue)` — the ONE place a cookie becomes a person.
 *
 * The front door had no gate: `readSession` had no caller in src/app, `/` was a
 * static page, and nothing read the session cookie. This is the seam the gate
 * calls, so it is tested directly — with real sessions in a real database, and
 * with every way a cookie can stop being a person.
 *
 * It resolves inside the caller's EXISTING `withTenant` scope (this module never
 * opens one), which is what makes the tenant in the result provably the
 * deployment's own: the same token resolved under a different tenant's scope is
 * a miss, because the session row is invisible there.
 */

const EMPTY: string | undefined = undefined;

after(async () => {
  if (!sqlTestUrl()) return;
  await cleanupTenants();
});

test('a live session cookie resolves to the person, with their display name', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1, username1 } = await provisionTenants();

  await withDb(async (db) => {
    const { token } = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));

    const user = await withTenant(db, t1, (tdb) => currentUser(tdb, token));
    assert.ok(user, 'a live session must resolve to a user');
    assert.equal(user.userId, u1);
    assert.equal(user.tenantId, t1);
    assert.equal(user.role, 'owner');
    assert.equal(user.username, username1, 'the assigned username comes back too');
    assert.equal(
      user.displayName,
      'Owner One',
      'the DISPLAY name is what a screen shows — the name as typed, not the username',
    );
  });
});

test('no cookie, an empty cookie and a garbage cookie are all simply "not signed in"', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provisionTenants();

  await withDb(async (db) => {
    await withTenant(db, t1, async (tdb) => {
      assert.equal(await currentUser(tdb, EMPTY), null, 'an absent cookie is a miss');
      assert.equal(await currentUser(tdb, ''), null, 'an empty cookie is a miss');
      assert.equal(await currentUser(tdb, null), null, 'a null cookie is a miss');
      assert.equal(await currentUser(tdb, 'not-a-real-token'), null, 'an unknown token is a miss');
      assert.equal(await currentUser(tdb, 'a'.repeat(64)), null, 'a well-formed but unknown token is a miss');
    });
  });
});

test('an expired, revoked or deactivated session is a miss', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (db) => {
    // EXPIRED: a session whose expires_at is already in the past.
    const expired = await withTenant(db, t1, (tdb) =>
      createSession(tdb, { userId: u1, ttlMs: -1000 }),
    );
    assert.equal(
      await withTenant(db, t1, (tdb) => currentUser(tdb, expired.token)),
      null,
      'an expired session must not resolve',
    );

    // REVOKED.
    const revoked = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));
    await withTenant(db, t1, (tdb) =>
      tdb.query('update sessions set revoked_at = now() where user_id = $1', [u1]),
    );
    assert.equal(
      await withTenant(db, t1, (tdb) => currentUser(tdb, revoked.token)),
      null,
      'a revoked session must not resolve',
    );

    // DEACTIVATED USER — the offboarding hook: setting `active = false` ends
    // every live session without hunting down individual tokens.
    await withTenant(db, t1, (tdb) => tdb.query('update sessions set revoked_at = null'));
    const live = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));
    assert.ok(
      await withTenant(db, t1, (tdb) => currentUser(tdb, live.token)),
      'the session is live while the user is active',
    );
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set active = false where id = $1', [u1]),
    );
    assert.equal(
      await withTenant(db, t1, (tdb) => currentUser(tdb, live.token)),
      null,
      'deactivating the user must end the session immediately',
    );
    await withTenant(db, t1, (tdb) => tdb.query('update app_users set active = true where id = $1', [u1]));
  });
});

test('a session of one tenant does not resolve under another tenant', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2, u1 } = await provisionTenants();

  await withDb(async (db) => {
    const { token } = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));

    // Visible in its own tenant...
    assert.ok(await withTenant(db, t1, (tdb) => currentUser(tdb, token)));
    // ...and invisible in another, which is why the cookie never has to carry a
    // tenant id and why the deployment's configured tenant is the only scope a
    // session can be read in.
    assert.equal(
      await withTenant(db, t2, (tdb) => currentUser(tdb, token)),
      null,
      "one tenant's session cookie must be meaningless in another tenant",
    );
    assert.equal(await withTenant(db, t2, (tdb) => readSession(tdb, token)), null);
  });
});

// ---------------------------------------------------------------------------
// The PERMISSION SET (P1 1A.3).
//
// `role` says whose data a person sees; `permissions` says what they may DO.
// The set is resolved with the session on every request — never cached at
// sign-in — so a tenant that edits a role is obeyed on the very next request,
// which is the decision (D3) that made session version bumps unnecessary for
// permission edits.
// ---------------------------------------------------------------------------

test('the session carries the permission set of the assigned role', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (db) => {
    const { token } = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));
    const user = await withTenant(db, t1, (tdb) => currentUser(tdb, token));

    assert.ok(user);
    assert.ok(
      can(user.permissions, PERMISSION.requisitionsApprove),
      'the seeded Owner role holds every permission, so approving is allowed',
    );
    assert.equal(
      can(user.permissions, 'made:up:key'),
      false,
      'a key that does not exist grants nothing — an unknown key must deny',
    );
  });
});

test('editing the role changes the NEXT request, with no re-login', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provisionTenants();

  await withDb(async (db) => {
    // A tenant-created role that may ONLY approve — not a name the code knows.
    const userId = await withTenant(db, t1, async (tdb) => {
      const { rows: role } = await tdb.query<{ id: string }>(
        `insert into roles (tenant_id, name, description)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, 'Approver', 'approve only')
         returning id`,
      );
      const roleId = role[0]!.id;
      await tdb.query(
        `insert into role_permissions (role_id, tenant_id, permission_key)
         values ($1, nullif(current_setting('app.tenant_id', true), '')::uuid, $2)`,
        [roleId, PERMISSION.requisitionsApprove],
      );
      const { rows: user } = await tdb.query<{ id: string }>(
        `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash, role_id)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, 'Approver One',
                 public.normalise_name('Approver One'), 'approver_one', 'branch_user', 'x', $1)
         returning id`,
        [roleId],
      );
      return user[0]!.id;
    });

    const { token } = await withTenant(db, t1, (tdb) => createSession(tdb, { userId }));
    const first = await withTenant(db, t1, (tdb) => currentUser(tdb, token));
    assert.ok(first);
    assert.equal(
      can(first.permissions, PERMISSION.requisitionsApprove),
      true,
      'a role the tenant invented grants exactly what it lists',
    );
    assert.equal(
      can(first.permissions, PERMISSION.requisitionsIssue),
      false,
      'and nothing it does not list',
    );

    // Revoke the permission behind the SAME live session.
    await withTenant(db, t1, (tdb) =>
      tdb.query('delete from role_permissions where permission_key = $1', [PERMISSION.requisitionsApprove]),
    );

    const second = await withTenant(db, t1, (tdb) => currentUser(tdb, token));
    assert.ok(second, 'the session is still live — permissions changed, not the sign-in');
    assert.equal(
      can(second.permissions, PERMISSION.requisitionsApprove),
      false,
      'the next request must see the edit, with no re-login and no version bump',
    );
  });
});
