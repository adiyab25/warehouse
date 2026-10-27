import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from 'pg';

import { withTenant, newPool } from '../../src/db/client.ts';
import { migrateUrl, sqlTestUrl, withDb } from '../harness/sql.ts';

/**
 * Contract tests for tenant isolation.
 *
 * The shape every later table copies:
 *   - a `tenant_id uuid not null references tenants(id)` column, and
 *   - a policy `tenant_id = current_setting('app.tenant_id', true)::uuid`,
 *   - `alter table … force row level security` so even the owner is subject.
 *
 * Tenant creation is a *provisioning* action: it runs over the OWNER
 * connection (`migrateUrl()`), because the `tenants` policy is keyed on `id`
 * and cannot bootstrap itself. Everything the app does afterwards runs as the
 * non-superuser `authenticated` role, which is what makes these tests prove
 * something rather than pass trivially.
 */

type Provisioned = { t1: string; t2: string };

/** Creates two tenants and one app_user of each, over the OWNER connection. */
async function provision(): Promise<Provisioned> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const { rows: [t1] } = await owner.query<{ id: string }>(
      "insert into tenants (name) values ('KG One') returning id",
    );
    const { rows: [t2] } = await owner.query<{ id: string }>(
      "insert into tenants (name) values ('KG Two') returning id",
    );
    await owner.query(
      "insert into app_users (tenant_id, name, role, password_hash) values ($1, 'A', 'owner', 'x')",
      [t1!.id],
    );
    await owner.query(
      "insert into app_users (tenant_id, name, role, password_hash) values ($1, 'B', 'owner', 'x')",
      [t2!.id],
    );
    return { t1: t1!.id, t2: t2!.id };
  } finally {
    await owner.end();
  }
}

test('rows of one tenant are invisible to another', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ name: string }>('select name from app_users');
      assert.deepEqual(
        rows.map((r) => r.name),
        ['A'],
        'tenant one must see its own row and only its own row',
      );
    });
  });
});

// The positive control. Without it a policy that hid *everything* (or a table
// that is simply empty) would pass the isolation test above as "success".
test('the right tenant really does see its row', { skip: !sqlTestUrl() }, async () => {
  const { t2 } = await provision();

  await withDb(async (db) => {
    await withTenant(db, t2, async (tdb) => {
      const { rows } = await tdb.query<{ name: string }>('select name from app_users');
      assert.deepEqual(
        rows.map((r) => r.name),
        ['B'],
        'tenant two must see its own row — a policy that hides everything is not isolation',
      );
    });
  });
});

// A tenant that was never provisioned must see nothing at all, while a missing
// `app.tenant_id` must not accidentally expose rows (the `true` in
// current_setting means "return null, do not error").
test('an unknown tenant sees no rows', { skip: !sqlTestUrl() }, async () => {
  await provision();

  await withDb(async (db) => {
    await withTenant(db, '00000000-0000-0000-0000-000000000000', async (tdb) => {
      const { rows } = await tdb.query<{ name: string }>('select name from app_users');
      assert.deepEqual(rows, [], 'an unknown tenant id must match no rows');
    });
  });
});

// The INSERT half of the policy: the app may insert an app_user for the tenant
// it is currently scoped to, and must be refused for any other tenant.
test('an app_user can only be inserted for the current tenant', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    await withTenant(db, t1, async (tdb) => {
      await tdb.query(
        "insert into app_users (tenant_id, name, role, password_hash) values ($1, 'C', 'branch_user', 'x')",
        [t1],
      );

      await assert.rejects(
        () =>
          tdb.query(
            "insert into app_users (tenant_id, name, role, password_hash) values ($1, 'D', 'owner', 'x')",
            [t2],
          ),
        /row-level security|violates row-level/i,
        'inserting a row for another tenant must be refused by the with check clause',
      );
    });
  });
});

// Rule 4: provisioning is owner-only. With the policy in place and RLS forced,
// the app role simply cannot create a tenant — otherwise a tenant could forge
// one and escape its own isolation.
test('creating a tenant is a provisioning action the app role cannot perform', { skip: !sqlTestUrl() }, async () => {
  await withDb(async (db) => {
    await assert.rejects(
      () => db.query("insert into tenants (name) values ('Forged')"),
      /row-level security|violates row-level/i,
      'authenticated must not be able to create a tenant',
    );
  });
});

// The path routes take: a real Pool is checked out, used and released. The
// tests above all pass a bare Client, so without this the pooled branch of
// withTenant would never actually run.
test('withTenant works when handed a Pool', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();
  const pool = newPool(sqlTestUrl());
  try {
    const t1Names = await withTenant(pool, t1, async (tdb) => {
      const { rows } = await tdb.query<{ name: string }>('select name from app_users');
      return rows.map((r) => r.name);
    });
    const t2Names = await withTenant(pool, t2, async (tdb) => {
      const { rows } = await tdb.query<{ name: string }>('select name from app_users');
      return rows.map((r) => r.name);
    });

    assert.deepEqual(t1Names, ['A']);
    assert.deepEqual(t2Names, ['B'], 'the setting must not leak between pooled checkouts');
  } finally {
    await pool.end();
  }
});

// withTenant pins the tenant inside a transaction; a throw must roll the whole
// thing back, not leave a half-written row behind.
test('withTenant rolls back when fn throws', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    await assert.rejects(
      () =>
        withTenant(db, t1, async (tdb) => {
          await tdb.query(
            "insert into app_users (tenant_id, name, role, password_hash) values ($1, 'Rollback Probe', 'owner', 'x')",
            [t1],
          );
          throw new Error('boom');
        }),
      /boom/,
    );

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from app_users where name = 'Rollback Probe'",
      );
      assert.equal(rows[0]!.n, 0, 'the insert must have been rolled back');
    });
  });
});
