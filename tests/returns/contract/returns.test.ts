import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { withTenant } from '@/modules/platform/index';
import { createItem } from '@/modules/catalog/index';
import { createLocation, quarantineLocation, scrapLocation } from '@/modules/locations/index';
import { onHand, postMovement } from '@/modules/ledger/index';
import { approve, confirmReceipt, createRequisition, issue } from '@/modules/requisitions/index';
import { postReturn, returnRequisition } from '@/modules/returns/index';
import { migrateUrl, sqlTestUrl, withDb } from '../../harness/sql.ts';

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
 *   - a retried return posts EXACTLY once (an explicit per-intent idempotency
 *     key is required), while a genuine second return with a distinct key still
 *     moves stock, and two concurrent returns cannot drive the source negative;
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
  const { t1, u1 } = await provision();

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
        idempotencyKey: randomUUID(),
        actorUserId: u1,
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
        actor_user_id: string | null;
      }>(
        'select from_location_id, to_location_id, reason, ref_type, ref_id, idempotency_key, actor_user_id from stock_movements where variant_id = $1 and ref_type = $2',
        [ctx.variantId, 'CUSTOMER_RETURN'],
      );
      assert.equal(mv.length, 1, 'the return is exactly one ledger row');
      assert.equal(mv[0]?.from_location_id, ctx.branch.id, 'the return leaves the branch');
      assert.equal(mv[0]?.to_location_id, ctx.warehouse.id, '...and arrives at the warehouse');
      assert.equal(mv[0]?.reason, 'return_from_branch', 'a restock of sellable goods is a branch return');
      assert.equal(mv[0]?.ref_type, 'CUSTOMER_RETURN', 'the ref_type is normalised to upper case');
      assert.equal(mv[0]?.ref_id, refId, 'the movement points back at the return reference');
      assert.equal(
        mv[0]?.actor_user_id,
        u1,
        'the REQUIRED actor is written to the ledger — a return names WHO decided it',
      );
    });
  });
});

test('a damaged return goes to the scrap location as a write-off', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

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
        idempotencyKey: randomUUID(),
        actorUserId: u1,
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
  const { t1, u1 } = await provision();

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
        idempotencyKey: randomUUID(),
        actorUserId: u1,
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
  const { t1, u1 } = await provision();

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
        idempotencyKey: randomUUID(),
        actorUserId: u1,
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
    await withTenant(db, t1, (tdb) => issue(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]));
    await withTenant(db, t1, (tdb) =>
      confirmReceipt(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]),
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

    // IMPORTANT 4: a RETRY of the committed return (the same line) is
    // idempotent. The requisition is already `returned` and its movement already
    // exists, so the re-send succeeds instead of an ambiguous refusal.
    const retried = await withTenant(db, t1, (tdb) =>
      returnRequisition(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]),
    );
    assert.equal(retried.status, 'returned', 'a retried return is an idempotent success');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where variant_id = $1 and ref_type = 'REQUISITION' and from_location_id = $2",
        [ctx.variantId, ctx.branch.id],
      );
      assert.equal(rows[0]!.n, 1, 'the retry did not post a second movement');
    });

    // A genuinely DIFFERENT act on a terminal document still fails — it names
    // the state. Here the line (a variant this requisition never covered) has no
    // movement, so it is not a retry.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          returnRequisition(tdb, req.id, u1, [{ variantId: randomUUID(), qty: 1 }]),
        ),
      /cannot be returned.*status is 'returned'/,
      'a genuinely different return on a returned requisition is still refused',
    );
  });
});

