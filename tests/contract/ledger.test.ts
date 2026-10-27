import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { withTenant } from '../../src/db/client.ts';
import { createItem } from '../../src/db/items.ts';
import { createLocation } from '../../src/db/locations.ts';
import { movementHistory, onHand, postMovement } from '../../src/db/movements.ts';
import { migrateUrl, sqlTestUrl, withDb } from '../harness/sql.ts';

/**
 * Contract tests for the stock ledger: `stock_movements`, the `on_hand` view
 * and the posting interface.
 *
 * The ledger is the truth of the system, so the properties that matter are:
 *
 *   - `on_hand` is exactly the signed sum of the rows (nothing else is stored);
 *   - a row can never be UPDATEd or DELETEd — corrections are new rows;
 *   - a re-sent movement carrying an idempotency key lands once;
 *   - a movement may only touch an ACTIVE item/variant, and only its own tenant;
 *   - the `on_hand` view is `security_invoker`, so it never leaks across tenants.
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
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Ledger One') returning id");
    const {
      rows: [t2],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Ledger Two') returning id");
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

// Cleanup. `stock_movements` refuses DELETE by design, so the cleanup runs with
// `session_replication_role = replica`, which disables the append-only trigger
// for the owner's teardown only (never for the app). Child rows first, for the
// foreign keys.
after(async () => {
  if (provisionedTenants.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('set session_replication_role = replica');
    await owner.query('delete from stock_snapshots where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from stock_movements where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('set session_replication_role = origin');
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

/** One warehouse, one branch, and one item with its variant — the ledger's cast. */
async function setup(
  db: Parameters<typeof createLocation>[0],
  suffix: string,
): Promise<{
  warehouse: { id: string };
  branch: { id: string };
  itemId: string;
  variantId: string;
}> {
  const warehouse = await createLocation(db, { code: `WH-${suffix}`, nameAr: 'المخزن', type: 'warehouse' });
  const branch = await createLocation(db, { code: `BR-${suffix}`, nameAr: 'فرع', type: 'branch' });
  const created = await createItem(db, {
    nameAr: 'قميص',
    nameEn: 'Shirt',
    family: 'sellable',
    sku: `SH-${suffix}`,
    barcode: `SH-${suffix}`,
  });
  return { warehouse, branch, itemId: created.item.id, variantId: created.variant.id };
}

test('on_hand is the sum of movements per variant and location', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, '1'));

    // +10 to the warehouse, +3 to the branch.
    await withTenant(db, t1, (tdb) =>
      postMovement(tdb, { variantId: ctx.variantId, qty: 10, reason: 'receipt', toLocationId: ctx.warehouse.id }),
    );
    await withTenant(db, t1, (tdb) =>
      postMovement(tdb, { variantId: ctx.variantId, qty: 3, reason: 'receipt', toLocationId: ctx.branch.id }),
    );

    await withTenant(db, t1, async (tdb) => {
      const rows = await onHand(tdb, { variantId: ctx.variantId });
      assert.deepEqual(
        rows.map((r) => [r.locationId, r.qty]),
        [
          [ctx.branch.id, '3.000'],
          [ctx.warehouse.id, '10.000'],
        ],
        'on_hand must be exactly the signed sum of the ledger — warehouse 10, branch 3',
      );
    });

    // A transfer now moves stock between the two: the SAME row debits the
    // source and credits the destination.
    await withTenant(db, t1, (tdb) =>
      postMovement(tdb, {
        variantId: ctx.variantId,
        qty: 4,
        reason: 'transfer',
        fromLocationId: ctx.warehouse.id,
        toLocationId: ctx.branch.id,
      }),
    );

    await withTenant(db, t1, async (tdb) => {
      const rows = await onHand(tdb, { variantId: ctx.variantId });
      assert.deepEqual(
        rows.map((r) => [r.locationId, r.qty]),
        [
          [ctx.branch.id, '7.000'],
          [ctx.warehouse.id, '6.000'],
        ],
        'a transfer must subtract from its source and add to its destination',
      );
    });
  });
});

// Rule 5: the ledger is append-only. Dropping either trigger makes the matching
// half of this test fail (the statement would succeed).
test('a movement row cannot be updated or deleted', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, '2'));
    const posted = await withTenant(db, t1, (tdb) =>
      postMovement(tdb, { variantId: ctx.variantId, qty: 5, reason: 'receipt', toLocationId: ctx.warehouse.id }),
    );

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) => tdb.query('update stock_movements set qty = 99 where id = $1', [posted.id])),
      /append-only/,
      'an UPDATE of a ledger row must be refused',
    );

    await assert.rejects(
      () => withTenant(db, t1, (tdb) => tdb.query('delete from stock_movements where id = $1', [posted.id])),
      /append-only/,
      'a DELETE of a ledger row must be refused',
    );

    // The row is still there, unchanged.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ qty: string }>(
        'select qty from stock_movements where id = $1',
        [posted.id],
      );
      assert.equal(rows[0]?.qty, '5.000', 'the row must be untouched by the refused statements');
    });
  });
});

