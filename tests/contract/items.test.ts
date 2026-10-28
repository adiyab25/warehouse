import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { withTenant } from '../../src/db/client.ts';
import { createItem, findByBarcode, setLocationLevel, variantAttrs } from '../../src/db/items.ts';
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

// Covers Review Focus #1's "always exactly one variant" AND the atomicity
// contract: createItem writes two rows, so a failure on the SECOND insert must
// roll the first back. A happy-path row count would not prove that; this test
// INJECTS a failure (the variant collides with an existing barcode in the same
// tenant) after the item insert has already run, and asserts no orphan item
// survives. It fails if createItem is not run inside a transaction.
test('createItem is atomic: a variant failure leaves no orphan item, and a success is exactly one variant', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const first = await withTenant(db, t1, (tdb) =>
      createItem(tdb, {
        nameAr: 'ورق تصوير',
        nameEn: 'Copy paper',
        family: 'consumable',
        sku: 'PAP-001',
        barcode: 'PAP-001',
        // No size and no colour: the variant still exists, with an empty attrs.
      }),
    );

    // Positive control: the successful create is exactly one variant with an
    // empty attrs (not null, not a missing variant).
    assert.equal(first.item.family, 'consumable');
    assert.equal(first.variant.item_id, first.item.id, 'the variant points at the item it was created with');
    assert.equal(first.variant.tenant_id, t1, 'the variant is owned by the scoped tenant');
    assert.deepEqual(
      first.variant.attrs,
      {},
      'an item with no size or colour gets an empty attrs object, not null and not a missing variant',
    );
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from item_variants where item_id = $1',
        [first.item.id],
      );
      assert.equal(rows[0]!.n, 1, 'exactly one variant — never zero, never two');
    });

    // Failure injection: the item row inserts fine, then the variant insert
    // collides with PAP-001 already present in this tenant.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          createItem(tdb, {
            nameAr: 'ورق آخر',
            nameEn: 'Orphan paper',
            family: 'consumable',
            sku: 'PAP-002',
            barcode: 'PAP-001',
          }),
        ),
      /duplicate key|unique/i,
      'a second variant with the same barcode in one tenant must be refused',
    );

    // The whole thing rolled back: no orphan item named 'Orphan paper'.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from items where name_en = 'Orphan paper'",
      );
      assert.equal(
        rows[0]!.n,
        0,
        'the failed createItem must roll back its item row too — no orphan item may survive',
      );
    });
  });
});

// I1(b): the writer must refuse the same malformed codes the scanner rejects
// before lookup, so it can never mint a catalogue item a scan could never reach.
test('createItem refuses a malformed sku or barcode with a named error', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    for (const [field, input] of [
      ['sku', { sku: '', barcode: 'AB-0012' }],
      ['sku', { sku: 'X', barcode: 'AB-0012' }],
      ['barcode', { sku: 'AB-0012', barcode: '' }],
      ['barcode', { sku: 'AB-0012', barcode: 'X' }],
    ] as const) {
      await assert.rejects(
        () =>
          withTenant(db, t1, (tdb) =>
            createItem(tdb, {
              nameAr: 'عنصر',
              family: 'consumable',
              ...input,
            }),
          ),
        new RegExp(`createItem: ${field} .*is not a valid scanned code`),
        `${field} ${JSON.stringify(input[field])} must be refused, naming the field`,
      );
    }

    // And nothing was written.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>('select count(*)::int as n from items');
      assert.equal(rows[0]!.n, 0, 'a refused createItem must not write any item');
    });
  });
});