// IMPORTANT 3: a requisition return is bounded by what THIS DOCUMENT delivered,
// not merely by the branch's on-hand. Stock the branch holds from ANOTHER source
// cannot be used to drive the document to `returned`.
test('a requisition return is bounded by what the document delivered', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'REQBOUND'));

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

    // The branch ALSO holds stock from another source — 100 units the
    // requisition never delivered.
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 100));

    // It holds 105, so the on-hand guard alone would allow this — the DELIVERED
    // bound is what refuses it, naming the limit.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          returnRequisition(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 10 }]),
        ),
      /delivered 5\.000 .*only 5\.000 can go back/,
      'a return bigger than the requisition delivered is refused, naming the limit',
    );

    // The refusal committed nothing: the requisition is still `received`.
    await withTenant(db, t1, async (tdb) => {
      const { rows: hdr } = await tdb.query<{ status: string }>(
        'select status from requisitions where id = $1',
        [req.id],
      );
      assert.equal(hdr[0]!.status, 'received', 'the refused return leaves the requisition received');
    });

    // Returning exactly what was delivered is accepted.
    const ok = await withTenant(db, t1, (tdb) =>
      returnRequisition(tdb, req.id, u1, [{ variantId: ctx.variantId, qty: 5 }]),
    );
    assert.equal(ok.status, 'returned', 'returning the delivered quantity is accepted');
  });
});

// CRITICAL 1: the availability guard is SERIALISED by an advisory lock. Two
// concurrent returns of the FULL available quantity for the same (variant,
// branch) must not both read the same balance and both post — without the lock
// both succeed and the branch ends at -10; with it, exactly one succeeds and the
// branch ends at 0, never negative.
test('concurrent returns cannot drive the source negative', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'RACE'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 10));

    // Two SEPARATE connections, each with its own transaction and the tenant
    // pinned, both attempting a return of the whole 10.
    const c1 = new Client({ connectionString: sqlTestUrl()! });
    const c2 = new Client({ connectionString: sqlTestUrl()! });
    await c1.connect();
    await c2.connect();
    try {
      for (const c of [c1, c2]) {
        await c.query('begin');
        await c.query("select set_config('app.tenant_id', $1, true)", [t1]);
      }

      const input = (key: string) => ({
        variantId: ctx.variantId,
        qty: 10,
        fromLocationId: ctx.branch.id,
        disposition: 'restock' as const,
        idempotencyKey: key,
        actorUserId: u1,
      });

      // Commit (or roll back a refused attempt) as soon as each settles, so
      // whichever holds the lock releases it and the pair never deadlocks.
      const run = (c: Client, key: string) =>
        postReturn(c, input(key)).then(
          async (r) => {
            await c.query('commit');
            return { ok: true as const, r };
          },
          async (e) => {
            await c.query('rollback');
            return { ok: false as const, e: e as Error };
          },
        );

      const [a, b] = await Promise.all([run(c1, randomUUID()), run(c2, randomUUID())]);
      const succeeded = [a, b].filter((x) => x.ok).length;
      assert.equal(succeeded, 1, 'exactly one of two concurrent full returns may succeed');
    } finally {
      await c1.end().catch(() => {});
      await c2.end().catch(() => {});
    }

    await withTenant(db, t1, async (tdb) => {
      const by = await onHandBy(tdb, ctx.variantId);
      assert.equal(
        by[ctx.branch.id] ?? '0.000',
        '0.000',
        'the branch is emptied, not overdrawn — the source never goes negative',
      );
    });
  });
});

