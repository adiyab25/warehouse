import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { withTenant } from '../../src/db/client.ts';
import { createItem } from '../../src/db/items.ts';
import { createLocation } from '../../src/db/locations.ts';
import { onHand } from '../../src/db/movements.ts';
import { createReceipt, postReceipt } from '../../src/db/receipts.ts';
import { migrateUrl, sqlTestUrl, withDb } from '../harness/sql.ts';

/**
 * Contract tests for receiving against an expected document: `receipts`,
 * `receipt_lines`, and the posting interface.
 *
 * The point of a receipt is that what was EXPECTED and what ARRIVED are two
 * different numbers, and the difference is REPORTED rather than absorbed — a
 * short delivery must not quietly become the new truth. The properties that
 * matter are:
 *
 *   - a short shipment surfaces as a negative variance, an over-delivery as a
 *     positive one (never a silent overwrite);
 *   - posting a receipt writes ONE ledger movement per line, from the
 *     factory/vendor location to the warehouse, through `postMovement` only;
 *   - a retry cannot double-post the same receipt (a per-line idempotency key),
 *     and a posted receipt cannot be posted again (its state refuses);
 *   - a receipt line may only reference its OWN tenant's variant (the composite
 *     foreign key);
 *   - creating a receipt with a bad line leaves NO orphan receipt behind
 *     (receipt + lines are one transaction).
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
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Receipt One') returning id");
    const {
      rows: [t2],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Receipt Two') returning id");
    for (const [id, name] of [
      [t1!.id, 'A'],
      [t2!.id, 'B'],
    ] as const) {
      await owner.query(
        "insert into app_users (tenant_id, name, role, password_hash) values ($1, $2, 'warehouse_manager', 'x')",
        [id, name],
      );
    }
    provisionedTenants.push(t1!.id, t2!.id);
    return { t1: t1!.id, t2: t2!.id };
  } finally {
    await owner.end();
  }
}

// Cleanup. `stock_movements` is append-only, so the ledger rows a receipt posts
// must be cleared with `session_replication_role = replica` on the owner
// connection (never for the app). Child rows first, for the foreign keys.
after(async () => {
  if (provisionedTenants.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('set session_replication_role = replica');
    await owner.query('delete from receipt_lines where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from receipts where tenant_id = any($1)', [provisionedTenants]);
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

type AnyDb = Parameters<typeof createLocation>[0];

/**
 * The receiving cast: a source location (a factory/vendor the goods come FROM),
 * a warehouse (where they arrive), and one item with its variant. `packFactor`
 * is optional so a test can exercise the carton→unit conversion.
 */
async function setup(
  db: AnyDb,
  suffix: string,
  extra: { packFactor?: number } = {},
): Promise<{
  source: { id: string };
  warehouse: { id: string };
  itemId: string;
  variantId: string;
}> {
  const source = await createLocation(db, { code: `FAC-${suffix}`, nameAr: 'المصنع', type: 'vendor' });
  const warehouse = await createLocation(db, { code: `WH-${suffix}`, nameAr: 'المخزن', type: 'warehouse' });
  const created = await createItem(db, {
    nameAr: 'قميص',
    nameEn: 'Shirt',
    family: 'sellable',
    sku: `RC-${suffix}`,
    barcode: `RC-${suffix}`,
    ...(extra.packFactor != null ? { packFactor: extra.packFactor } : {}),
  });
  return { source, warehouse, itemId: created.item.id, variantId: created.variant.id };
}

test('a short shipment is reported, not absorbed', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'SHORT'));

    const receipt = await withTenant(db, t1, (tdb) =>
      createReceipt(tdb, {
        sourceLocationId: ctx.source.id,
        destLocationId: ctx.warehouse.id,
        lines: [{ variantId: ctx.variantId, expectedQty: 40 }],
      }),
    );

    const result = await withTenant(db, t1, (tdb) =>
      postReceipt(tdb, receipt.id, [{ variantId: ctx.variantId, receivedQty: 36 }]),
    );

    assert.deepEqual(
      result.shortfalls,
      [{ variantId: ctx.variantId, expected: 40, received: 36, variance: -4 }],
      'receiving 36 against an expected 40 must REPORT a shortfall of -4',
    );

    // The shortfall is also stored on the line (the generated variance column),
    // so a later read sees the same number rather than the received quantity
    // silently standing in for the expected one.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ expected_qty: string; received_qty: string; variance_qty: string }>(
        'select expected_qty, received_qty, variance_qty from receipt_lines where receipt_id = $1',
        [receipt.id],
      );
      assert.equal(rows[0]?.expected_qty, '40.000');
      assert.equal(rows[0]?.received_qty, '36.000');
      assert.equal(rows[0]?.variance_qty, '-4.000', 'the generated variance must be received - expected');
    });
  });
});

