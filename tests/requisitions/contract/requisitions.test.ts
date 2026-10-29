import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { withTenant } from '@/modules/platform/index';
import { createItem } from '@/modules/catalog/index';
import { createLocation, transitLocation } from '@/modules/locations/index';
import { onHand } from '@/modules/ledger/index';
import { approve, close, confirmReceipt, createRequisition, issue, reject } from '@/modules/requisitions/index';
import { createSession } from '@/modules/auth/index';
import { getRequisition } from '@/app/requisitions/handler';
import { migrateUrl, sqlTestUrl, withDb } from '../../harness/sql.ts';

/**
 * Contract tests for branch requisitions: `requisitions`, `requisition_lines`,
 * and the request → approve → issue → confirm flow.
 *
 * A branch does not take stock; it ASKS. The warehouse approves, ISSUES (moves
 * stock warehouse -> transit), and the branch CONFIRMS RECEIPT (moves it
 * transit -> branch). The properties that matter are:
 *
 *   - issuing writes a warehouse -> transit transfer, so the warehouse loses
 *     what transit gains, and the branch still holds NOTHING — stock in transit
 *     is not yet the branch's;
 *   - confirming moves stock from transit to the branch, from the SAME ledger
 *     row's other leg, so the two can never drift apart;
 *   - a partially-issued requisition stays open rather than silently complete;
 *   - confirming more than was issued is refused, naming the state;
 *   - a confirm retried cannot double the branch's stock (a per-line idempotency
 *     key), and a document that has written movements is frozen and undeletable;
 *   - the flow never runs backwards and terminal states are terminal;
 *   - a requisition line may only reference its OWN tenant's variant (the
 *     composite foreign key).
 *
 * Tenants are provisioned over the OWNER connection (`migrateUrl()`); everything
 * the app does runs as the non-superuser `authenticated` role.
 */

type Provisioned = { t1: string; t2: string; u1: string; u2: string };

const provisionedTenants: string[] = [];

/**
 * Creates two tenants, each with one app_user, over the OWNER connection, and
 * returns the tenant ids plus the app_user ids (needed as the `requestedBy` /
 * `approverUserId` a requisition records).
 */
async function provision(): Promise<Provisioned> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const {
      rows: [t1],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Req One') returning id");
    const {
      rows: [t2],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Req Two') returning id");
    const userIds: Record<string, string> = {};
    for (const [id, name, username] of [
      [t1!.id, 'A', 'user_a'],
      [t2!.id, 'B', 'user_b'],
    ] as const) {
      const {
        rows: [u],
      } = await owner.query<{ id: string }>(
        "insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1, $2, public.normalise_name($2), $3, 'branch_user', 'x') returning id",
        [id, name, username],
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
// the owner connection (never for the app). Child rows first, for the FKs.
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
    await owner.query('delete from sessions where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from app_users where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from locations where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from tenants where id = any($1)', [provisionedTenants]);
  } finally {
    await owner.end();
  }
});

type AnyDb = Parameters<typeof createLocation>[0];

/**
 * The requisition cast: the warehouse stock leaves FROM, the branch it is FOR,
 * and one item with its variant.
 */
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
    sku: `RQ-${suffix}`,
    barcode: `RQ-${suffix}`,
  });
  return { warehouse, branch, itemId: created.item.id, variantId: created.variant.id };
}

