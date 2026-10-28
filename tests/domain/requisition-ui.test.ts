import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import {
  answered,
  approveIn,
  confirmIn,
  getRequisition,
  issueIn,
  listRequisitions,
  requestIn,
} from '../../src/app/requisitions/handler.ts';
import { createSession } from '../../src/auth/session.ts';
import { withTenant } from '../../src/db/client.ts';
import { transitLocation } from '../../src/db/locations.ts';
import { onHand } from '../../src/db/movements.ts';
import type { RequisitionStatus } from '../../src/domain/requisition.ts';
import {
  REFUSAL_MESSAGE_KEYS,
  availableActions,
  confirmProblem,
  issueAnchor,
  type RequisitionRefusal,
} from '../../src/domain/requisition-ui.ts';
import { hasKey } from '../../src/i18n/index.ts';
import { migrateUrl, sqlTestUrl, withDb } from '../harness/sql.ts';

/**
 * The REQUISITION SCREENS' rules and their server-side seams (Task 14).
 *
 * Two halves, deliberately in one file because they guard the SAME decisions:
 *
 *   (1) PURE rules — which affordances the current STATE and the viewer's ROLE
 *       permit, and what makes a partial issue/confirm legal. No database.
 *   (2) The HANDLER — driven directly against a real database, because a hidden
 *       button is not a permission: a `branch_user` must be refused at the seam,
 *       not merely in the markup.
 *
 * The properties that matter:
 *   - the confirm affordance exists only where stock is really in transit
 *     (`issued` or `partially_issued` — rule 8's tension with the plan's
 *     wording, resolved toward the real state machine);
 *   - confirming beyond `issued - received` is refused with `wrong_state`;
 *   - a branch user sees ONLY their own branch's requisitions and cannot
 *     approve, issue or confirm another branch's document;
 *   - issuing moves stock warehouse -> transit and a double submit posts ONE
 *     movement;
 *   - a `partially_issued` requisition is continuable (issue the rest, confirm
 *     what arrived) from the seam the screen drives.
 */

// `onHand` is imported from src/db/movements.ts above; the ledger read-back
// below uses it directly.

type Fixture = {
  tenant: string;
  owner: string;
  manager: string;
  branchUserA: string;
  branchUserB: string;
  branchA: string;
  branchB: string;
  warehouse: string;
  variant1: string;
  variant2: string;
};

const created: string[] = [];

/**
 * Provisions one tenant with the three roles, two branches, a warehouse and two
 * catalogue items — over the OWNER connection, exactly as the contract suites
 * do. Everything the app does afterwards runs as `authenticated` through
 * `withDb`.
 */
async function provision(): Promise<Fixture> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const {
      rows: [tenant],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Req UI') returning id");
    const tenantId = tenant!.id;

    const locations: Record<string, string> = {};
    for (const [code, nameAr, type] of [
      ['WH-U1', 'المخزن', 'warehouse'],
      ['BR-UA', 'فرع أ', 'branch'],
      ['BR-UB', 'فرع ب', 'branch'],
    ] as const) {
      const {
        rows: [loc],
      } = await owner.query<{ id: string }>(
        'insert into locations (tenant_id, code, name_ar, type) values ($1, $2, $3, $4) returning id',
        [tenantId, code, nameAr, type],
      );
      locations[code] = loc!.id;
    }

    const variants: string[] = [];
    for (const [nameAr, sku] of [
      ['قميص', 'AB-0012'],
      ['حزام', 'AB-0013'],
    ] as const) {
      const {
        rows: [item],
      } = await owner.query<{ id: string }>(
        "insert into items (tenant_id, name_ar, family) values ($1, $2, 'sellable') returning id",
        [tenantId, nameAr],
      );
      const {
        rows: [variant],
      } = await owner.query<{ id: string }>(
        'insert into item_variants (tenant_id, item_id, sku, barcode) values ($1, $2, $3, $3) returning id',
        [tenantId, item!.id, sku],
      );
      variants.push(variant!.id);
    }

    const users: Record<string, string> = {};
    for (const [username, name, role, branch] of [
      ['owner', 'أحمد علي', 'owner', null],
      ['mona', 'منى حسن', 'warehouse_manager', null],
      ['branch1', 'فرع أ', 'branch_user', locations['BR-UA']!],
      ['branch2', 'فرع ب', 'branch_user', locations['BR-UB']!],
    ] as const) {
      const {
        rows: [u],
      } = await owner.query<{ id: string }>(
        `insert into app_users (tenant_id, name, name_normalised, username, role, branch_location_id, password_hash)
         values ($1, $2, public.normalise_name($2), $3, $4, $5, 'x') returning id`,
        [tenantId, name, username, role, branch],
      );
      users[username] = u!.id;
    }

    created.push(tenantId);
    return {
      tenant: tenantId,
      owner: users.owner!,
      manager: users.mona!,
      branchUserA: users.branch1!,
      branchUserB: users.branch2!,
      branchA: locations['BR-UA']!,
      branchB: locations['BR-UB']!,
      warehouse: locations['WH-U1']!,
      variant1: variants[0]!,
      variant2: variants[1]!,
    };
  } finally {
    await owner.end();
  }
}

