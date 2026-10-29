import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { withTenant } from '@/modules/platform/index';
import { createLocation, transitLocation } from '@/modules/locations/index';
import { migrateUrl, sqlTestUrl, withDb } from '../../harness/sql.ts';

/**
 * Contract tests for `locations` — the single table every physical place in the
 * backbone is a row of: the warehouse, its bins, each branch, the in-transit
 * bucket, vendors, scrap and the people who hold stock.
 *
 * The table copies the shape 0002 established for every tenant-scoped table:
 *   - `tenant_id uuid not null references tenants(id)`,
 *   - a policy `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
 *     carrying BOTH `using` and `with check`,
 *   - `alter table … force row level security` so even the owner is bound.
 *
 * Tenants are *provisioned* over the OWNER connection (`migrateUrl()`) — the
 * `tenants` policy is keyed on `id` and cannot bootstrap itself. Everything the
 * app does afterwards runs as the non-superuser `authenticated` role, which is
 * what makes these tests prove something rather than pass trivially.
 */

type Provisioned = { t1: string; t2: string };

// Every tenant this file creates, so the suite can delete what it provisioned
// instead of leaving rows behind on each run.
const provisionedTenants: string[] = [];

/** Creates two tenants, each with one app_user, over the OWNER connection. */
async function provision(): Promise<Provisioned> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const {
      rows: [t1],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Loc One') returning id");
    const {
      rows: [t2],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Loc Two') returning id");
    for (const [id, name, username] of [
      [t1!.id, 'A', 'user_a'],
      [t2!.id, 'B', 'user_b'],
    ] as const) {
      await owner.query(
        "insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1, $2, public.normalise_name($2), $3, 'owner', 'x')",
        [id, name, username],
      );
    }
    provisionedTenants.push(t1!.id, t2!.id);
    return { t1: t1!.id, t2: t2!.id };
  } finally {
    await owner.end();
  }
}

// Deleting over the OWNER connection: `postgres` is a superuser, so it bypasses
// the forced RLS policies (as it must, to provision and clean up at all).
// Child rows first, for the foreign keys: app_users → locations → tenants.
after(async () => {
  if (provisionedTenants.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('delete from app_users where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from locations where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from tenants where id = any($1)', [provisionedTenants]);
  } finally {
    await owner.end();
  }
});

test('a branch is a location with its own code', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    await withTenant(db, t1, async (tdb) => {
      const branch = await createLocation(tdb, {
        code: 'BR-04',
        nameAr: 'فرع ٤',
        nameEn: 'Branch 4',
        type: 'branch',
      });

      assert.equal(branch.code, 'BR-04', 'the row stores the code it was created with');
      assert.equal(branch.type, 'branch');
      assert.equal(branch.tenant_id, t1, 'the row is owned by the scoped tenant, not a caller-supplied one');

      // Positive control: an INSERT … RETURNING can hand back a row even when a
      // SELECT policy would hide it, so assert visibility with a plain SELECT.
      // A policy that hides everything would pass the assertions above and fail
      // this one.
      const { rows } = await tdb.query<{ code: string }>('select code from locations where code = $1', [
        'BR-04',
      ]);
      assert.deepEqual(
        rows.map((r) => r.code),
        ['BR-04'],
        'the branch must be visible to a plain SELECT in its own tenant',
      );

      const { rows: counted } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from locations',
      );
      assert.equal(counted[0]!.n, 1, 'a branch is exactly one row');
    });
  });
});

test('transit is a singleton per tenant', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    // Two separate transactions stand in for two concurrent callers: the
    // insert-on-conflict-do-nothing must keep both on the same row rather than
    // racing a second transit row into existence.
    const first = await withTenant(db, t1, (tdb) => transitLocation(tdb));
    const second = await withTenant(db, t1, (tdb) => transitLocation(tdb));

    assert.equal(first.id, second.id, 'both calls must resolve the same transit row');
    assert.equal(first.type, 'transit');
    assert.equal(first.tenant_id, t1);

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from locations where type = 'transit'",
      );
      assert.equal(rows[0]!.n, 1, 'there must be exactly one transit row for the tenant');
    });
  });
});