test('issuing writes two movements through transit', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'ISSUE'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));
    const result = await withTenant(db, t1, (tdb) =>
      issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]),
    );
    assert.equal(result.status, 'issued', 'issuing every line in full makes the requisition `issued`');

    const transit = await withTenant(db, t1, (tdb) => transitLocation(tdb));

    await withTenant(db, t1, async (tdb) => {
      const rows = await onHand(tdb, { variantId: ctx.variantId });
      const byLocation = Object.fromEntries(rows.map((r) => [r.locationId, r.qty]));
      assert.equal(byLocation[ctx.warehouse.id], '-5.000', 'the warehouse must lose the issued quantity');
      assert.equal(byLocation[transit.id], '5.000', 'transit must gain it — the stock is on the road');
      assert.equal(
        byLocation[ctx.branch.id] ?? '0.000',
        '0.000',
        'the branch still holds NOTHING — stock in transit is not yet the branch’s',
      );

      // ONE transfer row, carrying BOTH sides: the warehouse's loss and
      // transit's gain come from the same row, so they cannot drift apart.
      const { rows: movements } = await tdb.query<{
        from_location_id: string | null;
        to_location_id: string | null;
        reason: string;
        ref_type: string;
        ref_id: string;
      }>('select from_location_id, to_location_id, reason, ref_type, ref_id from stock_movements where variant_id = $1', [
        ctx.variantId,
      ]);
      assert.equal(movements.length, 1, 'one line posts exactly one transfer row');
      assert.equal(movements[0]?.from_location_id, ctx.warehouse.id, 'the issue leaves the warehouse');
      assert.equal(movements[0]?.to_location_id, transit.id, '...and arrives in transit');
      assert.equal(movements[0]?.reason, 'issue_to_branch');
      assert.equal(movements[0]?.ref_type, 'REQUISITION', 'the ref_type is normalised to upper case');
      assert.equal(movements[0]?.ref_id, req.id, 'the movement points back at the requisition');
    });
  });
});

test('confirming moves stock from transit to the branch', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'CONFIRM'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]));

    const result = await withTenant(db, t1, (tdb) =>
      confirmReceipt(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]),
    );
    assert.equal(result.status, 'received', 'confirming receipt makes the requisition `received`');

    const transit = await withTenant(db, t1, (tdb) => transitLocation(tdb));

    await withTenant(db, t1, async (tdb) => {
      const rows = await onHand(tdb, { variantId: ctx.variantId });
      const byLocation = Object.fromEntries(rows.map((r) => [r.locationId, r.qty]));
      assert.equal(byLocation[transit.id], '0.000', 'transit must be emptied by the confirm');
      assert.equal(byLocation[ctx.branch.id], '5.000', 'the branch must gain the stock it confirmed');
      assert.equal(byLocation[ctx.warehouse.id], '-5.000', 'the warehouse’s earlier loss is unchanged');

      const { rows: movements } = await tdb.query<{ reason: string }>(
        'select reason from stock_movements where variant_id = $1 order by seq',
        [ctx.variantId],
      );
      assert.equal(movements.length, 2, 'the flow writes exactly two movements through transit: out, then in');
      assert.equal(movements[1]?.reason, 'issue_to_branch');
    });
  });
});

test("stock in transit is not yet the branch's", { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'TRANSIT'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 7 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 7 }]));

    // Between issue and confirm, the branch's on-hand is ZERO — the number the
    // branch actually sees for its own stock. A loss on the road is therefore a
    // visible gap, not stock that quietly became the branch's.
    await withTenant(db, t1, async (tdb) => {
      const rows = await onHand(tdb, { variantId: ctx.variantId, locationId: ctx.branch.id });
      assert.equal(rows.length, 0, 'the branch has no on-hand row at all while the stock is in transit');
      assert.equal(rows[0]?.qtyNum ?? 0, 0, "on_hand(branch) === 0 between issue and confirm");
    });
  });
});