/** A live session token for `userId`, minted the way the app mints one. */
async function mintCookie(db: Client, tenant: string, userId: string): Promise<string> {
  const { token } = await withTenant(db, tenant, (tdb) => createSession(tdb, { userId }));
  return token;
}

after(async () => {
  if (created.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('set session_replication_role = replica');
    await owner.query('delete from requisition_lines where tenant_id = any($1)', [created]);
    await owner.query('delete from requisitions where tenant_id = any($1)', [created]);
    await owner.query('delete from stock_movements where tenant_id = any($1)', [created]);
    await owner.query('set session_replication_role = origin');
    await owner.query('delete from sessions where tenant_id = any($1)', [created]);
    await owner.query('delete from location_levels where tenant_id = any($1)', [created]);
    await owner.query('delete from item_variants where tenant_id = any($1)', [created]);
    await owner.query('delete from items where tenant_id = any($1)', [created]);
    await owner.query('delete from app_users where tenant_id = any($1)', [created]);
    await owner.query('delete from locations where tenant_id = any($1)', [created]);
    await owner.query('delete from tenants where id = any($1)', [created]);
  } finally {
    await owner.end();
  }
});

// ---------------------------------------------------------------------------
// (1) PURE — state and role decide the affordances.
// ---------------------------------------------------------------------------

test('the confirm button is absent unless status is issued', () => {
  const warehouse = 'warehouse_manager';
  const branch = 'branch_user';

  // Every state where NOTHING is in transit — the confirm affordance must be
  // ABSENT, for both roles. Rendering it unconditionally makes this fail.
  for (const status of [
    'requested',
    'approved',
    'received',
    'closed',
    'rejected',
    'returned',
  ] as RequisitionStatus[]) {
    assert.equal(
      availableActions(status, branch).canConfirm,
      false,
      `a branch user must have no confirm affordance while the requisition is '${status}'`,
    );
    assert.equal(
      availableActions(status, warehouse).canConfirm,
      false,
      `confirm is not a warehouse act — absent for '${status}' too`,
    );
  }

  // `issued` is the state the plan names: the affordance EXISTS there.
  assert.equal(availableActions('issued', branch).canConfirm, true);
  // ...and a warehouse role still does not confirm (confirming is the branch's).
  assert.equal(availableActions('issued', warehouse).canConfirm, false);
});

test('a partially_issued requisition still offers the confirm affordance (rule 4)', () => {
  // The plan's test name says "unless status is issued"; the REAL state machine
  // (src/domain/requisition.ts::canConfirm) puts stock in transit for
  // `partially_issued` too, and requiring a full issue before ANY confirm would
  // strand goods on the road with no way to close the document. Both partial and
  // full states therefore offer it — and nothing else does.
  assert.equal(availableActions('partially_issued', 'branch_user').canConfirm, true);
  assert.equal(availableActions('partially_issued', 'warehouse_manager').canConfirm, false);
  // Approve/issue are the warehouse's; a branch user gets neither.
  assert.equal(availableActions('requested', 'warehouse_manager').canApprove, true);
  assert.equal(availableActions('requested', 'branch_user').canApprove, false);
  assert.equal(availableActions('approved', 'warehouse_manager').canIssue, true);
  assert.equal(availableActions('partially_issued', 'warehouse_manager').canIssue, true);
  assert.equal(availableActions('issued', 'warehouse_manager').canIssue, false);
  assert.equal(availableActions('approved', 'branch_user').canIssue, false);
});

