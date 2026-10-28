import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { withTenant } from '../../src/db/client.ts';
import { createItem } from '../../src/db/items.ts';
import { createLocation, quarantineLocation, scrapLocation } from '../../src/db/locations.ts';
import { onHand, postMovement } from '../../src/db/movements.ts';
import { approve, confirmReceipt, createRequisition, issue } from '../../src/db/requisitions.ts';
import { postReturn, returnRequisition } from '../../src/db/returns.ts';
import { migrateUrl, sqlTestUrl, withDb } from '../harness/sql.ts';

/**
 * Contract tests for the REVERSE direction: goods coming back, and damaged goods
 * written off. Every one of these is an ORDINARY LEDGER MOVEMENT — a row in
 * `stock_movements` — so nothing vanishes from the records.
 *
 * The properties that matter are:
 *
 *   - a disposition decides the DESTINATION and the REASON, exhaustively:
 *     `restock` credits the warehouse, `quarantine` credits the quarantine
 *     location, `write_off` credits scrap with reason `write_off`;
 *   - each return is ONE two-sided row (branch is debited, the destination
 *     credited, from the SAME row) posted through `postMovement`, never a raw
 *     insert and never two rows;
 *   - a return larger than the source actually holds is REFUSED, naming the
 *     location and the available quantity, and nothing is committed — a source
 *     never goes negative for stock it never had;
 *   - a retried return posts EXACTLY once (a stable, timestamp-free idempotency
 *     key), while a genuine second return with a distinct key still moves stock;
 *   - a return against a RECEIVED requisition moves it `received -> returned`
 *     and the ledger shows branch -> warehouse.
 *
 * Tenants are provisioned over the OWNER connection (`migrateUrl()`); everything
 * the app does runs as the non-superuser `authenticated` role.
 */

type Provisioned = { t1: string; t2: string; u1: string; u2: string };

const provisionedTenants: string[] = [];

/**
 * Creates two tenants, each with one app_user, over the OWNER connection, and
 * returns the tenant ids plus the app_user ids (needed as the actor a return
 * records and as a requisition's `requestedBy`).
 */
async function provision(): Promise<Provisioned> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const {
      rows: [t1],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Ret One') returning id");
    const {
      rows: [t2],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Ret Two') returning id");
    const userIds: Record<string, string> = {};
    for (const [id, name] of [
      [t1!.id, 'A'],
      [t2!.id, 'B'],
    ] as const) {
      const {
        rows: [u],
      } = await owner.query<{ id: string }>(
        "insert into app_users (tenant_id, name, role, password_hash) values ($1, $2, 'branch_user', 'x') returning id",
        [id, name],
      );
      userIds[id] = u!.id;
    }
    provisionedTenants.push(t1!.id, t2!.id);
    return { t1: t1!.id, t2: t2!.id, u1: userIds[t1!.id]!, u2: userIds[t2!.id]! };
  } finally {
    await owner.end();
  }
}

