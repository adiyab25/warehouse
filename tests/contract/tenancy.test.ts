import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client, Pool, type PoolClient } from 'pg';

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

// Every tenant this file creates, so the suite can delete what it provisioned
// instead of leaving rows behind on each run.
const provisionedTenants: string[] = [];

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
      "insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1, 'A', public.normalise_name('A'), 'user_a', 'owner', 'x')",
      [t1!.id],
    );
    await owner.query(
      "insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1, 'B', public.normalise_name('B'), 'user_b', 'owner', 'x')",
      [t2!.id],
    );
    provisionedTenants.push(t1!.id, t2!.id);
    return { t1: t1!.id, t2: t2!.id };
  } finally {
    await owner.end();
  }
}

// Deleting over the OWNER connection: `postgres` is a superuser, so it bypasses
// the forced RLS policies (as it must, to provision at all). Child rows first,
// for the foreign key.
after(async () => {
  if (provisionedTenants.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('delete from app_users where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from tenants where id = any($1)', [provisionedTenants]);
  } finally {
    await owner.end();
  }
});

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
        "insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1, 'C', public.normalise_name('C'), 'user_c', 'branch_user', 'x')",
        [t1],
      );

      await assert.rejects(
        () =>
          tdb.query(
            "insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1, 'D', public.normalise_name('D'), 'user_d', 'owner', 'x')",
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
            "insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1, 'Rollback Probe', public.normalise_name('Rollback Probe'), 'rollback_probe', 'owner', 'x')",
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

// withTenant is deliberately NOT re-entrant. Postgres does not nest BEGIN: a
// second BEGIN only warns, and the inner COMMIT commits the OUTER transaction,
// so a later rollback silently fails to undo any of it, and the outer call then
// dies on a cryptic error instead of the one that was thrown. The contract is
// that a nested call is refused *before* it can BEGIN.
test('a nested withTenant throws and does not commit anything', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    await assert.rejects(
      () =>
        withTenant(db, t1, async (tdb) => {
          await tdb.query(
            "insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1, 'Nested Probe', public.normalise_name('Nested Probe'), 'nested_probe', 'owner', 'x')",
            [t1],
          );

          // The nested call is refused, with the exact contract message.
          await assert.rejects(
            () => withTenant(tdb, t1, async () => {}),
            /withTenant: already inside a transaction/,
          );

          throw new Error('outer boom');
        }),
      /outer boom/,
      'the outer error must be the one that surfaces, not a nested COMMIT side effect',
    );

    // Had the nested call committed (the old bug), 'Nested Probe' would have
    // survived the outer rollback.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from app_users where name = 'Nested Probe'",
      );
      assert.equal(rows[0]!.n, 0, 'a nested withTenant must not commit the outer transaction');
    });
  });
});

// A wrapper around a Pool is not an `instanceof Pool`. The old detection
// silently took the single-connection branch for it: no `connect()`, no
// `release()`, and BEGIN + the transaction-local set_config landing on whichever
// backend each statement happened to get. Structural detection must take the
// pinned path instead.
type DelegatingPool = {
  connect(): Promise<PoolClient>;
  release(client: PoolClient): void;
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
};

test('withTenant pins the connection for a non-Pool delegating wrapper', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();
  const pool = newPool(sqlTestUrl());

  let connects = 0;
  const wrapper: DelegatingPool = {
    async connect() {
      connects += 1;
      return pool.connect();
    },
    release(client) {
      client.release();
    },
    query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      pool.query(sql, params) as unknown as Promise<{ rows: R[] }>,
  };

  assert.equal(wrapper instanceof Pool, false, 'the wrapper must not be a Pool instance');

  try {
    const t1Names = await withTenant(wrapper, t1, async (tdb) => {
      const { rows } = await tdb.query<{ name: string }>('select name from app_users');
      return rows.map((r) => r.name);
    });
    const t2Names = await withTenant(wrapper, t2, async (tdb) => {
      const { rows } = await tdb.query<{ name: string }>('select name from app_users');
      return rows.map((r) => r.name);
    });

    assert.equal(connects, 2, 'the wrapper must be detected as pool-like and have connect() called');
    assert.deepEqual(t1Names, ['A']);
    assert.deepEqual(t2Names, ['B'], 'the pinned tenant must not leak between checkouts');
  } finally {
    await pool.end();
  }
});

// A pooled connection that has already served a withTenant is *warm*: the
// transaction-local setting reverted to '' rather than NULL. The policy must
// treat that as "no tenant" and return 0 rows — under the old
// `current_setting(...)::uuid` it raised `invalid input syntax for type uuid:
// ""` on a warm connection while a cold one returned 0 rows.
test('a bare query on a warm pooled connection returns 0 rows, not a uuid error', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();
  const pool = newPool(sqlTestUrl());

  try {
    // Warm the single pooled connection.
    const seen = await withTenant(pool, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>('select count(*)::int as n from app_users');
      return rows[0]!.n;
    });
    assert.ok(seen > 0, 'the warm-up withTenant must actually see the tenant row');

    const { rows } = await pool.query<{ name: string }>('select name from app_users');
    assert.deepEqual(rows, [], "app.tenant_id = '' must match no rows, never throw");
  } finally {
    await pool.end();
  }
});