test('a partial issue leaves the line open and sets partially_issued', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'PART'));
    const second = await withTenant(db, t1, (tdb) =>
      createItem(tdb, { nameAr: 'حزام', nameEn: 'Belt', family: 'sellable', sku: 'RQP-2', barcode: 'RQP-2' }),
    );

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [
          { variantId: ctx.variantId, requestedQty: 10 },
          { variantId: second.variant.id, requestedQty: 20 },
        ],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));

    // Issue ONLY the first line. The second line's goods have not left yet.
    const partial = await withTenant(db, t1, (tdb) =>
      issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 10 }]),
    );
    assert.equal(partial.status, 'partially_issued', 'an incomplete issue must NOT mark the requisition complete');

    await withTenant(db, t1, async (tdb) => {
      const { rows: hdr } = await tdb.query<{ status: string }>(
        'select status from requisitions where id = $1',
        [req.id],
      );
      assert.equal(hdr[0]!.status, 'partially_issued');

      const { rows: lines } = await tdb.query<{ variant_id: string; issued_qty: string; status: string }>(
        'select variant_id, issued_qty, status from requisition_lines where requisition_id = $1',
        [req.id],
      );
      const first = lines.find((l) => l.variant_id === ctx.variantId)!;
      const secondLine = lines.find((l) => l.variant_id === second.variant.id)!;
      assert.equal(first.status, 'fulfilled', 'a line issued in full is fulfilled');
      assert.equal(secondLine.issued_qty, '0.000', 'the unsupplied line is left UNTOUCHED');
      assert.equal(secondLine.status, 'open', 'the un-issued line is still OPEN, not reported short');
    });

    // Issue the remaining line: the requisition completes to `issued`.
    const completion = await withTenant(db, t1, (tdb) =>
      issue(tdb, req.id, u1, [{ variantId: second.variant.id, qty: 20 }]),
    );
    assert.equal(completion.status, 'issued', 'once EVERY line is issued the requisition is `issued`');
  });
});

// Review Focus #4: you cannot receive stock that never left the warehouse. A
// confirm of more than the line's issued quantity is refused, NAMING THE STATE,
// and nothing is committed (the header stays `issued`, no movement is written).
test('confirming more than was issued is refused, naming the state', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'OVER'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]));

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          confirmReceipt(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 6 }]),
        ),
      /issued/,
      'confirming 6 against an issued 5 must be refused, naming the state',
    );

    // Atomicity: the refused confirm committed NOTHING.
    await withTenant(db, t1, async (tdb) => {
      const { rows: hdr } = await tdb.query<{ status: string }>(
        'select status from requisitions where id = $1',
        [req.id],
      );
      assert.equal(hdr[0]!.status, 'issued', 'the refused confirm leaves the requisition `issued`');

      const { rows: line } = await tdb.query<{ received_qty: string }>(
        'select received_qty from requisition_lines where requisition_id = $1',
        [req.id],
      );
      assert.equal(line[0]!.received_qty, '0.000', 'no line was received');

      const { rows: mv } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where variant_id = $1 and to_location_id = $2",
        [ctx.variantId, ctx.branch.id],
      );
      assert.equal(mv[0]!.n, 0, 'nothing may reach the branch when the confirm is refused');
    });
  });
});

// Review Focus #3: a CONFIRM retried must not double the branch's stock. The
// per-line idempotency key is what makes that true even in the race window where
// a second caller read the requisition as still `issued` before the first
// committed — here simulated by reopening it with a RAW OWNER write with
// triggers DISABLED (`session_replication_role = replica`): the status trigger
// makes `received -> issued` unreachable through the app path, so this write
// exists ONLY to hand the second confirm a simulated pre-trigger state, so the
// idempotency key can be shown to be the only thing standing between the ledger
// and a double count.
test('confirming twice posts once (idempotency)', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'IDEM'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]));
    await withTenant(db, t1, (tdb) =>
      confirmReceipt(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]),
    );

    // Simulate the racing retry that read the requisition before it was marked
    // received: reopen it so the state guard does not stop the second attempt,
    // AND roll the line's received_qty back to what that racing caller saw, so
    // the per-line idempotency key is the only thing between the ledger and a
    // double count. OWNER connection, triggers off.
    const owner = new Client({ connectionString: migrateUrl()! });
    await owner.connect();
    try {
      await owner.query('set session_replication_role = replica');
      await owner.query("update requisitions set status = 'issued' where id = $1", [req.id]);
      await owner.query(
        "update requisition_lines set received_qty = 0, status = 'open' where requisition_id = $1",
        [req.id],
      );
    } finally {
      await owner.end();
    }

    await withTenant(db, t1, (tdb) =>
      confirmReceipt(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]),
    );

    const transit = await withTenant(db, t1, (tdb) => transitLocation(tdb));

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where variant_id = $1 and from_location_id = $2",
        [ctx.variantId, transit.id],
      );
      assert.equal(rows[0]!.n, 1, 'a re-confirmed requisition must move the stock exactly ONCE');

      const oh = await onHand(tdb, { variantId: ctx.variantId, locationId: ctx.branch.id });
      assert.equal(oh[0]?.qty, '5.000', 'the branch holds the stock once, not twice');
    });
  });
});