// Cleanup. `stock_movements` is append-only and a requisition past approval is
// undeletable, so both are cleared with `session_replication_role = replica` on
// the owner connection. Child rows first, for the FKs.
after(async () => {
  if (provisionedTenants.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('set session_replication_role = replica');
    await owner.query('delete from requisition_lines where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from requisitions where tenant_id = any($1)', [provisionedTenants]);
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

/** The return cast: a warehouse, a branch, one item with its variant. */
async function setup(
  db: AnyDb,
  suffix: string,
): Promise<{
  warehouse: { id: string };
  branch: { id: string };
  itemId: string;
  variantId: string;
}> {
  const warehouse = await createLocation(db, { code: `WH-${suffix}`, nameAr: 'المخزن', type: 'warehouse' });
  const branch = await createLocation(db, { code: `BR-${suffix}`, nameAr: 'الفرع', type: 'branch' });
  const created = await createItem(db, {
    nameAr: 'قميص',
    nameEn: 'Shirt',
    family: 'sellable',
    sku: `RT-${suffix}`,
    barcode: `RT-${suffix}`,
  });
  return { warehouse, branch, itemId: created.item.id, variantId: created.variant.id };
}

/** Puts stock INTO a location through the ledger, so on-hand is real, not seeded. */
async function seed(db: AnyDb, variantId: string, locationId: string, qty: number): Promise<void> {
  await postMovement(db, {
    variantId,
    qty,
    reason: 'opening_balance',
    toLocationId: locationId,
  });
}

/** Every (location -> qty) on-hand row for a variant, as a plain object. */
async function onHandBy(db: AnyDb, variantId: string): Promise<Record<string, string>> {
  const rows = await onHand(db, { variantId });
  return Object.fromEntries(rows.map((r) => [r.locationId, r.qty]));
}

test('a branch return moves stock back into the warehouse', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'STOCK'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 2));

    const refId = randomUUID();
    await withTenant(db, t1, (tdb) =>
      postReturn(tdb, {
        variantId: ctx.variantId,
        qty: 2,
        fromLocationId: ctx.branch.id,
        disposition: 'restock',
        refType: 'customer_return',
        refId,
      }),
    );

    await withTenant(db, t1, async (tdb) => {
      const by = await onHandBy(tdb, ctx.variantId);
      assert.equal(by[ctx.branch.id], '0.000', 'the branch is debited the 2 it sent back');
      assert.equal(by[ctx.warehouse.id], '2.000', 'the warehouse is credited the 2 that came back');

      // ONE two-sided row: the branch's loss and the warehouse's gain come from
      // the SAME ledger row, so they cannot drift apart.
      const { rows: mv } = await tdb.query<{
        from_location_id: string | null;
        to_location_id: string | null;
        reason: string;
        ref_type: string | null;
        ref_id: string | null;
        idempotency_key: string | null;
      }>(
        'select from_location_id, to_location_id, reason, ref_type, ref_id, idempotency_key from stock_movements where variant_id = $1 and ref_type = $2',
        [ctx.variantId, 'CUSTOMER_RETURN'],
      );
      assert.equal(mv.length, 1, 'the return is exactly one ledger row');
      assert.equal(mv[0]?.from_location_id, ctx.branch.id, 'the return leaves the branch');
      assert.equal(mv[0]?.to_location_id, ctx.warehouse.id, '...and arrives at the warehouse');
      assert.equal(mv[0]?.reason, 'return_from_branch', 'a restock of sellable goods is a branch return');
      assert.equal(mv[0]?.ref_type, 'CUSTOMER_RETURN', 'the ref_type is normalised to upper case');
      assert.equal(mv[0]?.ref_id, refId, 'the movement points back at the return reference');
    });
  });
});

test('a damaged return goes to the scrap location as a write-off', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'SCRAP'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 3));

    await withTenant(db, t1, (tdb) =>
      postReturn(tdb, {
        variantId: ctx.variantId,
        qty: 1,
        fromLocationId: ctx.branch.id,
        disposition: 'write_off',
        refType: 'damaged',
        refId: randomUUID(),
      }),
    );

    const scrap = await withTenant(db, t1, (tdb) => scrapLocation(tdb));

    await withTenant(db, t1, async (tdb) => {
      const by = await onHandBy(tdb, ctx.variantId);
      assert.equal(by[scrap.id], '1.000', 'the damaged unit lands in the scrap location');
      assert.equal(by[ctx.branch.id], '2.000', 'the branch is debited the written-off unit');
      assert.equal(by[ctx.warehouse.id], undefined, 'a write-off is NOT sellable stock — it never reaches the warehouse');

      const { rows: mv } = await tdb.query<{ reason: string }>(
        'select reason from stock_movements where variant_id = $1 and to_location_id = $2',
        [ctx.variantId, scrap.id],
      );
      assert.equal(mv[0]?.reason, 'write_off', 'a write-off carries reason `write_off`, not a return');
    });
  });
});