test('confirming beyond the issued quantity is a wrong_state problem', () => {
  assert.equal(
    confirmProblem('issued', { issued: 5, received: 0 }, 6),
    'wrong_state',
    'more than was issued cannot be confirmed',
  );
  assert.equal(
    confirmProblem('issued', { issued: 5, received: 3 }, 3),
    'wrong_state',
    'only issued-minus-received may still be confirmed',
  );
  assert.equal(
    confirmProblem('requested', { issued: 0, received: 0 }, 1),
    'wrong_state',
    'nothing is in transit while the requisition is still requested',
  );
  assert.equal(confirmProblem('issued', { issued: 5, received: 0 }, 5), null, 'exactly what was issued is fine');
  assert.equal(confirmProblem('issued', { issued: 5, received: 3 }, 2), null, 'the remainder in transit is fine');
  assert.equal(confirmProblem('issued', { issued: 5, received: 0 }, 0), 'invalid', 'zero is a mistake, not a quantity');

  // Every refusal code has its OWN message, in BOTH dictionaries — a `forbidden`
  // must never be dressed up as "you are not signed in".
  const codes: RequisitionRefusal[] = ['unauthenticated', 'forbidden', 'invalid', 'wrong_state'];
  const keys = codes.map((code) => REFUSAL_MESSAGE_KEYS[code]);
  assert.equal(new Set(keys).size, codes.length, 'each refusal code maps to a DISTINCT message key');
  for (const key of keys) {
    assert.equal(hasKey(key, 'ar'), true, `${key} must exist in Arabic`);
    assert.equal(hasKey(key, 'en'), true, `${key} must exist in English`);
  }
});

test('every requisition state and line state has a label in both dictionaries', () => {
  const statuses = [
    'requested',
    'approved',
    'partially_issued',
    'issued',
    'received',
    'closed',
    'rejected',
    'returned',
  ];
  for (const status of statuses) {
    const key = `requisitions.status.${status}`;
    assert.equal(hasKey(key, 'ar'), true, `${key} must exist in Arabic`);
    assert.equal(hasKey(key, 'en'), true, `${key} must exist in English`);
  }
  for (const line of ['open', 'fulfilled', 'short', 'rejected']) {
    const key = `requisitions.line_status.${line}`;
    assert.equal(hasKey(key, 'ar'), true, `${key} must exist in Arabic`);
    assert.equal(hasKey(key, 'en'), true, `${key} must exist in English`);
  }
});

// ---------------------------------------------------------------------------
// (2) THE HANDLER — driven directly, against a real database.
// ---------------------------------------------------------------------------

test('a branch user sees only their own branch requisitions', { skip: !sqlTestUrl() }, async () => {
  const f = await provision();

  await withDb(async (db) => {
    const cookieA = await mintCookie(db, f.tenant, f.branchUserA);
    const cookieB = await mintCookie(db, f.tenant, f.branchUserB);
    const cookieManager = await mintCookie(db, f.tenant, f.manager);

    const mineA = await withTenant(db, f.tenant, (tdb) =>
      requestIn(tdb, cookieA, { key: 'req-a', lines: [{ variantId: f.variant1, requestedQty: 3 }] }),
    );
    const mineB = await withTenant(db, f.tenant, (tdb) =>
      requestIn(tdb, cookieB, { key: 'req-b', lines: [{ variantId: f.variant1, requestedQty: 7 }] }),
    );

    const seenByA = await withTenant(db, f.tenant, (tdb) => listRequisitions(tdb, cookieA));
    assert.equal(seenByA.mayRequest, true, 'a branch user may request');
    assert.deepEqual(
      seenByA.requisitions.map((r) => r.id),
      [mineA.requisitionId],
      'a branch user must see ONLY their own branch’s requisitions',
    );
    assert.notEqual(mineB.requisitionId, mineA.requisitionId);

    const seenByManager = await withTenant(db, f.tenant, (tdb) => listRequisitions(tdb, cookieManager));
    assert.equal(seenByManager.mayApprove, true, 'a warehouse manager may approve');
    assert.deepEqual(
      seenByManager.requisitions.map((r) => r.id).sort(),
      [mineA.requisitionId, mineB.requisitionId].sort(),
      'the warehouse sees every branch’s requisitions',
    );

    // ...and the same scoping holds on the DETAIL read, not only the list.
    const foreign = await withTenant(db, f.tenant, (tdb) => getRequisition(tdb, cookieB, mineA.requisitionId));
    assert.equal(foreign.ok, false, 'branch B must not be able to open branch A’s requisition');
  });
});