// A requisition line may only reference its OWN tenant's variant (the composite
// foreign key), and a header may only name its OWN tenant's branch.
test('a requisition line for another tenant is refused', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2, u1 } = await provision();

  await withDb(async (db) => {
    const a = await withTenant(db, t1, (tdb) => setup(tdb, 'ISO'));
    const b = await withTenant(db, t2, (tdb) => setup(tdb, 'ISO'));

    // Cross-tenant VARIANT on a requisition LINE.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          createRequisition(tdb, {
            branchLocationId: a.branch.id,
            requestedBy: u1,
            lines: [{ variantId: b.variantId, requestedQty: 1 }],
          }),
        ),
      /foreign key|requisition_lines_tenant_id_variant_id_fkey/i,
      'a requisition line may not point at another tenant’s variant',
    );

    // ...and no orphan requisition survives the refused line.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>('select count(*)::int as n from requisitions');
      assert.equal(rows[0]!.n, 0, 'the requisition header must not survive a refused line — no orphan');
    });

    // Cross-tenant BRANCH on the requisition HEADER itself.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query(
            `insert into requisitions (tenant_id, branch_location_id, requested_by)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2)`,
            [b.branch.id, u1],
          ),
        ),
      /foreign key|requisitions_tenant_id_branch_location_id_fkey/i,
      'a requisition may not point at another tenant’s branch',
    );

    // Positive control: the same-tenant pair is accepted.
    await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: a.branch.id,
        requestedBy: u1,
        lines: [{ variantId: a.variantId, requestedQty: 1 }],
      }),
    );
  });
});

// CRITICAL (Task 6's lesson): a document that has written movements is FROZEN.
// Deleting a requisition past approval would cascade its lines away while the
// ledger rows it wrote (`ref_type='REQUISITION', ref_id=<requisition>`) survived
// as orphans the `on_hand` view still counted. `ref_id` is polymorphic, so no FK
// can catch it — the delete guard on the header is what stops it.
test('a requisition that has written movements cannot be deleted', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'DEL'));

    // A `requested` requisition (no movements) is deletable.
    const draft = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    await withTenant(db, t1, (tdb) => tdb.query('delete from requisitions where id = $1', [draft.id]));
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from requisitions where id = $1',
        [draft.id],
      );
      assert.equal(rows[0]!.n, 0, 'a requisition with no movements must be deletable');
    });

    // An `issued` requisition (movements written) is NOT.
    const issuedReq = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 10 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, issuedReq.id, u1));
    await withTenant(db, t1, (tdb) => issue(tdb, issuedReq.id, u1, [{ variantId: ctx.variantId, qty: 10 }]));

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query('delete from requisitions where id = $1', [issuedReq.id]),
        ),
      /cannot be deleted/,
      'deleting a requisition with written movements must be refused — a polymorphic ref_id would be orphaned',
    );

    // The requisition, its lines and its ledger movement are ALL still there.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from requisitions where id = $1',
        [issuedReq.id],
      );
      assert.equal(rows[0]!.n, 1, 'the frozen requisition must survive the refused delete');
      const { rows: lineRows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from requisition_lines where requisition_id = $1',
        [issuedReq.id],
      );
      assert.equal(lineRows[0]!.n, 1, 'its lines must survive the refused delete');
      const { rows: mv } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where ref_type = 'REQUISITION' and ref_id = $1",
        [issuedReq.id],
      );
      assert.equal(mv[0]!.n, 1, 'its ledger movement must survive — no orphan, no lost stock');
    });
  });
});