test('a quarantined return is NOT back in sellable stock', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'QUAR'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 3));

    await withTenant(db, t1, (tdb) =>
      postReturn(tdb, {
        variantId: ctx.variantId,
        qty: 1,
        fromLocationId: ctx.branch.id,
        disposition: 'quarantine',
        refType: 'suspect',
        refId: randomUUID(),
      }),
    );

    const quarantine = await withTenant(db, t1, (tdb) => quarantineLocation(tdb));

    await withTenant(db, t1, async (tdb) => {
      const by = await onHandBy(tdb, ctx.variantId);
      assert.equal(by[quarantine.id], '1.000', 'the held-back unit lands in the quarantine location');
      assert.equal(
        by[ctx.warehouse.id] ?? '0.000',
        '0.000',
        'the warehouse on_hand is UNCHANGED — a quarantined unit is not sellable stock',
      );
    });
  });
});

test('a restock of sellable goods is visible again in on_hand', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'SELL'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 4));

    await withTenant(db, t1, (tdb) =>
      postReturn(tdb, {
        variantId: ctx.variantId,
        qty: 4,
        fromLocationId: ctx.branch.id,
        disposition: 'restock',
        refType: 'customer_return',
        refId: randomUUID(),
      }),
    );

    await withTenant(db, t1, async (tdb) => {
      const wh = await onHand(tdb, { variantId: ctx.variantId, locationId: ctx.warehouse.id });
      assert.equal(wh[0]?.qty, '4.000', 'the restocked quantity is back in the warehouse on_hand');
      assert.equal(wh[0]?.qtyNum, 4, 'and readable as a number through qtyNum');
      const br = await onHand(tdb, { variantId: ctx.variantId, locationId: ctx.branch.id });
      assert.equal(br[0]?.qty ?? '0.000', '0.000', 'the branch no longer holds the restocked goods');
    });
  });
});

test('a return against a received requisition moves it to returned', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'REQRET'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, [{ variantId: ctx.variantId, qty: 5 }]));
    await withTenant(db, t1, (tdb) =>
      confirmReceipt(tdb, req.id, [{ variantId: ctx.variantId, qty: 5 }]),
    );

    // The branch holds the 5 it received; send it all back.
    const result = await withTenant(db, t1, (tdb) =>
      returnRequisition(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]),
    );
    assert.equal(result.status, 'returned', 'a return moves the requisition to `returned`');

    await withTenant(db, t1, async (tdb) => {
      const { rows: hdr } = await tdb.query<{ status: string }>(
        'select status from requisitions where id = $1',
        [req.id],
      );
      assert.equal(hdr[0]!.status, 'returned', 'the header records the return');

      const by = await onHandBy(tdb, ctx.variantId);
      assert.equal(by[ctx.branch.id] ?? '0.000', '0.000', 'the branch is emptied of the returned stock');
      assert.equal(
        by[ctx.warehouse.id] ?? '0.000',
        '0.000',
        'the warehouse is credited back to where it started — the round trip closes',
      );

      // The ledger shows branch -> warehouse, as an ordinary movement.
      const { rows: mv } = await tdb.query<{
        from_location_id: string | null;
        to_location_id: string | null;
        reason: string;
        ref_type: string | null;
        ref_id: string | null;
        actor_user_id: string | null;
      }>(
        "select from_location_id, to_location_id, reason, ref_type, ref_id, actor_user_id from stock_movements where variant_id = $1 and ref_type = 'REQUISITION' and from_location_id = $2",
        [ctx.variantId, ctx.branch.id],
      );
      assert.equal(mv.length, 1, 'the requisition return posts exactly one branch -> warehouse movement');
      assert.equal(mv[0]?.from_location_id, ctx.branch.id, 'the stock leaves the branch');
      assert.equal(mv[0]?.to_location_id, ctx.warehouse.id, '...and returns to the warehouse');
      assert.equal(mv[0]?.reason, 'return_from_branch', 'the reason is `return_from_branch`');
      assert.equal(mv[0]?.ref_id, req.id, 'the movement points back at the requisition');
      assert.equal(mv[0]?.actor_user_id, u1, 'the required actor is written to the ledger');
    });

    // `returned` is TERMINAL: a second return is refused, naming the state.
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => returnRequisition(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 1 }])),
      /cannot be returned.*status is 'returned'/,
      'a returned requisition is terminal',
    );
  });
});