test('a branch user cannot approve', { skip: !sqlTestUrl() }, async () => {
  const f = await provision();

  await withDb(async (db) => {
    const cookieA = await mintCookie(db, f.tenant, f.branchUserA);
    const { requisitionId } = await withTenant(db, f.tenant, (tdb) =>
      requestIn(tdb, cookieA, { key: 'req-a', lines: [{ variantId: f.variant1, requestedQty: 3 }] }),
    );

    const refused = await withTenant(db, f.tenant, (tdb) =>
      answered(() => approveIn(tdb, cookieA, { key: 'app-1', id: requisitionId })),
    );
    assert.equal(refused.ok, false, 'a branch user must not be able to approve');
    assert.equal(
      (refused as { ok: false; error: string }).error,
      'forbidden',
      'the refusal is `forbidden`, not "you are not signed in"',
    );

    // The document is untouched — approval is a SERVER-side decision, not a
    // hidden button.
    const detail = await withTenant(db, f.tenant, (tdb) => getRequisition(tdb, cookieA, requisitionId));
    assert.equal(detail.ok, true);
    assert.equal((detail as { status: RequisitionStatus }).status, 'requested');
  });
});

test('confirming beyond the issued quantity returns the wrong_state error key', { skip: !sqlTestUrl() }, async () => {
  const f = await provision();

  await withDb(async (db) => {
    const cookieA = await mintCookie(db, f.tenant, f.branchUserA);
    const cookieManager = await mintCookie(db, f.tenant, f.manager);

    const { requisitionId } = await withTenant(db, f.tenant, (tdb) =>
      requestIn(tdb, cookieA, { key: 'req-a', lines: [{ variantId: f.variant1, requestedQty: 5 }] }),
    );
    await withTenant(db, f.tenant, (tdb) => approveIn(tdb, cookieManager, { key: 'app', id: requisitionId }));
    await withTenant(db, f.tenant, (tdb) =>
      issueIn(tdb, cookieManager, { key: 'iss', id: requisitionId, lines: [{ variantId: f.variant1, qty: 5, from: 0 }] }),
    );

    const refused = await withTenant(db, f.tenant, (tdb) =>
      answered(() => confirmIn(tdb, cookieA, { key: 'con', id: requisitionId, lines: [{ variantId: f.variant1, qty: 6, from: 0 }] })),
    );
    assert.equal(refused.ok, false, 'confirming 6 against an issued 5 must be refused');
    assert.equal(
      (refused as { ok: false; error: string }).error,
      'wrong_state',
      'the refusal names the state rather than collapsing to a generic failure',
    );
    assert.equal(REFUSAL_MESSAGE_KEYS.wrong_state, 'requisitions.error.wrong_state');

    // Nothing was committed: the header still reads `issued` and the branch
    // holds nothing.
    const detail = await withTenant(db, f.tenant, (tdb) => getRequisition(tdb, cookieA, requisitionId));
    assert.equal((detail as { status: RequisitionStatus }).status, 'issued');
    await withTenant(db, f.tenant, async (tdb) => {
      const rows = await onHand(tdb, { variantId: f.variant1, locationId: f.branchA });
      assert.equal(rows[0]?.qtyNum ?? 0, 0, 'the refused confirm must not have moved stock to the branch');
    });
  });
});