// The flow NEVER runs backwards and terminal states are terminal — enforced by
// the status trigger, so even a raw UPDATE cannot reopen a document whose stock
// has left the building.
test('a requisition never runs backwards and closed is terminal', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'TERM'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));

    // approved -> requested is backwards and refused.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query("update requisitions set status = 'requested' where id = $1", [req.id]),
        ),
      /not allowed by the state machine/,
      'a requisition must never move backwards',
    );

    // Drive the legal forward path to `received` ...
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]));
    await withTenant(db, t1, (tdb) =>
      confirmReceipt(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]),
    );

    // ... and `received -> closed` is allowed (a legal forward step).
    await withTenant(db, t1, (tdb) =>
      tdb.query("update requisitions set status = 'closed' where id = $1", [req.id]),
    );

    // `closed` is terminal: it must not move anywhere.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query("update requisitions set status = 'received' where id = $1", [req.id]),
        ),
      /not allowed by the state machine/,
      'a closed requisition is terminal',
    );

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ status: string }>(
        'select status from requisitions where id = $1',
        [req.id],
      );
      assert.equal(rows[0]!.status, 'closed', 'the refused reopen leaves the requisition closed');
    });
  });
});

// A requisition cannot be approved twice, and a `requested` one cannot be
// confirmed — both name the state.
test('an already-approved requisition cannot be approved again', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'AGAIN'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    const approved = await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approved_by, u1, 'approved_by must be stored as the approver');
    assert.ok(approved.approved_at, 'approved_at must be stamped on approve');
    assert.equal(approved.requested_by, u1, 'requested_by must be stored as the asker');

    await assert.rejects(
      () => withTenant(db, t1, (tdb) => approve(tdb, req.id, u1)),
      /cannot be approved.*status is 'approved'/,
      'a second approval must be refused, naming the state',
    );

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          confirmReceipt(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 1 }]),
        ),
      /cannot be confirmed.*status is 'approved'/,
      'an approved requisition has no stock in transit to confirm',
    );
  });
});

// GAP 1. A line taken in SEVERAL legs: 6-of-10 then a 4-of-10 TOP-UP must be
// accepted (the old code refused any second issue as 'already been issued'),
// completing the line and advancing the header to `issued`.
test('a partial issue is topped up to complete the line and the requisition', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'TOPUP'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 10 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));

    const first = await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 6 }]));
    assert.equal(first.status, 'partially_issued', 'a 6-of-10 issue leaves the requisition open');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ issued_qty: string; status: string }>(
        'select issued_qty, status from requisition_lines where requisition_id = $1',
        [req.id],
      );
      assert.equal(rows[0]!.issued_qty, '6.000', 'the line records what actually left the warehouse');
      assert.equal(rows[0]!.status, 'open', 'a partly-issued line is open, not fulfilled');
    });

    // The TOP-UP: the same line, its REMAINING 4 units. This must be accepted.
    const second = await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 4 }]));
    assert.equal(second.status, 'issued', 'topping the line up to its target makes the requisition `issued`');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ issued_qty: string; status: string }>(
        'select issued_qty, status from requisition_lines where requisition_id = $1',
        [req.id],
      );
      assert.equal(rows[0]!.issued_qty, '10.000', 'the line reaches its target');
      assert.equal(rows[0]!.status, 'fulfilled', 'a line issued in full is fulfilled');

      // Two legs, two movements — one per leg — and the stock sits in transit.
      const { rows: mv } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1',
        [ctx.variantId],
      );
      assert.equal(mv[0]!.n, 2, 'each leg posts exactly one movement');

      // A third attempt to issue past the target is refused, not silently dropped.
      await assert.rejects(
        () => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 1 }]),
        /cannot be issued|already fulfilled|cannot issue/,
        'issuing beyond the target is refused',
      );
    });
  });
});