test('receiving posts a movement from the factory to the warehouse', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'MOVE'));

    const receipt = await withTenant(db, t1, (tdb) =>
      createReceipt(tdb, {
        sourceLocationId: ctx.source.id,
        destLocationId: ctx.warehouse.id,
        lines: [{ variantId: ctx.variantId, expectedQty: 10 }],
      }),
    );
    await withTenant(db, t1, (tdb) =>
      postReceipt(tdb, receipt.id, [{ variantId: ctx.variantId, receivedQty: 10 }]),
    );

    await withTenant(db, t1, async (tdb) => {
      const rows = await onHand(tdb, { variantId: ctx.variantId });
      const byLocation = Object.fromEntries(rows.map((r) => [r.locationId, r.qty]));
      assert.equal(
        byLocation[ctx.warehouse.id],
        '10.000',
        'the warehouse must gain the received quantity',
      );
      assert.equal(
        byLocation[ctx.source.id],
        '-10.000',
        'the factory must lose it — a receipt is a transfer from the source, not a from-nowhere arrival',
      );

      // Exactly one movement, and it carries the receipt provenance.
      const { rows: movements } = await tdb.query<{ reason: string; ref_type: string; ref_id: string }>(
        'select reason, ref_type, ref_id from stock_movements where variant_id = $1',
        [ctx.variantId],
      );
      assert.equal(movements.length, 1, 'one line posts exactly one movement');
      assert.equal(movements[0]?.reason, 'receipt');
      assert.equal(movements[0]?.ref_type, 'RECEIPT', 'the ref_type is normalised to upper case');
      assert.equal(movements[0]?.ref_id, receipt.id, 'the movement points back at the receipt');
    });
  });
});

// Review Focus #3: a RETRY must not double-post. The per-line idempotency key
// is what makes that true even in the race window where a second caller read
// the receipt as still 'draft' before the first committed — here simulated by
// reopening the receipt after a first post. Removing the key makes the second
// post move the stock a second time.
test('posting a receipt twice posts once (idempotency)', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'IDEM'));

    const receipt = await withTenant(db, t1, (tdb) =>
      createReceipt(tdb, {
        sourceLocationId: ctx.source.id,
        destLocationId: ctx.warehouse.id,
        lines: [{ variantId: ctx.variantId, expectedQty: 40 }],
      }),
    );

    await withTenant(db, t1, (tdb) =>
      postReceipt(tdb, receipt.id, [{ variantId: ctx.variantId, receivedQty: 36 }]),
    );

    // Simulate the racing retry that read the receipt before it was marked
    // posted: reopen it so the state guard does not stop the second attempt,
    // leaving the per-line idempotency key as the only thing standing between
    // the ledger and a double count.
    await withTenant(db, t1, (tdb) =>
      tdb.query("update receipts set status = 'draft' where id = $1", [receipt.id]),
    );

    await withTenant(db, t1, (tdb) =>
      postReceipt(tdb, receipt.id, [{ variantId: ctx.variantId, receivedQty: 36 }]),
    );

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where variant_id = $1 and reason = 'receipt'",
        [ctx.variantId],
      );
      assert.equal(rows[0]!.n, 1, 'a re-posted receipt must move the stock exactly ONCE');

      const onHandRows = await onHand(tdb, { variantId: ctx.variantId, locationId: ctx.warehouse.id });
      assert.equal(onHandRows[0]?.qty, '36.000', 'the warehouse holds the received quantity once, not twice');
    });
  });
});

test('a receipt cannot be posted twice', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'STATE'));

    const receipt = await withTenant(db, t1, (tdb) =>
      createReceipt(tdb, {
        sourceLocationId: ctx.source.id,
        destLocationId: ctx.warehouse.id,
        lines: [{ variantId: ctx.variantId, expectedQty: 5 }],
      }),
    );
    await withTenant(db, t1, (tdb) =>
      postReceipt(tdb, receipt.id, [{ variantId: ctx.variantId, receivedQty: 5 }]),
    );

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          postReceipt(tdb, receipt.id, [{ variantId: ctx.variantId, receivedQty: 5 }]),
        ),
      /posted/,
      'a second post must be refused, naming the receipt’s state',
    );
  });
});

test('a receipt line for another tenant is refused', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    const a = await withTenant(db, t1, (tdb) => setup(tdb, 'ISO'));
    const b = await withTenant(db, t2, (tdb) => setup(tdb, 'ISO'));

    // Cross-tenant VARIANT on a receipt LINE: tenant scoped to t1, variant
    // belonging to t2. The composite FK (tenant_id, variant_id) is what refuses
    // it; a plain single-column FK would happily let it through.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          createReceipt(tdb, {
            sourceLocationId: a.source.id,
            destLocationId: a.warehouse.id,
            lines: [{ variantId: b.variantId, expectedQty: 1 }],
          }),
        ),
      /foreign key|receipt_lines_tenant_id_variant_id_fkey/i,
      'a receipt line may not point at another tenant’s variant',
    );

    // ...and no orphan receipt survives the refused line (the FK throws and the
    // whole withTenant transaction rolls back).
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>('select count(*)::int as n from receipts');
      assert.equal(rows[0]!.n, 0, 'the receipt header must not survive a refused line — no orphan');
    });

    // Cross-tenant LOCATION on the receipt HEADER itself.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query(
            `insert into receipts (tenant_id, source_location_id, dest_location_id)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2)`,
            [a.source.id, b.warehouse.id],
          ),
        ),
      /foreign key|receipts_tenant_id_dest_location_id_fkey/i,
      'a receipt may not point at another tenant’s destination location',
    );

    // Positive control: the same-tenant pair is accepted.
    await withTenant(db, t1, (tdb) =>
      createReceipt(tdb, {
        sourceLocationId: a.source.id,
        destLocationId: a.warehouse.id,
        lines: [{ variantId: a.variantId, expectedQty: 1 }],
      }),
    );
  });
});

