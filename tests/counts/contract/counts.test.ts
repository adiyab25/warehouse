import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { withTenant } from '@/modules/platform/index';
import { closeCount, openCount, recordCount } from '@/modules/counts/index';
import { createItem } from '@/modules/catalog/index';
import { createLocation } from '@/modules/locations/index';
import { onHand, postMovement } from '@/modules/ledger/index';
import { migrateUrl, sqlTestUrl, withDb } from '../../harness/sql.ts';

/**
 * Contract tests for STOCKTAKE: a count freezes what the system expected, records
 * what was actually found, and posts the difference as ONE ledger movement.
 *
 * The properties that matter are:
 *
 *   - the expected quantity is FROZEN at open: a movement posted while the
 *     sheets are out never moves the target the counter is measured against;
 *   - closing posts ONE `count_correction` movement per non-zero variance, and
 *     nothing at all when a session has no variance;
 *   - an UNCOUNTED line (counted_qty NULL) produces NO movement and is NOT a
 *     write-off — the on-hand must be left exactly as it was;
 *   - a closed session is FROZEN and UNDELETABLE, and closing twice is refused
 *     naming the state;
 *   - a line for ANOTHER tenant is refused by the composite foreign key.
 *
 * Tenants are provisioned over the OWNER connection (`migrateUrl()`); everything
 * the app does runs as the non-superuser `authenticated` role.
 */

type Provisioned = { t1: string; t2: string; u1: string; u2: string };

const provisionedTenants: string[] = [];

/** Creates two tenants, each with one app_user, over the OWNER connection. */
async function provision(): Promise<Provisioned> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const {
      rows: [t1],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Cnt One') returning id");
    const {
      rows: [t2],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Cnt Two') returning id");
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

// Cleanup. `stock_movements` is append-only and a closed session is undeletable,
// so both are cleared with `session_replication_role = replica` on the owner
// connection. Child rows first, for the FKs.
after(async () => {
  if (provisionedTenants.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('set session_replication_role = replica');
    await owner.query('delete from count_lines where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from count_sessions where tenant_id = any($1)', [provisionedTenants]);
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

/** The count cast: a shelf to count, one item with its variant. */
async function setup(
  db: AnyDb,
  suffix: string,
): Promise<{ shelf: { id: string }; itemId: string; variantId: string }> {
  const shelf = await createLocation(db, { code: `SH-${suffix}`, nameAr: 'الرف', type: 'branch' });
  const created = await createItem(db, {
    nameAr: 'قميص',
    nameEn: 'Shirt',
    family: 'sellable',
    sku: `CT-${suffix}`,
    barcode: `CT-${suffix}`,
  });
  return { shelf, itemId: created.item.id, variantId: created.variant.id };
}

/** Puts stock INTO a location through the ledger, so on-hand is real, not seeded. */
async function seed(db: AnyDb, variantId: string, locationId: string, qty: number): Promise<void> {
  await postMovement(db, { variantId, qty, reason: 'opening_balance', toLocationId: locationId });
}

/** The on-hand of one (variant, location) as a string, absence coalesced to 0. */
async function onHandAt(db: AnyDb, variantId: string, locationId: string): Promise<string> {
  const rows = await onHand(db, { variantId, locationId });
  return rows[0]?.qty ?? '0.000';
}

test('the expected quantity is frozen when the session opens', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'FREEZE'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 10));

    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );

    // A movement lands while the sheets are out — the shelf really holds 15 now.
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 5));

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ expected_qty: string; counted_qty: string | null }>(
        'select expected_qty, counted_qty from count_lines where count_session_id = $1 and variant_id = $2',
        [session.id, ctx.variantId],
      );
      assert.equal(rows[0]?.expected_qty, '10.000', 'the expected quantity is frozen at open, not moved by the +5');
      assert.equal(rows[0]?.counted_qty, null, 'nothing is counted yet — NULL, not zero');
      assert.equal(
        await onHandAt(tdb, ctx.variantId, ctx.shelf.id),
        '15.000',
        'the shelf really does hold 15 — the ledger moved, only the expectation stayed put',
      );
    });
  });
});