test('issuing posts stock to transit, and a double submit posts exactly one movement', { skip: !sqlTestUrl() }, async () => {
  const f = await provision();

  await withDb(async (db) => {
    const cookieA = await mintCookie(db, f.tenant, f.branchUserA);
    const cookieManager = await mintCookie(db, f.tenant, f.manager);

    const { requisitionId } = await withTenant(db, f.tenant, (tdb) =>
      requestIn(tdb, cookieA, { key: 'req-a', lines: [{ variantId: f.variant1, requestedQty: 10 }] }),
    );
    await withTenant(db, f.tenant, (tdb) => approveIn(tdb, cookieManager, { key: 'app', id: requisitionId }));

    const leg = { variantId: f.variant1, qty: 6, from: 0 };
    const first = await withTenant(db, f.tenant, (tdb) =>
      answered(() => issueIn(tdb, cookieManager, { key: 'iss-1', id: requisitionId, lines: [leg] })),
    );
    assert.equal(first.ok, true);
    assert.equal((first as { status: RequisitionStatus }).status, 'partially_issued');

    // THE DOUBLE TAP: the same intent, re-submitted (same key, same content —
    // exactly what a lost response or a second tap produces).
    const second = await withTenant(db, f.tenant, (tdb) =>
      answered(() => issueIn(tdb, cookieManager, { key: 'iss-1', id: requisitionId, lines: [leg] })),
    );
    assert.equal(second.ok, true, 'a retry of the same leg is answered, not refused');

    const transit = await withTenant(db, f.tenant, (tdb) => transitLocation(tdb));
    await withTenant(db, f.tenant, async (tdb) => {
      const { rows } = await tdb.query<{ idempotency_key: string | null }>(
        `select idempotency_key
           from stock_movements
          where tenant_id = $1 and ref_type = 'REQUISITION' and ref_id = $2`,
        [f.tenant, requisitionId],
      );
      assert.equal(rows.length, 1, 'a double submit must post exactly ONE movement');
      assert.equal(
        rows[0]!.idempotency_key,
        issueAnchor(requisitionId, f.variant1, 6),
        'the anchor the screen holds matches the ledger key the write actually used',
      );

      const rows2 = await onHand(tdb, { variantId: f.variant1 });
      const by = Object.fromEntries(rows2.map((r) => [r.locationId, r.qty]));
      assert.equal(by[transit.id], '6.000', 'transit holds what was issued');
      assert.equal(by[f.branchA] ?? '0.000', '0.000', 'in-transit stock is NOT yet the branch’s');
      assert.equal(by[f.warehouse], '-6.000', 'the warehouse is debited');
    });

    // The same KEY with DIFFERENT content is not answered with the old row as
    // success — it is refused, and the ledger is untouched.
    const changed = await withTenant(db, f.tenant, (tdb) =>
      answered(() =>
        issueIn(tdb, cookieManager, {
          key: 'iss-1',
          id: requisitionId,
          lines: [{ variantId: f.variant1, qty: 999, from: 0 }],
        }),
      ),
    );
    assert.equal(changed.ok, false, 'a change of mind under an old key must be refused');
    await withTenant(db, f.tenant, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>(
        `select count(*)::int as n from stock_movements
          where tenant_id = $1 and ref_type = 'REQUISITION' and ref_id = $2`,
        [f.tenant, requisitionId],
      );
      assert.equal(rows[0]!.n, 1, 'the refused change must not have written a movement');
    });
  });
});