test('a holder location represents a person', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    await withTenant(db, t1, async (tdb) => {
      const holder = await createLocation(tdb, { code: 'EMP-1', nameAr: 'Ahmed', type: 'holder' });

      assert.equal(holder.type, 'holder');
      assert.equal(holder.name_ar, 'Ahmed', 'a holder carries the person’s name');

      const { rows } = await tdb.query<{ name_ar: string }>(
        "select name_ar from locations where type = 'holder'",
      );
      assert.deepEqual(
        rows.map((r) => r.name_ar),
        ['Ahmed'],
        'the holder must be visible to a plain SELECT in its own tenant',
      );
    });
  });
});

// The positive control for isolation: a policy that hid *everything* would make
// the "invisible to another tenant" assertion below pass as success. These two
// must be read together — one tenant must not see the row, the other must.
test('a location of one tenant is invisible to another, visible to its own', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      createLocation(tdb, { code: 'BR-04', nameAr: 'فرع ٤', type: 'branch' }),
    );

    await withTenant(db, t2, async (tdb) => {
      const { rows } = await tdb.query<{ code: string }>('select code from locations');
      assert.deepEqual(rows, [], 'tenant two must not see tenant one’s location');
    });

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ code: string }>('select code from locations');
      assert.deepEqual(
        rows.map((r) => r.code),
        ['BR-04'],
        'tenant one must see its own location — hiding everything is not isolation',
      );
    });
  });
});

// The INSERT half of the policy (`with check`): the app may insert a location
// for the tenant it is scoped to, and must be refused for any other tenant.
test('a location can only be inserted for the current tenant', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () =>
          tdb.query(
            "insert into locations (tenant_id, code, name_ar, type) values ($1, 'FORGED', 'x', 'branch')",
            [t2],
          ),
        /row-level security|violates row-level/i,
        'inserting a location for another tenant must be refused by the with check clause',
      );
    });
  });
});

// The second half of the migration: the foreign key 0002 deliberately deferred.
// app_users.branch_location_id must now reference a real locations row.
test('app_users.branch_location_id references locations', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const branch = await withTenant(db, t1, (tdb) =>
      createLocation(tdb, { code: 'BR-04', nameAr: 'فرع ٤', type: 'branch' }),
    );

    // A rejected statement aborts the transaction, so the failure probe gets
    // its own withTenant and the success probe gets another.
    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () =>
          tdb.query("update app_users set branch_location_id = '00000000-0000-0000-0000-000000000000'"),
        /foreign key|violates foreign key/i,
        'a branch_location_id must point at an existing location',
      );
    });

    await withTenant(db, t1, async (tdb) => {
      await tdb.query('update app_users set branch_location_id = $1', [branch.id]);
      const { rows } = await tdb.query<{ branch_location_id: string | null }>(
        'select branch_location_id from app_users',
      );
      assert.equal(rows[0]!.branch_location_id, branch.id, 'the app_user now points at the branch');
    });
  });
});

// A bin is not a top-level place: it hangs off the warehouse it sits in. The
// linkage must round-trip through the column, not just be accepted on insert.
test('a bin can be created under a warehouse and the linkage reads back', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const { warehouse, bin } = await withTenant(db, t1, async (tdb) => {
      const warehouse = await createLocation(tdb, { code: 'WH-1', nameAr: 'المخزن', type: 'warehouse' });
      const bin = await createLocation(tdb, {
        code: 'BIN-1',
        nameAr: 'رف ١',
        type: 'bin',
        parentId: warehouse.id,
      });
      return { warehouse, bin };
    });

    assert.equal(bin.type, 'bin');
    assert.equal(bin.parent_id, warehouse.id, 'the bin records its parent on insert');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ parent_id: string | null }>(
        'select parent_id from locations where code = $1',
        ['BIN-1'],
      );
      assert.equal(rows[0]!.parent_id, warehouse.id, 'the linkage is readable back from the database');
    });
  });
});