test('closing posts one correction movement per variance', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'CORRECT'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 10));

    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );
    await withTenant(db, t1, (tdb) =>
      recordCount(tdb, session.id, [{ variantId: ctx.variantId, countedQty: 8 }]),
    );

    const result = await withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1));
    assert.equal(result.adjustments, 1, 'expected 10, counted 8 — one correction');

    await withTenant(db, t1, async (tdb) => {
      const { rows: mv } = await tdb.query<{
        qty: string;
        from_location_id: string | null;
        to_location_id: string | null;
        reason: string;
        ref_type: string | null;
        ref_id: string | null;
        actor_user_id: string | null;
      }>(
        "select qty, from_location_id, to_location_id, reason, ref_type, ref_id, actor_user_id from stock_movements where variant_id = $1 and reason = 'count_correction'",
        [ctx.variantId],
      );
      assert.equal(mv.length, 1, 'one variance, exactly one ledger movement');
      assert.equal(mv[0]?.qty, '2.000', 'the shortage is the magnitude 2');
      assert.equal(mv[0]?.from_location_id, ctx.shelf.id, 'a shortage LEAVES the counted location');
      assert.equal(mv[0]?.to_location_id, null, 'a shortage is one-sided — there is no destination');
      assert.equal(mv[0]?.ref_type, 'COUNT', 'the correction points back at a count');
      assert.equal(mv[0]?.ref_id, session.id, 'ref_id is the session');
      assert.equal(mv[0]?.actor_user_id, u1, 'the closer is written to the movement actor');

      assert.equal(await onHandAt(tdb, ctx.variantId, ctx.shelf.id), '8.000', 'the ledger now says 8 — the count is truth');

      const { rows: hdr } = await tdb.query<{ status: string; closed_by: string | null; closed_at: Date | null }>(
        'select status, closed_by, closed_at from count_sessions where id = $1',
        [session.id],
      );
      assert.equal(hdr[0]?.status, 'closed', 'the session is closed');
      assert.equal(hdr[0]?.closed_by, u1, 'closed_by is actually written');
      assert.ok(hdr[0]?.closed_at, 'closed_at is stamped');
    });
  });
});

test('a session with no variance posts nothing', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'NOVAR'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 10));

    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );
    await withTenant(db, t1, (tdb) =>
      recordCount(tdb, session.id, [{ variantId: ctx.variantId, countedQty: 10 }]),
    );

    const result = await withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1));
    assert.equal(result.adjustments, 0, 'a matching count posts nothing');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where variant_id = $1 and reason = 'count_correction'",
        [ctx.variantId],
      );
      assert.equal(rows[0]!.n, 0, 'no movement may be written for a zero variance');
    });
  });
});

test('a mid-count ISSUE reconciles the ledger to the shelf, not to the frozen sheet', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'MOVEISS'));

    // The sheet freezes expected = 100.
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 100));
    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );

    // ...then 20 leaves the shelf WHILE THE SHEETS ARE OUT. The ledger now
    // holds 80 — the frozen expectation of 100 is stale.
    await withTenant(db, t1, (tdb) =>
      postMovement(tdb, {
        variantId: ctx.variantId,
        qty: 20,
        reason: 'write_off',
        fromLocationId: ctx.shelf.id,
      }),
    );

    // The shelf is counted at 75.
    await withTenant(db, t1, (tdb) =>
      recordCount(tdb, session.id, [{ variantId: ctx.variantId, countedQty: 75 }]),
    );

    const result = await withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1));
    assert.equal(result.adjustments, 1, 'counted 75 against a live ledger of 80 — one correction');
    assert.ok(result.movementsDuringCount >= 1, 'the mid-count issue must be reported as the shelf moving');

    await withTenant(db, t1, async (tdb) => {
      // The drift report still says −25 (counted 75 vs frozen 100): that is the
      // "what changed since we started" number, NOT the posted amount.
      const { rows: cl } = await tdb.query<{ variance_qty: string }>(
        'select variance_qty from count_lines where count_session_id = $1 and variant_id = $2',
        [session.id, ctx.variantId],
      );
      assert.equal(cl[0]?.variance_qty, '-25.000', 'variance_qty is DRIFT since open, kept as the report');

      const { rows: mv } = await tdb.query<{
        qty: string;
        from_location_id: string | null;
        to_location_id: string | null;
        reason: string;
      }>(
        "select qty, from_location_id, to_location_id, reason from stock_movements where variant_id = $1 and reason = 'count_correction'",
        [ctx.variantId],
      );
      assert.equal(mv.length, 1, 'exactly one correction');
      assert.equal(mv[0]?.qty, '5.000', 'the reconciliation is |75 − 80| = 5, NOT the frozen |−25|');
      assert.equal(mv[0]?.from_location_id, ctx.shelf.id, 'the ledger held more, so the correction leaves the shelf');
      assert.equal(mv[0]?.to_location_id, null, 'one-sided — from only');
      assert.equal(mv[0]?.reason, 'count_correction', 'reason is count_correction');

      // THE POINT OF THE WHOLE FIX: the ledger ends at exactly what was counted.
      assert.equal(
        await onHandAt(tdb, ctx.variantId, ctx.shelf.id),
        '75.000',
        'the ledger ends at 75, NOT at 55 (which the frozen formula would have produced)',
      );
    });
  });
});

