import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { withTenant } from '../../src/db/client.ts';
import { createItem, findByBarcode, setLocationLevel } from '../../src/db/items.ts';
import { createLocation } from '../../src/db/locations.ts';
import { migrateUrl, sqlTestUrl, withDb } from '../harness/sql.ts';

/**
 * Contract tests for `items`, `item_variants` and `location_levels`.
 *
 * Two things matter here beyond the ordinary tenancy shape:
 *
 *   1. An item ALWAYS has exactly one variant, so nothing downstream has to
 *      special-case a product with no size or colour.
 *   2. A scan that matches nothing returns null and *creates nothing*. The
 *      unknown-code path is the one a mistyped barcode takes, and it must never
 *      mint a new item.
 *
 * Tenants are provisioned over the OWNER connection (`migrateUrl()`); everything
 * the app does runs as the non-superuser `authenticated` role.
 */

type Provisioned = { t1: string; t2: string };

const provisionedTenants: string[] = [];

/** Creates two tenants, each with one app_user, over the OWNER connection. */
async function provision(): Promise<Provisioned> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const {
      rows: [t1],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Item One') returning id");
    const {
      rows: [t2],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Item Two') returning id");
    for (const [id, name] of [
      [t1!.id, 'A'],
      [t2!.id, 'B'],
    ] as const) {
      await owner.query(
        "insert into app_users (tenant_id, name, role, password_hash) values ($1, $2, 'owner', 'x')",
        [id, name],
      );
    }
    provisionedTenants.push(t1!.id, t2!.id);
    return { t1: t1!.id, t2: t2!.id };
  } finally {
    await owner.end();
  }
}

// Child rows first, for the foreign keys:
// location_levels → item_variants → items → locations → app_users → tenants.
after(async () => {
  if (provisionedTenants.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('delete from location_levels where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from item_variants where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from items where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from app_users where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from locations where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from tenants where id = any($1)', [provisionedTenants]);
  } finally {
    await owner.end();
  }
});

// Review Focus #1: an unknown or mistyped code must resolve to nothing and must
// NOT create an item. The count is the positive control — a findAll-shaped bug
// that silently inserted a placeholder row would pass a `=== null` assertion
// only if it also hid the row, so we count.
test('an unknown barcode returns null, never a new item', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    await withTenant(db, t1, async (tdb) => {
      const before = await tdb.query<{ n: number }>('select count(*)::int as n from items');

      const found = await findByBarcode(tdb, 'NOPE-1');
      assert.equal(found, null, 'an unknown barcode must resolve to null, not throw and not insert');

      const after = await tdb.query<{ n: number }>('select count(*)::int as n from items');
      assert.equal(
        after.rows[0]!.n,
        before.rows[0]!.n,
        'looking up an unknown barcode must not create an item',
      );
    });
  });
});

test('a scanned barcode round-trips through findByBarcode, normalised on lookup', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const created = await withTenant(db, t1, (tdb) =>
      createItem(tdb, { nameAr: 'فستان', nameEn: 'Dress', family: 'sellable', sku: 'dr-001', barcode: 'dr-001-m' }),
    );

    await withTenant(db, t1, async (tdb) => {
      // A raw, lower-cased scan with stray spaces must still hit the stored row.
      const found = await findByBarcode(tdb, '  DR-001-M ');
      assert.ok(found, 'the normalised lookup must find the stored variant');
      assert.equal(found.id, created.variant.id);
      assert.equal(found.barcode, 'DR-001-M', 'the stored barcode is canonicalised');
      assert.equal(found.sku, 'DR-001');
    });
  });
});

test('duplicate barcode within a tenant is rejected', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      createItem(tdb, { nameAr: 'دفتر', nameEn: 'Notebook', family: 'sellable', sku: 'NB-001', barcode: 'NB-001' }),
    );

    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () =>
          createItem(tdb, {
            nameAr: 'دفتر آخر',
            nameEn: 'Other notebook',
            family: 'sellable',
            sku: 'NB-002',
            barcode: 'NB-001',
          }),
        /duplicate key|unique/i,
        'a second variant with the same barcode in one tenant must be refused',
      );
    });
  });
});