// Review Focus #3: a retried return must post EXACTLY once. The key is derived
// deterministically (never from a timestamp), so a retried call derives the same
// key and lands on the same movement — while a genuine SECOND return, given a
// DISTINCT key, still moves stock.
test('a retried return posts once (idempotency)', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'IDEM'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 5));

    const refId = randomUUID();
    const input = {
      variantId: ctx.variantId,
      qty: 2,
      fromLocationId: ctx.branch.id,
      disposition: 'restock' as const,
      refType: 'customer_return',
      refId,
    };

    const first = await withTenant(db, t1, (tdb) => postReturn(tdb, input));
    const retry = await withTenant(db, t1, (tdb) => postReturn(tdb, input));
    assert.equal(retry.id, first.id, 'a retried return resolves to the SAME ledger movement');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1 and ref_type = $2 and ref_id = $3',
        [ctx.variantId, 'CUSTOMER_RETURN', refId],
      );
      assert.equal(rows[0]!.n, 1, 'a retried return must move the stock exactly ONCE');
      const by = await onHandBy(tdb, ctx.variantId);
      assert.equal(by[ctx.warehouse.id], '2.000', 'the warehouse gained the 2 once, not twice');
    });

    // A GENUINE second return of the same goods from the same place, with a
    // distinct key, is still possible — the idempotency key must not make the
    // second real return invisible.
    await withTenant(db, t1, (tdb) => postReturn(tdb, { ...input, idempotencyKey: 'genuine-second-return' }));

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1 and ref_type = $2 and ref_id = $3',
        [ctx.variantId, 'CUSTOMER_RETURN', refId],
      );
      assert.equal(rows[0]!.n, 2, 'a distinct key lets a genuine second return move stock');
      const by = await onHandBy(tdb, ctx.variantId);
      assert.equal(by[ctx.warehouse.id], '4.000', 'both genuine returns landed');
      assert.equal(by[ctx.branch.id], '1.000', 'the branch is debited only for the two real returns');
    });
  });
});

// NEVER LET STOCK GO NEGATIVE BY ACCIDENT: a return bigger than the source
// actually holds is REFUSED, naming the location and the available quantity, and
// NOTHING is committed — the refused return rolls back with the caller's
// transaction, leaving the branch's on-hand untouched and no movement behind.
test('a return of more than the branch holds is refused', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'OVERQ'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 2));

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          postReturn(tdb, {
            variantId: ctx.variantId,
            qty: 5,
            fromLocationId: ctx.branch.id,
            disposition: 'restock',
            refType: 'customer_return',
            refId: randomUUID(),
          }),
        ),
      /only 2\.000 is on hand/,
      'a return bigger than the branch holds must be refused, naming the available quantity',
    );

    // ...and the message names the LOCATION, so the caller knows which source.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          postReturn(tdb, {
            variantId: ctx.variantId,
            qty: 5,
            fromLocationId: ctx.branch.id,
            disposition: 'restock',
            refType: 'customer_return',
            refId: randomUUID(),
          }),
        ),
      /BR-OVERQ/,
      'the refusal names the source location',
    );

    // Atomicity: the refused return committed NOTHING.
    await withTenant(db, t1, async (tdb) => {
      const by = await onHandBy(tdb, ctx.variantId);
      assert.equal(by[ctx.branch.id], '2.000', 'the branch still holds exactly what it started with');
      assert.equal(by[ctx.warehouse.id] ?? '0.000', '0.000', 'the warehouse gained nothing from a refused return');
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1 and ref_type = $2',
        [ctx.variantId, 'CUSTOMER_RETURN'],
      );
      assert.equal(rows[0]!.n, 0, 'no movement may be written when the return is refused');
    });
  });
});