// GAP 1. A PARTLY-ISSUED requisition must be confirmable: the branch acknowledges
// what actually arrived (6 of the 10) while the rest is still to come. The header
// stays `partially_issued` (the line is not yet fulfilled), the branch gains 6 and
// transit empties. A later top-up + confirm finishes it to `received`.
test('a partially-issued requisition can be confirmed for what arrived', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'PCONF'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 10 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 6 }]));

    const confirmed = await withTenant(db, t1, (tdb) =>
      confirmReceipt(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 6 }]),
    );
    // The rule: the header is `received` only when every line is fulfilled AND
    // every issued unit has arrived; here the line still needs 4 more issued, so
    // it STAYS `partially_issued`.
    assert.equal(confirmed.status, 'partially_issued', 'a confirm that leaves a line unfulfilled keeps the requisition open');

    const transit = await withTenant(db, t1, (tdb) => transitLocation(tdb));

    await withTenant(db, t1, async (tdb) => {
      const rows = await onHand(tdb, { variantId: ctx.variantId });
      const by = Object.fromEntries(rows.map((r) => [r.locationId, r.qty]));
      assert.equal(by[ctx.branch.id], '6.000', 'the branch holds what actually arrived');
      assert.equal(by[transit.id] ?? '0.000', '0.000', 'transit is emptied of the confirmed 6');
      assert.equal(by[ctx.warehouse.id], '-6.000', 'the warehouse stays down by the 6 issued');

      const { rows: mv } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1 and from_location_id = $2',
        [ctx.variantId, transit.id],
      );
      assert.equal(mv[0]!.n, 1, 'the confirm posts exactly one transit -> branch movement');
    });

    // Finish it: top the line up to 10, then confirm the remaining 4.
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 4 }]));
    const done = await withTenant(db, t1, (tdb) =>
      confirmReceipt(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 4 }]),
    );
    assert.equal(done.status, 'received', 'once everything is issued AND received the requisition is `received`');

    await withTenant(db, t1, async (tdb) => {
      const rows = await onHand(tdb, { variantId: ctx.variantId, locationId: ctx.branch.id });
      assert.equal(rows[0]?.qty, '10.000', 'the branch ends up holding the whole 10');
    });
  });
});

// GAP 1(b). The issue key is built from the CUMULATIVE issued quantity, so a
// RETRY of one leg lands on the same movement. Two genuine legs move twice; a
// retried leg moves once.
test('an issue leg retried moves stock once (cumulative-key idempotency)', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'IRETRY'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 10 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 6 }]));
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 4 }]));

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1',
        [ctx.variantId],
      );
      assert.equal(rows[0]!.n, 2, 'two genuine legs post two movements');
    });

    // Simulate the racing RETRY of the SECOND leg (a caller that read the line
    // at issued_qty 6 before the leg committed). OWNER connection, triggers off:
    // the state guard cannot stop it, so the cumulative key is the only thing
    // between the ledger and a double count.
    const owner = new Client({ connectionString: migrateUrl()! });
    await owner.connect();
    try {
      await owner.query('set session_replication_role = replica');
      await owner.query("update requisitions set status = 'partially_issued' where id = $1", [req.id]);
      await owner.query('update requisition_lines set issued_qty = 6 where requisition_id = $1', [req.id]);
    } finally {
      await owner.end();
    }

    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 4 }]));

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1',
        [ctx.variantId],
      );
      assert.equal(rows[0]!.n, 2, 'a retried leg must NOT post a third movement');
      const { rows: line } = await tdb.query<{ issued_qty: string }>(
        'select issued_qty from requisition_lines where requisition_id = $1',
        [req.id],
      );
      assert.equal(line[0]!.issued_qty, '10.000', 'the line still records the cumulative 10, once');
    });
  });
});