// Review Focus #2: the idempotency key is REQUIRED and belongs to the CALLER,
// one per return INTENT. A retry of the same intent (same key) posts exactly
// ONCE, while two genuinely DIFFERENT returns of the same variant from the same
// branch — each with its OWN key — BOTH post. There is deliberately no derived
// fallback: a key guessed from the disposition, variant and source cannot tell
// the two apart and would silently swallow the second.
test('two returns with different keys both post, and the same key posts once', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'IDEM'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 5));

    const refId = randomUUID();
    const shared = {
      variantId: ctx.variantId,
      qty: 2,
      fromLocationId: ctx.branch.id,
      disposition: 'restock' as const,
      refType: 'customer_return',
      refId,
      actorUserId: u1,
    };

    // The SAME key twice: one return intent, retried. It must collapse onto the
    // first movement, not post a second.
    const keyA = randomUUID();
    const first = await withTenant(db, t1, (tdb) =>
      postReturn(tdb, { ...shared, idempotencyKey: keyA }),
    );
    const retry = await withTenant(db, t1, (tdb) =>
      postReturn(tdb, { ...shared, idempotencyKey: keyA }),
    );
    assert.equal(retry.id, first.id, 'a retried return resolves to the SAME ledger movement');

    await withTenant(db, t1, async (tdb) => {
      const by = await onHandBy(tdb, ctx.variantId);
      assert.equal(by[ctx.warehouse.id], '2.000', 'the warehouse gained the 2 once, not twice');
    });

    // A DIFFERENT key is a genuinely different return of the same variant from
    // the same branch — it MUST post.
    const keyB = randomUUID();
    const second = await withTenant(db, t1, (tdb) =>
      postReturn(tdb, { ...shared, idempotencyKey: keyB }),
    );
    assert.notEqual(second.id, first.id, 'a different key is a different movement');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1 and ref_type = $2 and ref_id = $3',
        [ctx.variantId, 'CUSTOMER_RETURN', refId],
      );
      assert.equal(rows[0]!.n, 2, 'two different keys post TWO movements — the second is not swallowed');
      const by = await onHandBy(tdb, ctx.variantId);
      assert.equal(by[ctx.warehouse.id], '4.000', 'both genuine returns landed');
      assert.equal(by[ctx.branch.id], '1.000', 'the branch is debited only for the two real returns');
    });
  });
});

// The key is mandatory: there is no derived fallback to hide a missing one.
test('a return with no idempotency key is refused', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'NOKEY'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 2));

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          postReturn(tdb, {
            variantId: ctx.variantId,
            qty: 1,
            fromLocationId: ctx.branch.id,
            disposition: 'restock',
            idempotencyKey: '',
            actorUserId: u1,
          }),
        ),
      /idempotencyKey must be a non-empty string/,
      'a return with no key cannot be made idempotent and must be refused',
    );

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1 and ref_type = $2',
        [ctx.variantId, 'CUSTOMER_RETURN'],
      );
      assert.equal(rows[0]!.n, 0, 'nothing may be written when the key is missing');
    });
  });
});

// NEVER LET STOCK GO NEGATIVE BY ACCIDENT: a return bigger than the source
// actually holds is REFUSED, naming the location and the available quantity, and
// NOTHING is committed — the refused return rolls back with the caller's
// transaction, leaving the branch's on-hand untouched and no movement behind.
test('a return of more than the branch holds is refused', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

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
            idempotencyKey: randomUUID(),
            actorUserId: u1,
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
            idempotencyKey: randomUUID(),
            actorUserId: u1,
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

// The actor is REQUIRED on the input, so a caller that forgets it is a TYPE
// ERROR. This proves the RUN-TIME gate as well, so an untyped/JS caller or a
// cast cannot slip an anonymous return onto the ledger — "who took what" must
// hold for returns, which are decisions a person makes.
test('a return cannot omit its actor', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'NOACTOR'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.branch.id, 2));

    const base = {
      variantId: ctx.variantId,
      qty: 1,
      fromLocationId: ctx.branch.id,
      disposition: 'restock' as const,
      idempotencyKey: randomUUID(),
    };

    // OMITTED — only reachable past the compiler by a cast (or from JS).
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          postReturn(tdb, base as unknown as Parameters<typeof postReturn>[1]),
        ),
      /actorUserId must be a non-empty user id/,
      'a return with no actor is refused',
    );

    // EMPTY — present but not a real user id, refused the same way.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          postReturn(tdb, { ...base, actorUserId: '   ' }),
        ),
      /actorUserId must be a non-empty user id/,
      'a blank actor is refused',
    );

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from stock_movements where variant_id = $1',
        [ctx.variantId],
      );
      assert.equal(rows[0]!.n, 1, 'only the seed movement exists — no anonymous return was written');
    });
  });
});