// Rule 3: `ref_no` is human-typed (a delivery-note number), so it is normalised
// on write AND enforced by the database for a raw insert. Removing the CHECK
// makes the raw insert below succeed.
test('a raw insert of a non-normalised ref_no is refused', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'REF'));

    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () =>
          tdb.query(
            `insert into receipts (tenant_id, source_location_id, dest_location_id, ref_no)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, ' dn-7 ')`,
            [ctx.source.id, ctx.warehouse.id],
          ),
        /check constraint|receipts_ref_no_normalised_check/i,
        'a raw insert of a non-normalised ref_no must be refused',
      );
    });

    // The writer canonicalises it, so a padded, lower-cased value is stored
    // trimmed and upper-cased.
    const receipt = await withTenant(db, t1, (tdb) =>
      createReceipt(tdb, {
        sourceLocationId: ctx.source.id,
        destLocationId: ctx.warehouse.id,
        refNo: ' dn-7 ',
        lines: [{ variantId: ctx.variantId, expectedQty: 1 }],
      }),
    );
    assert.equal(receipt.ref_no, 'DN-7', 'the writer stores ref_no trimmed and upper-cased');
    assert.equal(receipt.status, 'draft', 'a fresh receipt starts life as a draft');
  });
});

// Rule 5: creating a receipt writes the header AND its lines in one
// transaction, so a bad line (here a duplicate variant, refused by the
// `unique (tenant_id, receipt_id, variant_id)` index) leaves no orphan header.
test('a receipt whose lines fail to write leaves no orphan receipt', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'ATOM'));

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          createReceipt(tdb, {
            sourceLocationId: ctx.source.id,
            destLocationId: ctx.warehouse.id,
            // The same variant twice: the second line breaks the per-receipt
            // unique index.
            lines: [
              { variantId: ctx.variantId, expectedQty: 5 },
              { variantId: ctx.variantId, expectedQty: 5 },
            ],
          }),
        ),
      /duplicate key|unique|receipt_lines_tenant_id_receipt_id_variant_id/i,
      'a duplicate line must be refused',
    );

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>('select count(*)::int as n from receipts');
      assert.equal(rows[0]!.n, 0, 'no orphan receipt header may survive a failed line insert');
    });
  });
});

// Pack conversion at the receiving interface: `packs` wins over `receivedQty`
// when both are supplied, and a pack_factor of 24 turns 2 packs into 48 units.
test('packs take precedence and convert through the item’s pack factor', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'PACK', { packFactor: 24 }));

    const receipt = await withTenant(db, t1, (tdb) =>
      createReceipt(tdb, {
        sourceLocationId: ctx.source.id,
        destLocationId: ctx.warehouse.id,
        lines: [{ variantId: ctx.variantId, expectedQty: 48 }],
      }),
    );

    // Both supplied: `packs` must win, so 2 packs × 24 = 48 units received.
    const result = await withTenant(db, t1, (tdb) =>
      postReceipt(tdb, receipt.id, [{ variantId: ctx.variantId, receivedQty: 999, packs: 2 }]),
    );

    assert.deepEqual(result.shortfalls, [], '2 packs of 24 exactly match the expected 48 — no shortfall');
    await withTenant(db, t1, async (tdb) => {
      const onHandRows = await onHand(tdb, { variantId: ctx.variantId, locationId: ctx.warehouse.id });
      assert.equal(onHandRows[0]?.qty, '48.000', 'packs take precedence: 2 × 24 posts 48 units, not 999');
    });
  });
});

test('an over-delivery is reported as a positive variance', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'OVER'));

    const receipt = await withTenant(db, t1, (tdb) =>
      createReceipt(tdb, {
        sourceLocationId: ctx.source.id,
        destLocationId: ctx.warehouse.id,
        lines: [{ variantId: ctx.variantId, expectedQty: 40 }],
      }),
    );

    const result = await withTenant(db, t1, (tdb) =>
      postReceipt(tdb, receipt.id, [{ variantId: ctx.variantId, receivedQty: 44 }]),
    );

    assert.deepEqual(
      result.shortfalls,
      [{ variantId: ctx.variantId, expected: 40, received: 44, variance: 4 }],
      'receiving 44 against an expected 40 must REPORT an over-delivery of +4',
    );
  });
});