// GAP 2. `reject` drives requested -> rejected through an exported function,
// recording who refused it, when, and why — and `rejected` is terminal.
test('reject refuses an ask, records who and when, and is terminal', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'REJ'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );

    const rejected = await withTenant(db, t1, (tdb) => reject(tdb, req.id, u1, 'no stock'));
    assert.equal(rejected.status, 'rejected', 'reject moves the header to `rejected`');
    assert.equal(rejected.rejected_by, u1, 'who refused is recorded');
    assert.ok(rejected.rejected_at, 'when it was refused is stamped');
    assert.equal(rejected.rejected_reason, 'no stock', 'the reason is recorded');

    // A rejected requisition cannot be approved...
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => approve(tdb, req.id, u1)),
      /cannot be approved.*status is 'rejected'/,
      'a rejected requisition cannot be approved',
    );
    // ...and it is TERMINAL — a second reject is refused.
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => reject(tdb, req.id, u1)),
      /cannot be rejected.*status is 'rejected'/,
      'a rejected requisition is terminal',
    );

    // An APPROVED requisition cannot be rejected — approval is a decision already made.
    const approvedReq = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, approvedReq.id, u1));
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => reject(tdb, approvedReq.id, u1)),
      /cannot be rejected.*status is 'approved'/,
      'an already-approved requisition cannot be rejected, naming the state',
    );
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ status: string }>(
        'select status from requisitions where id = $1',
        [approvedReq.id],
      );
      assert.equal(rows[0]!.status, 'approved', 'the refused reject left the requisition approved');
    });
  });
});

// GAP 2. `close` drives received -> closed through an exported function and
// stamps `closed_at`; `closed` is terminal, and a not-yet-received requisition
// cannot be closed.
test('close finishes a received requisition, stamps closed_at, and is terminal', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'CLOSE'));

    // A `requested` requisition cannot be closed.
    const draft = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => close(tdb, draft.id, u1)),
      /cannot be closed.*status is 'requested'/,
      'a requisition that has not been received cannot be closed',
    );

    // Drive a requisition all the way to `received`, then close it.
    await withTenant(db, t1, (tdb) => approve(tdb, draft.id, u1));
    await withTenant(db, t1, (tdb) => issue(tdb, draft.id, u1, [{ variantId: ctx.variantId, qty: 5 }]));
    await withTenant(db, t1, (tdb) => confirmReceipt(tdb, draft.id, u1, [{ variantId: ctx.variantId, qty: 5 }]));

    const closed = await withTenant(db, t1, (tdb) => close(tdb, draft.id, u1));
    assert.equal(closed.status, 'closed', 'close moves the header to `closed`');
    assert.ok(closed.closed_at, 'closed_at is stamped by close');
    assert.equal(closed.closed_by, u1, 'who closed it is recorded');

    // `closed` is terminal.
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => close(tdb, draft.id, u1)),
      /cannot be closed.*status is 'closed'/,
      'a closed requisition is terminal',
    );
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ status: string }>(
        'select status from requisitions where id = $1',
        [draft.id],
      );
      assert.equal(rows[0]!.status, 'closed', 'the refused close leaves the requisition closed');
    });
  });
});