test('a mid-count RETURN reconciles the ledger to the shelf, not to the frozen sheet', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'MOVERET'));

    // The sheet freezes expected = 50.
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 50));
    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );

    // ...then 30 comes back to the shelf WHILE THE SHEETS ARE OUT. The ledger
    // now holds 80 — the frozen expectation of 50 is stale.
    await withTenant(db, t1, (tdb) =>
      postMovement(tdb, {
        variantId: ctx.variantId,
        qty: 30,
        reason: 'return_from_branch',
        toLocationId: ctx.shelf.id,
      }),
    );

    // The shelf is counted at 90.
    await withTenant(db, t1, (tdb) =>
      recordCount(tdb, session.id, [{ variantId: ctx.variantId, countedQty: 90 }]),
    );

    const result = await withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1));
    assert.equal(result.adjustments, 1, 'counted 90 against a live ledger of 80 — one correction');
    assert.ok(result.movementsDuringCount >= 1, 'the mid-count return must be reported as the shelf moving');

    await withTenant(db, t1, async (tdb) => {
      // Drift report: counted 90 vs frozen 50 = +40. NOT the posted amount.
      const { rows: cl } = await tdb.query<{ variance_qty: string }>(
        'select variance_qty from count_lines where count_session_id = $1 and variant_id = $2',
        [session.id, ctx.variantId],
      );
      assert.equal(cl[0]?.variance_qty, '40.000', 'variance_qty is DRIFT since open, kept as the report');

      const { rows: mv } = await tdb.query<{
        qty: string;
        from_location_id: string | null;
        to_location_id: string | null;
      }>(
        "select qty, from_location_id, to_location_id from stock_movements where variant_id = $1 and reason = 'count_correction'",
        [ctx.variantId],
      );
      assert.equal(mv.length, 1, 'exactly one correction');
      assert.equal(mv[0]?.qty, '10.000', 'the reconciliation is 90 − 80 = 10, NOT the frozen +40');
      assert.equal(mv[0]?.from_location_id, null, 'the shelf held less, so the correction arrives — one-sided');
      assert.equal(mv[0]?.to_location_id, ctx.shelf.id, 'a surplus arrives at the counted location');

      assert.equal(
        await onHandAt(tdb, ctx.variantId, ctx.shelf.id),
        '90.000',
        'the ledger ends at 90, NOT at 120 (which the frozen formula would have produced)',
      );
    });
  });
});

test('a count with no mid-count movement reports zero movements and reconciles to the same figure', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'STILL'));

    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 40));
    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );
    await withTenant(db, t1, (tdb) =>
      recordCount(tdb, session.id, [{ variantId: ctx.variantId, countedQty: 37 }]),
    );

    const result = await withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1));
    assert.equal(result.adjustments, 1, 'counted 37 vs expected 40 — one correction');
    assert.equal(result.movementsDuringCount, 0, 'nothing moved between open and close');

    await withTenant(db, t1, async (tdb) => {
      const { rows: mv } = await tdb.query<{ qty: string; from_location_id: string | null }>(
        "select qty, from_location_id from stock_movements where variant_id = $1 and reason = 'count_correction'",
        [ctx.variantId],
      );
      assert.equal(mv.length, 1, 'exactly one correction');
      assert.equal(mv[0]?.qty, '3.000', 'the drift is 37 − 40 = −3, and with no mid-count move the reconciliation agrees');
      assert.equal(mv[0]?.from_location_id, ctx.shelf.id, 'a shortage leaves the counted location');
      assert.equal(await onHandAt(tdb, ctx.variantId, ctx.shelf.id), '37.000', 'the ledger now says 37');
    });
  });
});

test('an uncounted line posts nothing even when stock moved mid-count', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'UNCMOVE'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 10));

    // Open snapshots the line with counted_qty NULL; the shelf is NEVER counted.
    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );

    // A movement lands mid-count anyway.
    await withTenant(db, t1, (tdb) =>
      postMovement(tdb, {
        variantId: ctx.variantId,
        qty: 4,
        reason: 'write_off',
        fromLocationId: ctx.shelf.id,
      }),
    );

    const result = await withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1));
    assert.equal(result.adjustments, 0, 'an uncounted line is not a variance — nothing is posted');
    assert.ok(result.movementsDuringCount >= 1, 'the mid-count move is still reported');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where variant_id = $1 and reason = 'count_correction'",
        [ctx.variantId],
      );
      assert.equal(rows[0]!.n, 0, 'no correction, and above all no phantom write-off, was written');
      assert.equal(
        await onHandAt(tdb, ctx.variantId, ctx.shelf.id),
        '6.000',
        'only the mid-count write-off moved the shelf; the count wrote NOTHING',
      );
    });
  });
});