test('the same barcode is allowed in a different tenant', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    const one = await withTenant(db, t1, (tdb) =>
      createItem(tdb, { nameAr: 'مقص', nameEn: 'Scissors', family: 'consumable', sku: 'SC-1', barcode: 'SC-1' }),
    );
    const two = await withTenant(db, t2, (tdb) =>
      createItem(tdb, { nameAr: 'مقص', nameEn: 'Scissors', family: 'consumable', sku: 'SC-1', barcode: 'SC-1' }),
    );

    assert.notEqual(one.variant.id, two.variant.id, 'the two tenants get their own rows');
    assert.equal(one.variant.barcode, 'SC-1');
    assert.equal(two.variant.barcode, 'SC-1', 'barcode uniqueness is per tenant, not global');

    // Isolation positive control: each tenant sees exactly its own row.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from item_variants where barcode = $1',
        ['SC-1'],
      );
      assert.equal(rows[0]!.n, 1, 'tenant one sees only its own variant');
    });
    await withTenant(db, t2, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from item_variants where barcode = $1',
        ['SC-1'],
      );
      assert.equal(rows[0]!.n, 1, 'tenant two sees only its own variant');
    });
  });
});

test('createItem always produces exactly one variant', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    await withTenant(db, t1, async (tdb) => {
      const created = await createItem(tdb, {
        nameAr: 'ورق تصوير',
        nameEn: 'Copy paper',
        family: 'consumable',
        sku: 'PAP-001',
        barcode: 'PAP-001',
        // No size and no colour: the variant still exists, with an empty attrs.
      });

      assert.equal(created.item.family, 'consumable');
      assert.equal(created.variant.item_id, created.item.id, 'the variant points at the item it was created with');
      assert.equal(created.variant.tenant_id, t1, 'the variant is owned by the scoped tenant');
      assert.deepEqual(
        created.variant.attrs,
        {},
        'an item with no size or colour gets an empty attrs object, not null and not a missing variant',
      );

      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from item_variants where item_id = $1',
        [created.item.id],
      );
      assert.equal(rows[0]!.n, 1, 'exactly one variant — never zero, never two');
    });
  });
});

test('min/max levels are stored per item per location', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const { item, branch, warehouse } = await withTenant(db, t1, async (tdb) => {
      const item = await createItem(tdb, {
        nameAr: 'صابون',
        nameEn: 'Soap',
        family: 'consumable',
        sku: 'SOAP-1',
        barcode: 'SOAP-1',
      });
      const branch = await createLocation(tdb, { code: 'BR-04', nameAr: 'فرع ٤', type: 'branch' });
      const warehouse = await createLocation(tdb, { code: 'WH-1', nameAr: 'المخزن', type: 'warehouse' });
      return { item: item.item, branch, warehouse };
    });

    // Two different levels for the same item, one per location.
    await withTenant(db, t1, (tdb) =>
      setLocationLevel(tdb, { itemId: item.id, locationId: branch.id, minQty: 10, maxQty: 50 }),
    );
    await withTenant(db, t1, (tdb) =>
      setLocationLevel(tdb, { itemId: item.id, locationId: warehouse.id, minQty: 100, maxQty: 500 }),
    );

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ location_id: string; min_qty: string; max_qty: string }>(
        'select location_id, min_qty, max_qty from location_levels where item_id = $1 order by min_qty',
        [item.id],
      );
      assert.equal(rows.length, 2, 'one level row per (item, location) pair');
      assert.deepEqual(
        rows.map((r) => [r.min_qty, r.max_qty]),
        [
          ['10.000', '50.000'],
          ['100.000', '500.000'],
        ],
        'each location keeps its own min/max',
      );
    });

    // Upsert, not duplicate: re-setting the branch level updates in place.
    await withTenant(db, t1, (tdb) =>
      setLocationLevel(tdb, { itemId: item.id, locationId: branch.id, minQty: 20, maxQty: 60 }),
    );
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ min_qty: string }>(
        'select min_qty from location_levels where item_id = $1 and location_id = $2',
        [item.id, branch.id],
      );
      assert.equal(rows.length, 1, 're-setting a level must update, not add a second row');
      assert.equal(rows[0]!.min_qty, '20.000');
    });
  });
});

// Regression for the normalisation CHECK: a raw SQL insert that bypasses
// src/db/items.ts must not be able to smuggle in a non-canonical barcode — the
// per-tenant unique index is case- and whitespace-sensitive and would then treat
// 'ab-0012 ' as a different product from 'AB-0012'. This test fails if the
// CHECK is dropped.
test('a raw insert of a non-normalised barcode is refused', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const item = await withTenant(db, t1, (tdb) =>
      createItem(tdb, { nameAr: 'قلم', nameEn: 'Pen', family: 'consumable', sku: 'PEN-1', barcode: 'PEN-1' }),
    );

    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () =>
          tdb.query(
            `insert into item_variants (tenant_id, item_id, sku, barcode)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 'PEN-2', ' pen-2 ')`,
            [item.item.id],
          ),
        /check constraint|item_variants_barcode_normalised_check/i,
        'a raw insert of a non-normalised barcode must be refused',
      );
    });
  });
});