test('a partially_issued requisition is continuable from the seam the screen drives', { skip: !sqlTestUrl() }, async () => {
  const f = await provision();

  await withDb(async (db) => {
    const cookieA = await mintCookie(db, f.tenant, f.branchUserA);
    const cookieManager = await mintCookie(db, f.tenant, f.manager);

    const { requisitionId } = await withTenant(db, f.tenant, (tdb) =>
      requestIn(tdb, cookieA, { key: 'req-a', lines: [{ variantId: f.variant1, requestedQty: 10 }] }),
    );
    await withTenant(db, f.tenant, (tdb) => approveIn(tdb, cookieManager, { key: 'app', id: requisitionId }));

    // Partial issue of 6, confirmed for what arrived: the document stays open.
    await withTenant(db, f.tenant, (tdb) =>
      issueIn(tdb, cookieManager, { key: 'iss-1', id: requisitionId, lines: [{ variantId: f.variant1, qty: 6, from: 0 }] }),
    );
    const confirmed = await withTenant(db, f.tenant, (tdb) =>
      confirmIn(tdb, cookieA, { key: 'con-1', id: requisitionId, lines: [{ variantId: f.variant1, qty: 6, from: 0 }] }),
    );
    assert.equal((confirmed as { status: RequisitionStatus }).status, 'partially_issued', 'more is still to come');

    // The detail view still offers ISSUE (the warehouse releases the rest) and
    // no longer offers approve.
    const mid = await withTenant(db, f.tenant, (tdb) => getRequisition(tdb, cookieManager, requisitionId));
    assert.equal((mid as { status: RequisitionStatus }).status, 'partially_issued');
    assert.equal((mid as { actions: { canIssue: boolean } }).actions.canIssue, true, 'the rest can still be released');

    // Release the remaining 4 (a SECOND leg, from the state the form rendered).
    const rest = await withTenant(db, f.tenant, (tdb) =>
      issueIn(tdb, cookieManager, { key: 'iss-2', id: requisitionId, lines: [{ variantId: f.variant1, qty: 4, from: 6 }] }),
    );
    assert.equal((rest as { status: RequisitionStatus }).status, 'issued');

    // ...and confirm the remaining 4. The branch ends up holding the whole 10.
    const done = await withTenant(db, f.tenant, (tdb) =>
      confirmIn(tdb, cookieA, { key: 'con-2', id: requisitionId, lines: [{ variantId: f.variant1, qty: 4, from: 6 }] }),
    );
    assert.equal((done as { status: RequisitionStatus }).status, 'received');

    await withTenant(db, f.tenant, async (tdb) => {
      const rows = await onHand(tdb, { variantId: f.variant1, locationId: f.branchA });
      assert.equal(rows[0]?.qty, '10.000', 'the branch ends up holding the whole 10');
      const { rows: mv } = await tdb.query<{ n: number }>(
        `select count(*)::int as n from stock_movements
          where tenant_id = $1 and ref_type = 'REQUISITION' and ref_id = $2`,
        [f.tenant, requisitionId],
      );
      assert.equal(mv[0]!.n, 4, 'two issue legs and two confirm legs = four movements');
    });
  });
});

test('a branch user cannot confirm another branch’s requisition', { skip: !sqlTestUrl() }, async () => {
  const f = await provision();

  await withDb(async (db) => {
    const cookieA = await mintCookie(db, f.tenant, f.branchUserA);
    const cookieB = await mintCookie(db, f.tenant, f.branchUserB);
    const cookieManager = await mintCookie(db, f.tenant, f.manager);

    const { requisitionId } = await withTenant(db, f.tenant, (tdb) =>
      requestIn(tdb, cookieA, { key: 'req-a', lines: [{ variantId: f.variant1, requestedQty: 5 }] }),
    );
    await withTenant(db, f.tenant, (tdb) => approveIn(tdb, cookieManager, { key: 'app', id: requisitionId }));
    await withTenant(db, f.tenant, (tdb) =>
      issueIn(tdb, cookieManager, { key: 'iss', id: requisitionId, lines: [{ variantId: f.variant1, qty: 5, from: 0 }] }),
    );

    const refused = await withTenant(db, f.tenant, (tdb) =>
      answered(() => confirmIn(tdb, cookieB, { key: 'con', id: requisitionId, lines: [{ variantId: f.variant1, qty: 5, from: 0 }] })),
    );
    assert.equal(refused.ok, false, 'another branch must not confirm this document');
    assert.equal((refused as { ok: false; error: string }).error, 'forbidden');
  });
});