// THE OWNER'S HEADLINE REQUIREMENT: "I should know who took what when". The
// issue and confirm legs are HUMAN actions, so each movement must carry the id
// of the person who performed it — the warehouse user who released the stock,
// and the branch user who acknowledged its arrival. Before this, both legs
// posted with a NULL actor and the stock screen honestly rendered "System" for a
// human "Issue".
test('issue and confirm record the acting user on the ledger, and the actor cannot be omitted', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  // A SECOND user, so the two legs are provably attributed to DIFFERENT people:
  // a warehouse user issues, a branch user confirms. Created over the OWNER
  // connection, exactly as `provision` does.
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  let u2: string;
  try {
    const {
      rows: [u],
    } = await owner.query<{ id: string }>(
      "insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1, 'Warehouse T9', public.normalise_name('Warehouse T9'), 'wh_t9', 'warehouse_manager', 'x') returning id",
      [t1],
    );
    u2 = u!.id;
  } finally {
    await owner.end();
  }

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'ACTOR'));

    const req = await withTenant(db, t1, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: ctx.branch.id,
        requestedBy: u1,
        lines: [{ variantId: ctx.variantId, requestedQty: 5 }],
      }),
    );
    await withTenant(db, t1, (tdb) => approve(tdb, req.id, u1));

    // The warehouse user issues; the branch user confirms.
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u2, [{ variantId: ctx.variantId, qty: 5 }]));
    await withTenant(db, t1, (tdb) =>
      confirmReceipt(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]),
    );

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ actor_user_id: string | null; idempotency_key: string }>(
        'select actor_user_id, idempotency_key from stock_movements where variant_id = $1 order by seq',
        [ctx.variantId],
      );
      assert.equal(rows.length, 2, 'the flow posts exactly two movements');
      const issueLeg = rows.find((r) => r.idempotency_key.includes(':issue:'));
      const confirmLeg = rows.find((r) => r.idempotency_key.includes(':recv:'));
      assert.ok(issueLeg && confirmLeg, 'both the issue and the confirm legs must be present');
      assert.equal(issueLeg!.actor_user_id, u2, 'the ISSUE leg names the warehouse user who released the stock');
      assert.equal(confirmLeg!.actor_user_id, u1, 'the CONFIRM leg names the branch user who confirmed receipt');
      // The bug this fixes: a NULL actor rendered as "System" for a human action.
      assert.notEqual(issueLeg!.actor_user_id, null, 'the issue actor must never be NULL');
      assert.notEqual(confirmLeg!.actor_user_id, null, 'the confirm actor must never be NULL');
    });

    // A caller CANNOT omit the actor: `actorUserId` is a REQUIRED parameter, and
    // an empty one is refused loudly rather than silently posting a NULL actor.
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => issue(tdb, req.id, '', [{ variantId: ctx.variantId, qty: 1 }])),
      /actorUserId must be a non-empty user id/,
      'issue refuses an empty actor',
    );
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => confirmReceipt(tdb, req.id, '', [{ variantId: ctx.variantId, qty: 1 }])),
      /actorUserId must be a non-empty user id/,
      'confirmReceipt refuses an empty actor',
    );
  });
});

// ITEM 3 (requisition detail route): `/requisitions/<non-uuid>` had the same
// hole as `/stock/<non-uuid>` — the id reached `where r.id = $1` uncast and
// Postgres rejected the text with SQLSTATE 22P02 (a 500). It is guarded by
// SHAPE now, at the handler seam, and answers the SAME `invalid` a missing id
// gets — proved HERE by calling the handler directly.
test('a malformed requisition id is refused by the handler, not a 500', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const token = await withTenant(db, t1, async (tdb) => (await createSession(tdb, { userId: u1 })).token);

    await withTenant(db, t1, async (tdb) => {
      const out = await getRequisition(tdb, token, 'not-a-uuid');
      assert.deepEqual(out, { ok: false, error: 'invalid' }, 'a malformed id must be a refusal, not a throw');

      // A well-formed but unknown id is refused the SAME way (no oracle).
      const unknown = await getRequisition(tdb, token, '00000000-0000-0000-0000-000000000000');
      assert.deepEqual(unknown, { ok: false, error: 'invalid' });
    });
  });
});