// Review Focus #3: dedupe. Dropping the partial unique index on
// (tenant_id, idempotency_key) makes the second call insert a second row.
test('re-posting the same idempotency key posts once', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, '3'));
    const movement = {
      variantId: ctx.variantId,
      qty: 7,
      reason: 'receipt',
      toLocationId: ctx.warehouse.id,
      idempotencyKey: 'KEY-3',
    };

    const first = await withTenant(db, t1, (tdb) => postMovement(tdb, movement));
    assert.equal(first.deduped, false, 'the first post is a real insert');

    const second = await withTenant(db, t1, (tdb) => postMovement(tdb, movement));
    assert.equal(second.deduped, true, 'the re-sent movement must be recognised as a duplicate');
    assert.equal(second.id, first.id, 'the duplicate resolves to the SAME row');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where idempotency_key = $1',
        ['KEY-3'],
      );
      assert.equal(rows[0]!.n, 1, 'the ledger must hold exactly one row for that key');
    });
  });
});

test('a movement with no idempotency key always posts', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, '4'));
    const movement = { variantId: ctx.variantId, qty: 2, reason: 'receipt', toLocationId: ctx.warehouse.id };

    const first = await withTenant(db, t1, (tdb) => postMovement(tdb, movement));
    const second = await withTenant(db, t1, (tdb) => postMovement(tdb, movement));

    assert.equal(first.deduped, false);
    assert.equal(second.deduped, false, 'with no key there is nothing to dedupe on');
    assert.notEqual(second.id, first.id, 'the two posts are two distinct movements');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1',
        [ctx.variantId],
      );
      assert.equal(rows[0]!.n, 2, 'two identical keyless movements are two real rows');
    });
  });
});

// Rule 6: a withdrawn product must not accept stock. Dropping the trigger makes
// this fail (the movement would be accepted).
test('an inactive item or variant cannot receive a movement', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, '5'));
    const movement = { variantId: ctx.variantId, qty: 1, reason: 'receipt', toLocationId: ctx.warehouse.id };

    // Positive control: active item and variant accept a movement.
    await withTenant(db, t1, (tdb) => postMovement(tdb, movement));

    // Deactivate the ITEM.
    await withTenant(db, t1, (tdb) =>
      tdb.query('update items set active = false where id = $1', [ctx.itemId]),
    );
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => postMovement(tdb, movement)),
      /inactive/,
      'an inactive item must not receive a movement',
    );

    // Restore the item, deactivate the VARIANT.
    await withTenant(db, t1, (tdb) => tdb.query('update items set active = true where id = $1', [ctx.itemId]));
    await withTenant(db, t1, (tdb) =>
      tdb.query('update item_variants set active = false where id = $1', [ctx.variantId]),
    );
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => postMovement(tdb, movement)),
      /inactive/,
      'an inactive variant must not receive a movement',
    );
  });
});

// Rule 2: `on_hand` MUST be `security_invoker`. A plain (owner-executing) view
// runs as the superuser owner and BYPASSES the RLS on `stock_movements`, so a
// tenant would see every other tenant's stock. Recreating the view without
// `security_invoker` makes this test fail.
test('the on_hand view does not leak across tenants', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    const a = await withTenant(db, t1, (tdb) => setup(tdb, '6'));
    const b = await withTenant(db, t2, (tdb) => setup(tdb, '6'));

    await withTenant(db, t1, (tdb) =>
      postMovement(tdb, { variantId: a.variantId, qty: 5, reason: 'receipt', toLocationId: a.warehouse.id }),
    );
    await withTenant(db, t2, (tdb) =>
      postMovement(tdb, { variantId: b.variantId, qty: 9, reason: 'receipt', toLocationId: b.warehouse.id }),
    );

    await withTenant(db, t1, async (tdb) => {
      const rows = await onHand(tdb);
      assert.deepEqual(
        rows.map((r) => r.variantId),
        [a.variantId],
        'tenant A must see only its own on-hand row, even though tenant B has movements',
      );
      assert.equal(rows[0]!.qty, '5.000');
    });

    await withTenant(db, t2, async (tdb) => {
      const rows = await onHand(tdb);
      assert.deepEqual(
        rows.map((r) => r.variantId),
        [b.variantId],
        'tenant B must see only its own on-hand row',
      );
    });
  });
});