// Regression for the tenant-blind parent: a plain `references locations(id)`
// accepts ANY tenant's id, so a bin in tenant A could silently parent off a
// location in tenant B and graft one branch's history onto another. The
// composite `foreign key (tenant_id, parent_id) references locations (tenant_id,
// id)` must refuse it. This test fails if the composite FK is removed.
test('a bin cannot parent off a location in another tenant', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    const foreignParent = await withTenant(db, t2, (tdb) =>
      createLocation(tdb, { code: 'BR-99', nameAr: 'فرع ب', type: 'branch' }),
    );
    const warehouse = await withTenant(db, t1, (tdb) =>
      createLocation(tdb, { code: 'WH-1', nameAr: 'المخزن', type: 'warehouse' }),
    );

    // A rejected statement aborts the transaction, so the failure probe gets its
    // own withTenant and the positive control gets another.
    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () =>
          createLocation(tdb, {
            code: 'BIN-X',
            nameAr: 'x',
            type: 'bin',
            parentId: foreignParent.id,
          }),
        /foreign key|violates foreign key/i,
        'a bin must not parent off a location owned by another tenant',
      );
    });

    // Positive control: the identical insert succeeds with a same-tenant parent,
    // so the refusal above proves tenancy, not that the FK rejects everything.
    await withTenant(db, t1, (tdb) =>
      createLocation(tdb, { code: 'BIN-OK', nameAr: 'y', type: 'bin', parentId: warehouse.id }),
    );
  });
});

// `active` is how a location is retired without deleting the history that points
// at it. It must default on, and must be flip-off-able.
test('a location is active by default and can be deactivated', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const loc = await withTenant(db, t1, (tdb) =>
      createLocation(tdb, { code: 'BR-07', nameAr: 'فرع ٧', type: 'branch' }),
    );
    assert.equal(loc.active, true, 'a freshly created location is active');

    const deactivated = await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ active: boolean }>(
        'update locations set active = false where id = $1 returning active',
        [loc.id],
      );
      return rows[0]!;
    });
    assert.equal(deactivated.active, false, 'a location can be deactivated');
  });
});

// Regression for the type CHECK: Task 8's returns route damaged goods to a
// quarantine location, so 'quarantine' must be an accepted type — and the CHECK
// must still reject a type it does not know. This test fails if the CHECK is
// dropped (a bogus type would then be accepted).
test('the type CHECK accepts quarantine and rejects a bogus type', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const quarantine = await withTenant(db, t1, (tdb) =>
      createLocation(tdb, { code: 'QRN-1', nameAr: 'حجر', type: 'quarantine' }),
    );
    assert.equal(quarantine.type, 'quarantine', "'quarantine' is an accepted location type");

    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () =>
          tdb.query(
            "insert into locations (tenant_id, code, name_ar, type) values (nullif(current_setting('app.tenant_id', true), '')::uuid, 'BOGUS', 'x', 'nonsense')",
          ),
        /check constraint/i,
        'a type the CHECK does not list must be refused',
      );
    });
  });
});

// Regression for code normalisation: `unique (tenant_id, code)` is case- and
// whitespace-sensitive, so without canonicalising, 'BR-04', 'br-04' and
// 'BR-04 ' would be three codes and silently split one branch's history in two.
// createLocation canonicalises; the database CHECK refuses a raw insert that
// does not. This test fails if the CHECK is dropped (a raw non-normalised insert
// would then succeed).
test('location codes are normalised to upper-case and trimmed', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const loc = await withTenant(db, t1, (tdb) =>
      createLocation(tdb, { code: ' br-04 ', nameAr: 'فرع ٤', type: 'branch' }),
    );
    assert.equal(loc.code, 'BR-04', 'createLocation trims and upper-cases the code');

    // A different spelling of the same code must collide on the unique index.
    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () => createLocation(tdb, { code: 'Br-04', nameAr: 'فرع ٤ مكرر', type: 'branch' }),
        /duplicate key|unique/i,
        'a second spelling of an existing code must be refused',
      );
    });

    // The database refuses a non-normalised code even when a raw SQL insert
    // bypasses createLocation's normalisation.
    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () =>
          tdb.query(
            "insert into locations (tenant_id, code, name_ar, type) values (nullif(current_setting('app.tenant_id', true), '')::uuid, 'br-99', 'x', 'branch')",
          ),
        /check constraint|locations_code_normalised_check/i,
        'a raw insert of a non-normalised code must be refused',
      );
    });
  });
});