// C1 / Review Focus #1: a deactivated label behaves exactly like an unknown
// code — it resolves to null, does not throw, and does not invent a distinct
// error. Dropping either `active` predicate fails this.
test('a deactivated item or variant scans as an unknown code', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const created = await withTenant(db, t1, (tdb) =>
      createItem(tdb, { nameAr: 'حزام', nameEn: 'Belt', family: 'sellable', sku: 'BEL-1', barcode: 'BEL-1' }),
    );

    // Positive control: both active ⇒ the variant is found.
    await withTenant(db, t1, async (tdb) => {
      const found = await findByBarcode(tdb, 'BEL-1');
      assert.ok(found, 'an active item and variant must scan');
      assert.equal(found.id, created.variant.id);
    });

    // Deactivate the ITEM only.
    await withTenant(db, t1, (tdb) => tdb.query('update items set active = false where id = $1', [created.item.id]));
    await withTenant(db, t1, async (tdb) => {
      assert.equal(await findByBarcode(tdb, 'BEL-1'), null, 'a deactivated item must scan as unknown');
    });

    // Restore the item, deactivate the VARIANT only.
    await withTenant(db, t1, (tdb) => tdb.query('update items set active = true where id = $1', [created.item.id]));
    await withTenant(db, t1, (tdb) =>
      tdb.query('update item_variants set active = false where id = $1', [created.variant.id]),
    );
    await withTenant(db, t1, async (tdb) => {
      assert.equal(await findByBarcode(tdb, 'BEL-1'), null, 'a deactivated variant must scan as unknown');
    });

    // Restore both ⇒ found again (the row was never deleted).
    await withTenant(db, t1, (tdb) =>
      tdb.query('update item_variants set active = true where id = $1', [created.variant.id]),
    );
    await withTenant(db, t1, async (tdb) => {
      const found = await findByBarcode(tdb, 'BEL-1');
      assert.ok(found, 'reactivating both must make the label scan again');
    });
  });
});

// C2: cross-table foreign keys are tenant-scoped. A variant in tenant A may not
// reference tenant B's item. Dropping the composite FK on item_variants makes
// this test fail (the insert would be accepted).
test('a variant may not reference another tenant\u2019s item', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    const foreign = await withTenant(db, t2, (tdb) =>
      createItem(tdb, { nameAr: 'صندوق', nameEn: 'Box', family: 'asset', sku: 'BOX-1', barcode: 'BOX-1' }),
    );
    const local = await withTenant(db, t1, (tdb) =>
      createItem(tdb, { nameAr: 'صندوق', nameEn: 'Box', family: 'asset', sku: 'BOX-1', barcode: 'BOX-1' }),
    );

    // tenant_id is t1 (the scoped tenant), but item_id is tenant B's. Its own
    // transaction, because a refused statement aborts the enclosing one.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query(
            `insert into item_variants (tenant_id, item_id, sku, barcode)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 'XT-1', 'XT-1')`,
            [foreign.item.id],
          ),
        ),
      /foreign key|item_variants_tenant_id_item_id_fkey/i,
      'a variant in tenant A referencing tenant B\u2019s item must be refused',
    );

    // Positive control: the same-tenant link succeeds.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ id: string }>(
        `insert into item_variants (tenant_id, item_id, sku, barcode)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 'OK-1', 'OK-1')
         returning id`,
        [local.item.id],
      );
      assert.ok(rows[0]?.id, 'a variant referencing a same-tenant item must be accepted');
    });
  });
});