// Rule 3: every cross-table FK is tenant-scoped. Dropping the composite FKs
// makes each insert below succeed, pointing a movement in tenant A at tenant
// B's rows.
test('a movement may not reference another tenant\u2019s variant or location', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    const a = await withTenant(db, t1, (tdb) => setup(tdb, '7'));
    const b = await withTenant(db, t2, (tdb) => setup(tdb, '7'));

    // Cross-tenant VARIANT: tenant scoped to t1, variant belonging to t2.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query(
            `insert into stock_movements (tenant_id, variant_id, qty, to_location_id, reason)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 1, $2, 'receipt')`,
            [b.variantId, a.warehouse.id],
          ),
        ),
      /foreign key|stock_movements_tenant_id_variant_id_fkey/i,
      'a movement may not point at another tenant\u2019s variant',
    );

    // Cross-tenant LOCATION: variant of t1, location of t2.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query(
            `insert into stock_movements (tenant_id, variant_id, qty, to_location_id, reason)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 1, $2, 'receipt')`,
            [a.variantId, b.warehouse.id],
          ),
        ),
      /foreign key|stock_movements_tenant_id_to_location_id_fkey/i,
      'a movement may not point at another tenant\u2019s location',
    );

    // Positive control: the same-tenant pair is accepted.
    await withTenant(db, t1, (tdb) =>
      postMovement(tdb, { variantId: a.variantId, qty: 1, reason: 'receipt', toLocationId: a.warehouse.id }),
    );
  });
});

// Rule 4: `ref_type` is human-typed, so it is normalised on write AND enforced
// by the database for a raw insert. Dropping the CHECK makes this pass wrongly.
test('a raw insert of a non-normalised ref_type is refused', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, '8'));

    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () =>
          tdb.query(
            `insert into stock_movements (tenant_id, variant_id, qty, to_location_id, reason, ref_type)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 1, $2, 'receipt', ' po-9 ')`,
            [ctx.variantId, ctx.warehouse.id],
          ),
        /check constraint|stock_movements_ref_type_normalised_check/i,
        'a raw insert of a non-normalised ref_type must be refused',
      );
    });

    // The writer canonicalises it, so a lower-cased value is stored upper-cased.
    const posted = await withTenant(db, t1, (tdb) =>
      postMovement(tdb, {
        variantId: ctx.variantId,
        qty: 1,
        reason: 'receipt',
        toLocationId: ctx.warehouse.id,
        refType: ' po-9 ',
      }),
    );
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ ref_type: string }>(
        'select ref_type from stock_movements where id = $1',
        [posted.id],
      );
      assert.equal(rows[0]?.ref_type, 'PO-9', 'the writer stores ref_type trimmed and upper-cased');
    });
  });
});

// Rule 7 / closed list, at the database: the CHECKs are the last line of defence
// for a writer that bypasses validateMovement.
test('the database refuses a non-positive quantity or an unknown reason', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, '9'));

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query(
            `insert into stock_movements (tenant_id, variant_id, qty, to_location_id, reason)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 0, $2, 'receipt')`,
            [ctx.variantId, ctx.warehouse.id],
          ),
        ),
      /stock_movements_qty_positive_check|check constraint/i,
      'qty = 0 must be refused',
    );

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query(
            `insert into stock_movements (tenant_id, variant_id, qty, to_location_id, reason)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 1, $2, 'because')`,
            [ctx.variantId, ctx.warehouse.id],
          ),
        ),
      /stock_movements_reason_check|check constraint/i,
      'a reason outside the closed list must be refused',
    );

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query(
            `insert into stock_movements (tenant_id, variant_id, qty, reason)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 1, 'receipt')`,
            [ctx.variantId],
          ),
        ),
      /stock_movements_has_a_side_check|check constraint/i,
      'a movement naming no location must be refused',
    );
  });
});

test('movementHistory returns a variant\u2019s rows newest first', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'A'));

    await withTenant(db, t1, (tdb) =>
      postMovement(tdb, {
        variantId: ctx.variantId,
        qty: 10,
        reason: 'receipt',
        toLocationId: ctx.warehouse.id,
        occurredAt: '2026-01-01T00:00:00Z',
      }),
    );
    await withTenant(db, t1, (tdb) =>
      postMovement(tdb, {
        variantId: ctx.variantId,
        qty: 3,
        reason: 'issue_to_branch',
        fromLocationId: ctx.warehouse.id,
        occurredAt: '2026-02-01T00:00:00Z',
      }),
    );

    await withTenant(db, t1, async (tdb) => {
      const rows = await movementHistory(tdb, ctx.variantId);
      assert.deepEqual(
        rows.map((r) => r.qty),
        ['3.000', '10.000'],
        'the history is newest-first by occurred_at',
      );
      assert.equal(rows.length, 2);
    });
  });
});
