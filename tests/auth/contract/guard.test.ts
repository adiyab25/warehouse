import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createSession } from '@/modules/auth/index';
import { PERMISSION } from '@/modules/auth/keys';
import { AdminError } from '@/modules/admin/index';
import {
  ActionRefusal,
  refusalCodeOf,
  requirePermission,
  requireSession,
} from '@/modules/auth/guard';
import { withTenant } from '@/modules/platform/index';
import { sqlTestUrl, withDb } from '../../harness/sql.ts';
import { cleanupTenants, provisionTenants } from '../../harness/tenants.ts';

/**
 * THE ACTION GUARD — the check every write runs before it trusts its own form.
 *
 * This exists because four screens were written without it: they opened a pool,
 * pinned the tenant and wrote, so anything that could POST could create items,
 * post returns and open count sessions. The guard is the fix, and these tests
 * pin the three answers it can give.
 */

after(async () => {
  if (!sqlTestUrl()) return;
  await cleanupTenants();
});

test('no session is an `unauthenticated` refusal, never a write', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provisionTenants();

  await withDb(async (conn) => {
    await withTenant(conn, t1, async (tdb) => {
      await assert.rejects(
        () => requireSession(tdb, undefined),
        (err: Error & { code?: string }) => err.code === 'unauthenticated',
      );
      await assert.rejects(
        () => requirePermission(tdb, 'not-a-real-token', PERMISSION.countsCreate),
        (err: Error & { code?: string }) => err.code === 'unauthenticated',
        'a forged cookie is the same answer as no cookie',
      );
    });
  });
});

test('a signed-in person without the key is `forbidden`', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (conn) => {
    // The seeded Owner holds everything, so it may NOT stand in for this case.
    // A role with one unrelated key is the honest fixture.
    const roleId = await withTenant(conn, t1, async (tdb) => {
      const { rows } = await tdb.query<{ id: string }>(
        `insert into roles (tenant_id, name)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, 'Reader')
         returning id`,
      );
      const id = rows[0]!.id;
      await tdb.query(
        `insert into role_permissions (role_id, tenant_id, permission_key)
         values ($1, nullif(current_setting('app.tenant_id', true), '')::uuid, $2)`,
        [id, PERMISSION.stockView],
      );
      return id;
    });

    const clerk = await withTenant(conn, t1, async (tdb) => {
      const { rows } = await tdb.query<{ id: string }>(
        `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash, role_id)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, 'Reader One',
                 public.normalise_name('Reader One'), 'reader_one', 'branch_user', 'x', $1)
         returning id`,
        [roleId],
      );
      return rows[0]!.id;
    });

    const { token } = await withTenant(conn, t1, (tdb) => createSession(tdb, { userId: clerk }));

    await assert.rejects(
      () => withTenant(conn, t1, (tdb) => requirePermission(tdb, token, PERMISSION.countsCreate)),
      (err: Error & { code?: string }) => err.code === 'forbidden',
      'a role that does not hold the key is refused, even though it is signed in',
    );

    // …and the SAME session passes a key it does hold, so the refusal above is
    // about the permission and not about the session.
    const user = await withTenant(conn, t1, (tdb) => requirePermission(tdb, token, PERMISSION.stockView));
    assert.equal(user.displayName, 'Reader One');

    void u1;
  });
});

test('an owner passes, and the guard answers with the person', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (conn) => {
    const { token } = await withTenant(conn, t1, (tdb) => createSession(tdb, { userId: u1 }));
    const user = await withTenant(conn, t1, (tdb) =>
      requirePermission(tdb, token, PERMISSION.itemsManage),
    );
    assert.equal(user.userId, u1);
    assert.equal(user.role, 'owner');
  });
});

test('a refusal is recognised; a real fault is not disguised as one', () => {
  assert.equal(refusalCodeOf(new ActionRefusal('forbidden', 'x')), 'forbidden');
  assert.equal(refusalCodeOf(new AdminError('conflict', 'x')), 'conflict');
  assert.equal(
    refusalCodeOf(new Error('relation "stock_movements" does not exist')),
    null,
    'a broken query must NOT be reported as a permission problem',
  );
});