test('an uncounted line posts nothing and is not a write-off', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'UNCOUNT'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 10));

    // Open snapshots the line with counted_qty NULL; the shelf is then NEVER
    // counted.
    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );

    const result = await withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1));
    assert.equal(result.adjustments, 0, 'an uncounted line is not a variance — nothing is posted');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where variant_id = $1",
        [ctx.variantId],
      );
      // Only the original opening_balance: the count wrote NOTHING.
      assert.equal(rows[0]!.n, 1, 'no correction, and above all no phantom write-off, was written');
      assert.equal(
        await onHandAt(tdb, ctx.variantId, ctx.shelf.id),
        '10.000',
        'the on-hand is UNCHANGED — an uncounted line must never write stock off',
      );
    });
  });
});

test('closing twice is refused, and a closed session cannot be reopened', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'TWICE'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 4));

    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );
    await withTenant(db, t1, (tdb) =>
      recordCount(tdb, session.id, [{ variantId: ctx.variantId, countedQty: 2 }]),
    );
    await withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1));

    // Closing again is refused, naming the state.
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1)),
      /status is 'closed'/,
      'closing a closed session must be refused, naming the state',
    );

    // A raw UPDATE cannot move the session back out of `closed` — the frozen
    // document is enforced by the database, not merely by the app guard above.
    await withTenant(db, t1, async (tdb) => {
      await assert.rejects(
        () => tdb.query("update count_sessions set status = 'open' where id = $1", [session.id]),
        /terminal/,
        'the closed session is terminal — a raw reopen must be refused',
      );
    });
  });
});

test('a closed session is frozen and undeletable; an open mistake can be deleted', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'FROZEN'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 5));

    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );
    await withTenant(db, t1, (tdb) =>
      recordCount(tdb, session.id, [{ variantId: ctx.variantId, countedQty: 3 }]),
    );
    await withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1));

    // The line is frozen once the session is closed.
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query('update count_lines set counted_qty = 5 where count_session_id = $1', [session.id]),
        ),
      /frozen/,
      "a closed session's lines are frozen",
    );

    // The session is undeletable — its movement is an orphan no FK can catch.
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => tdb.query('delete from count_sessions where id = $1', [session.id])),
      /cannot be deleted/,
      'a closed session with written movements must not be deletable',
    );

    // Positive control: an OPEN session with no written movements is still
    // deletable — only a closed/committed one is frozen.
    const openOne = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );
    await withTenant(db, t1, async (tdb) => {
      await tdb.query('delete from count_sessions where id = $1', [openOne.id]);
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from count_sessions where id = $1',
        [openOne.id],
      );
      assert.equal(rows[0]!.n, 0, 'an open session opened by mistake can still be deleted');
    });
  });
});

test('recordCount refuses on a closed session', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'RECCLOSED'));
    await withTenant(db, t1, (tdb) => seed(tdb, ctx.variantId, ctx.shelf.id, 5));

    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );
    await withTenant(db, t1, (tdb) => closeCount(tdb, session.id, u1));

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          recordCount(tdb, session.id, [{ variantId: ctx.variantId, countedQty: 4 }]),
        ),
      /status is 'closed'/,
      'a closed session is frozen — recording into it must be refused, naming the state',
    );
  });
});

test('a line for another tenant is refused', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2, u1, u2 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'T1'));
    // A variant that belongs to the OTHER tenant.
    const otherVariant = await withTenant(db, t2, async (tdb) => {
      const created = await createItem(tdb, {
        nameAr: 'بنطال',
        nameEn: 'Trousers',
        family: 'sellable',
        sku: 'CT-OTHER',
        barcode: 'CT-OTHER',
      });
      return created.variant.id;
    });

    const session = await withTenant(db, t1, (tdb) =>
      openCount(tdb, { locationId: ctx.shelf.id, startedBy: u1 }),
    );

    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          recordCount(tdb, session.id, [{ variantId: otherVariant, countedQty: 1 }]),
        ),
      /foreign key|violates/i,
      'the composite FK must refuse a variant of another tenant',
    );

    // Nothing was written: the count sheet holds no line for the foreign variant.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        'select count(*)::int as n from count_lines where count_session_id = $1 and variant_id = $2',
        [session.id, otherVariant],
      );
      assert.equal(rows[0]!.n, 0, 'a cross-tenant line must not be recorded');
    });

    // The owning tenant still exists and is untouched — the other user's count
    // reflects the defence, not a silent success.
    assert.ok(u2, 'the second tenant user was provisioned');
  });
});