// C2: a location_level in tenant A may not reference tenant B's item OR
// location. Dropping either composite FK makes the matching case fail.
test('a location level may not reference another tenant\u2019s item or location', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    const foreign = await withTenant(db, t2, async (tdb) => {
      const item = await createItem(tdb, {
        nameAr: 'كرسي',
        nameEn: 'Chair',
        family: 'asset',
        sku: 'CH-1',
        barcode: 'CH-1',
      });
      const loc = await createLocation(tdb, { code: 'BR-9', nameAr: 'فرع ٩', type: 'branch' });
      return { item: item.item, loc };
    });
    const local = await withTenant(db, t1, async (tdb) => {
      const item = await createItem(tdb, {
        nameAr: 'كرسي',
        nameEn: 'Chair',
        family: 'asset',
        sku: 'CH-1',
        barcode: 'CH-1',
      });
      const loc = await createLocation(tdb, { code: 'BR-1', nameAr: 'فرع ١', type: 'branch' });
      return { item: item.item, loc };
    });

    // Cross-tenant ITEM, same-tenant location. Each expected failure gets its
    // own transaction: a refused statement aborts the enclosing one.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          setLocationLevel(tdb, { itemId: foreign.item.id, locationId: local.loc.id, minQty: 1, maxQty: 2 }),
        ),
      /foreign key|location_levels_tenant_id_item_id_fkey/i,
      'a level in tenant A referencing tenant B\u2019s item must be refused',
    );

    // Same-tenant item, cross-tenant LOCATION.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          setLocationLevel(tdb, { itemId: local.item.id, locationId: foreign.loc.id, minQty: 1, maxQty: 2 }),
        ),
      /foreign key|location_levels_tenant_id_location_id_fkey/i,
      'a level in tenant A referencing tenant B\u2019s location must be refused',
    );

    // Positive control: both same-tenant succeeds.
    await withTenant(db, t1, async (tdb) => {
      await setLocationLevel(tdb, { itemId: local.item.id, locationId: local.loc.id, minQty: 1, maxQty: 2 });
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from location_levels where item_id = $1 and location_id = $2',
        [local.item.id, local.loc.id],
      );
      assert.equal(rows[0]!.n, 1, 'a same-tenant level must be accepted');
    });
  });
});

// I2: min > max is refused; a NULL on either side (min-only / max-only /
// both-null) is accepted. Dropping the CHECK makes the first case fail.
test('a location level refuses min greater than max, and accepts a half-open or empty bound', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const { item, loc } = await withTenant(db, t1, async (tdb) => {
      const item = await createItem(tdb, {
        nameAr: 'مسطرة',
        nameEn: 'Ruler',
        family: 'consumable',
        sku: 'RUL-1',
        barcode: 'RUL-1',
      });
      const loc = await createLocation(tdb, { code: 'WH-7', nameAr: 'مخزن ٧', type: 'warehouse' });
      return { item: item.item, loc };
    });

    // min > max is nonsense. Its own transaction — a refused statement aborts
    // the enclosing one.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          setLocationLevel(tdb, { itemId: item.id, locationId: loc.id, minQty: 500, maxQty: 10 }),
        ),
      /location_levels_min_le_max_check|check constraint/i,
      'a level with min above its max must be refused',
    );

    // min-only, max-only and both-null are all real levels and must be stored.
    await withTenant(db, t1, async (tdb) => {
      await setLocationLevel(tdb, { itemId: item.id, locationId: loc.id, minQty: 5 });
      await setLocationLevel(tdb, { itemId: item.id, locationId: loc.id, maxQty: 50 });
      await setLocationLevel(tdb, { itemId: item.id, locationId: loc.id });

      const { rows } = await tdb.query<{ min_qty: string | null; max_qty: string | null }>(
        'select min_qty, max_qty from location_levels where item_id = $1 and location_id = $2',
        [item.id, loc.id],
      );
      assert.equal(rows.length, 1, 'one level row per (item, location)');
      assert.deepEqual(
        [rows[0]!.min_qty, rows[0]!.max_qty],
        [null, null],
        'the final both-null set leaves a null/null row',
      );
    });
  });
});

// I3: variantAttrs narrows the jsonb `attrs` to a typed object and guards
// against a non-object value without throwing.
test('variantAttrs returns a typed object and guards a non-object', () => {
  const base = { id: 'v', tenant_id: 't', item_id: 'i', sku: 'A-1', barcode: 'A-1', active: true };

  assert.deepEqual(
    variantAttrs({ ...base, attrs: { size: 'M', colour: 'red' } } as never),
    { size: 'M', colour: 'red' },
    'a well-formed object passes through',
  );
  for (const bad of [null, 'a string', 7, ['x']]) {
    assert.deepEqual(
      variantAttrs({ ...base, attrs: bad } as never),
      {},
      `a non-object attrs (${JSON.stringify(bad)}) must narrow to {} rather than throw`,
    );
  }
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
