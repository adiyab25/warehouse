import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { createSession } from '@/modules/auth/index';
import { withTenant } from '@/modules/platform/index';
import { createItem } from '@/modules/catalog/index';
import { createLocation } from '@/modules/locations/index';
import { postMovement } from '@/modules/ledger/index';
import { approve, confirmReceipt, createRequisition, issue } from '@/modules/requisitions/index';
import {
  MOVEMENT_HISTORY_LIMIT,
  movementHistoryDetailed,
  onHandByLocation,
  usageByBranch,
  usageTotalEgp,
} from '@/modules/branch-usage/index';
import { MOVEMENT_REASONS, REASON_MESSAGE_KEYS } from '@/modules/ledger/domain/movement';
import { hasKey } from '@/i18n/index';
import { getUsageReport, getVariantHistory, listStock, monthWindow } from '@/app/stock/handler';
import { migrateUrl, sqlTestUrl, withDb } from '../../harness/sql.ts';

/**
 * Contract tests for the on-hand and "where did it go" screens (Task 15).
 *
 *   - ON HAND OMITS ZERO ROWS: a pair that nets to zero is a view row with
 *     qty = 0 and must not clutter the list; and every joined field (name, sku,
 *     location) must be NON-EMPTY — a `rows.length > 0` assertion would have
 *     passed the bug that shipped a blank product name last task.
 *   - VALUE IS COMPUTED IN THE DATABASE, EXACTLY: 5 issued at a cost of 120 is
 *     the STRING '600.00', never a JS float product (599.9999999999999).
 *   - THE HISTORY IS NEWEST FIRST (by `seq desc`) and COMPLETE — reason, both
 *     location NAMES, the ACTOR'S NAME and the time, with no raw uuid.
 *   - THE LIST IS SEARCHABLE by name or by SKU, and BOUNDED.
 *   - SCOPING IS SERVER-SIDE: a branch user sees only their own branch's stock
 *     and is refused a variant their branch does not hold.
 *
 * Tenants are provisioned over the OWNER connection (`migrateUrl()`); everything
 * the app does runs as the non-superuser `authenticated` role.
 */

type Provisioned = {
  tenant: string;
  /** `warehouse_manager`. */
  wm: string;
  /** `branch_user` assigned to branch one. */
  bu1: string;
  /** `branch_user` assigned to branch two. */
  bu2: string;
  whName: string;
  br1Name: string;
  itemAName: string;
  itemBName: string;
  variantA: string;
  variantB: string;
  skuA: string;
  skuB: string;
};

const provisioned: string[] = [];

async function provision(): Promise<Provisioned> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  let tenant: string;
  const ids: Record<string, string> = {};
  try {
    const {
      rows: [t],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Stock T15') returning id");
    tenant = t!.id;

    // Locations: a warehouse and two branches. The transit pseudo-location is
    // irrelevant here (nothing is in transit in these movements).
    const {
      rows: [wh],
    } = await owner.query<{ id: string }>(
      `insert into locations (tenant_id, code, name_ar, type) values ($1, 'WH-T15', 'المخزن الرئيسي T15', 'warehouse') returning id`,
      [tenant],
    );
    const {
      rows: [br1],
    } = await owner.query<{ id: string }>(
      `insert into locations (tenant_id, code, name_ar, type) values ($1, 'BR-T15A', 'فرع أ T15', 'branch') returning id`,
      [tenant],
    );
    const {
      rows: [br2],
    } = await owner.query<{ id: string }>(
      `insert into locations (tenant_id, code, name_ar, type) values ($1, 'BR-T15B', 'فرع ب T15', 'branch') returning id`,
      [tenant],
    );
    ids.wh = wh!.id;
    ids.br1 = br1!.id;
    ids.br2 = br2!.id;

    // Users: one warehouse manager, two branch users (each assigned a branch).
    const users: Array<[string, string, string, string, string | null]> = [
      ['wm', 'Mona Manager T15', 'wm_t15', 'warehouse_manager', null],
      ['bu1', 'Branch One T15', 'bu1_t15', 'branch_user', br1!.id],
      ['bu2', 'Branch Two T15', 'bu2_t15', 'branch_user', br2!.id],
    ];
    for (const [key, name, username, role, branch] of users) {
      const {
        rows: [u],
      } = await owner.query<{ id: string }>(
        `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash, branch_location_id)
         values ($1, $2, public.normalise_name($2), $3, $4, 'x', $5) returning id`,
        [tenant, name, username, role, branch],
      );
      ids[key] = u!.id;
    }

    provisioned.push(tenant);
  } finally {
    await owner.end();
  }

  return {
    tenant,
    wm: ids.wm!,
    bu1: ids.bu1!,
    bu2: ids.bu2!,
    whName: 'المخزن الرئيسي T15',
    br1Name: 'فرع أ T15',
    itemAName: 'قميص قطني T15',
    itemBName: 'قبعة T15',
    variantA: '',
    variantB: '',
    skuA: 'T15-0301',
    skuB: 'T15-0302',
  };
}

// Cleanup: `stock_movements` is append-only, so it is cleared with
// `session_replication_role = replica` on the owner connection (never the app).
after(async () => {
  if (provisioned.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('set session_replication_role = replica');
    await owner.query('delete from requisition_lines where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from requisitions where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from stock_movements where tenant_id = any($1)', [provisioned]);
    await owner.query('set session_replication_role = origin');
    await owner.query('delete from location_levels where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from item_variants where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from items where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from sessions where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from app_users where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from locations where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from tenants where id = any($1)', [provisioned]);
  } finally {
    await owner.end();
  }
});

type AnyDb = Parameters<typeof createLocation>[0];

/**
 * Seeds the movements the assertions are written against, inside the caller's
 * tenant scope, and returns the variant ids.
 *
 * Balances: A@WH = 5, A@BR-01 = 3, B@WH = 0 (a real zero row the list must omit).
 */
async function seed(db: AnyDb, p: Provisioned): Promise<{ variantA: string; variantB: string }> {
  const a = await createItem(db, {
    nameAr: p.itemAName,
    nameEn: 'Cotton shirt',
    family: 'sellable',
    costEgp: 120,
    sku: p.skuA,
    barcode: p.skuA,
  });
  const b = await createItem(db, {
    nameAr: p.itemBName,
    family: 'sellable',
    costEgp: 0,
    sku: p.skuB,
    barcode: p.skuB,
  });

  // C: a cost chosen so a JS float product would NOT equal the exact decimal —
  // 3 x 0.07 is 0.21 exactly, but `3 * 0.07` in JavaScript is 0.21000000000000002.
  // The exact-string assertion on its value is what proves the money is computed
  // in the database.
  const c = await createItem(db, {
    nameAr: 'شريط T15',
    family: 'sellable',
    costEgp: 12,
    sku: 'T15-0303',
    barcode: 'T15-0303',
  });
  // `createItem` writes `coalesce($cost, 0)`, and the integer literal `0` makes
  // Postgres infer an INTEGER parameter, so a fractional cost cannot be passed
  // through it — set the decimal cost directly, exactly as the column allows.
  await db.query('update items set cost_egp = 0.07 where id = $1', [c.item.id]);

  const { rows: locs } = await db.query<{ id: string; code: string }>(
    `select id, code from locations where code in ('WH-T15', 'BR-T15A')`,
  );
  const wh = locs.find((l) => l.code === 'WH-T15')!.id;
  const br1 = locs.find((l) => l.code === 'BR-T15A')!.id;

  // A: opening balance +10 at the warehouse, then 5 issued to branch one, then
  // 2 consumed at the branch. Warehouse holds 5, branch one holds 3.
  await postMovement(db, {
    variantId: a.variant.id,
    qty: 10,
    reason: 'opening_balance',
    toLocationId: wh,
    actorUserId: p.wm,
  });
  await postMovement(db, {
    variantId: a.variant.id,
    qty: 5,
    reason: 'issue_to_branch',
    fromLocationId: wh,
    toLocationId: br1,
    actorUserId: p.wm,
  });
  await postMovement(db, {
    variantId: a.variant.id,
    qty: 2,
    reason: 'consumption',
    fromLocationId: br1,
    actorUserId: p.bu1,
  });

  // B: a receipt and a write-off that net to ZERO at the warehouse — a real
  // zero row the on-hand list must omit.
  await postMovement(db, {
    variantId: b.variant.id,
    qty: 1,
    reason: 'opening_balance',
    toLocationId: wh,
    actorUserId: p.wm,
  });
  await postMovement(db, {
    variantId: b.variant.id,
    qty: 1,
    reason: 'write_off',
    fromLocationId: wh,
    actorUserId: p.wm,
  });

  // C: an opening balance of 10 at the warehouse, then 3 issued to branch one.
  await postMovement(db, {
    variantId: c.variant.id,
    qty: 10,
    reason: 'opening_balance',
    toLocationId: wh,
    actorUserId: p.wm,
  });
  await postMovement(db, {
    variantId: c.variant.id,
    qty: 3,
    reason: 'issue_to_branch',
    fromLocationId: wh,
    toLocationId: br1,
    actorUserId: p.wm,
  });

  return { variantA: a.variant.id, variantB: b.variant.id };
}

type Seeded = Provisioned & { variantA: string; variantB: string };

/** Provision + seed once, inside one `withDb`, and reuse the ids. */
let cached: Promise<Seeded> | undefined;
async function seeded(): Promise<Seeded> {
  cached ??= (async () => {
    const p = await provision();
    await withDb(async (db) => {
      const v = await withTenant(db, p.tenant, (tdb) => seed(tdb, p));
      p.variantA = v.variantA;
      p.variantB = v.variantB;
    });
    return p as Seeded;
  })();
  return cached;
}

test(
  'on-hand by location lists only non-zero rows',
  { skip: !sqlTestUrl() },
  async () => {
    const p = await seeded();
    await withDb(async (db) => {
      const rows = await withTenant(db, p.tenant, (tdb) => onHandByLocation(tdb, {}));

      // Only non-zero balances: the B@warehouse pair nets to zero and is absent.
      assert.ok(rows.length > 0, 'the seed must produce on-hand rows');
      for (const row of rows) {
        assert.notEqual(Number(row.qty), 0, `a zero row leaked into the list: ${JSON.stringify(row)}`);
      }

      // Every joined field is NON-EMPTY (the bug a `rows.length > 0` check misses).
      for (const row of rows) {
        assert.ok(row.nameAr && row.nameAr.length > 0, `nameAr is empty: ${JSON.stringify(row)}`);
        assert.ok(row.sku && row.sku.length > 0, `sku is empty: ${JSON.stringify(row)}`);
        assert.ok(row.location && row.location.length > 0, `location is empty: ${JSON.stringify(row)}`);
      }

      const aWh = rows.find((r) => r.sku === p.skuA && r.location === p.whName);
      assert.ok(aWh, 'the warehouse balance for item A must be listed');
      assert.equal(aWh!.qty, '5.000', 'A@warehouse is 10 in, 5 issued out = 5');

      const aBr = rows.find((r) => r.sku === p.skuA && r.location === p.br1Name);
      assert.ok(aBr, 'the branch balance for item A must be listed');
      assert.equal(aBr!.qty, '3.000', 'A@branch is 5 in, 2 consumed = 3');
      assert.equal(aBr!.nameAr, p.itemAName, 'the Arabic NAME must be joined, not dropped');

      // No row for item B anywhere (it nets to zero at the warehouse).
      assert.equal(rows.find((r) => r.sku === p.skuB), undefined, 'a zero-balance item must not be listed');
    });
  },
);

test(
  'usage per branch sums issues in the window and multiplies by cost',
  { skip: !sqlTestUrl() },
  async () => {
    const p = await seeded();
    await withDb(async (db) => {
      const now = Date.now();
      const from = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const to = new Date(now + 24 * 60 * 60 * 1000).toISOString();

      const rows = await withTenant(db, p.tenant, (tdb) => usageByBranch(tdb, { from, to }));
      const row = rows.find((r) => r.sku === p.skuA);
      assert.ok(row, 'the issue to branch one must appear in the usage window');

      // 5 issued at a cost of 120 -> EXACTLY '600.00', computed in SQL. A JS
      // `qty * cost` would produce 599.9999999999999 and this assertion is what
      // catches it.
      assert.equal(row!.valueEgp, '600.00', 'the value is 5 x 120, computed in the database');
      assert.equal(row!.issuedQty, '5.000', 'the issued quantity is the sum of the issue movements');
      assert.equal(row!.branch, p.br1Name, 'the branch is the DESTINATION, by its Arabic name');
      assert.ok(row!.branch.length > 0 && row!.sku.length > 0);

      // THE FLOAT TRAP: 3 issued at a cost of 0.07 is 0.21 exactly. A JS
      // `3 * 0.07` is 0.21000000000000002 — so this exact-string assertion fails
      // the moment the multiplication leaves the database.
      const rowC = rows.find((r) => r.sku === 'T15-0303');
      assert.ok(rowC, 'the second issue must appear too');
      assert.equal(rowC!.valueEgp, '0.21', 'the value is 3 x 0.07, computed exactly in the database');
      assert.equal(rowC!.issuedQty, '3.000');

      // A window in the past holds nothing.
      const past = await withTenant(db, p.tenant, (tdb) =>
        usageByBranch(tdb, { from: '2000-01-01T00:00:00Z', to: '2000-01-02T00:00:00Z' }),
      );
      assert.equal(past.length, 0, 'a window with no issues is empty');
    });
  },
);

test(
  'the movement history of a variant is newest first and complete',
  { skip: !sqlTestUrl() },
  async () => {
    const p = await seeded();
    await withDb(async (db) => {
      const rows = await withTenant(db, p.tenant, (tdb) => movementHistoryDetailed(tdb, p.variantA));

      assert.equal(rows.length, 3, 'item A has three movements (opening, issue, consumption)');

      // NEWEST FIRST, by the monotonic `seq`, deterministically.
      const seqs = rows.map((r) => BigInt(r.seq));
      for (let i = 1; i < seqs.length; i += 1) {
        assert.ok(seqs[i - 1]! > seqs[i]!, `history is not newest-first: ${rows.map((r) => r.seq).join(',')}`);
      }

      // COMPLETE: reason, the actor's NAME, the locations' NAMES, the time.
      for (const row of rows) {
        assert.ok((MOVEMENT_REASONS as readonly string[]).includes(row.reason), `unknown reason ${row.reason}`);
        assert.ok(row.actorName && row.actorName.length > 0, `the actor must be a NAME, not blank: ${JSON.stringify(row)}`);
        assert.doesNotMatch(row.actorName!, /^[0-9a-f-]{36}$/, 'the actor must not be a raw uuid');
        assert.ok(!Number.isNaN(new Date(row.occurredAt).getTime()), 'occurredAt must be a real time');
      }

      // The issue to the branch: from the warehouse, to the branch, by the
      // manager — the literal "where did it go, who took it" answer.
      const issue = rows.find((r) => r.reason === 'issue_to_branch');
      assert.ok(issue, 'the issue movement must be in the history');
      assert.equal(issue!.fromLocation, p.whName, 'the source is named by its Arabic name');
      assert.equal(issue!.toLocation, p.br1Name, 'the destination is named by its Arabic name');
      assert.equal(issue!.actorName, 'Mona Manager T15', "the ACTOR is shown by their display NAME");
      assert.equal(issue!.qty, '5.000');

      // The consumption was posted by the branch user — a DIFFERENT actor.
      const consumption = rows.find((r) => r.reason === 'consumption');
      assert.equal(consumption!.actorName, 'Branch One T15');
      assert.equal(consumption!.fromLocation, p.br1Name);
      assert.equal(consumption!.toLocation, null, 'a one-sided movement has a null side');

      // BOUNDED: asking for fewer rows returns the newest N, still newest-first.
      const newestTwo = await withTenant(db, p.tenant, (tdb) =>
        movementHistoryDetailed(tdb, p.variantA, 2),
      );
      assert.equal(newestTwo.length, 2, 'the history honours its bound');
      assert.deepEqual(
        newestTwo.map((r) => r.seq),
        rows.slice(0, 2).map((r) => r.seq),
        'the bounded read returns the NEWEST rows',
      );
      assert.ok(MOVEMENT_HISTORY_LIMIT >= 2);
    });
  },
);

test(
  'the stock list is searchable by name or by SKU',
  { skip: !sqlTestUrl() },
  async () => {
    const p = await seeded();
    await withDb(async (db) => {
      const bySku = await withTenant(db, p.tenant, (tdb) => onHandByLocation(tdb, { search: p.skuA }));
      assert.ok(bySku.length > 0, 'searching by SKU finds the item');
      assert.ok(bySku.every((r) => r.sku === p.skuA), 'a SKU search returns only that SKU');
      assert.equal(bySku.find((r) => r.sku === p.skuB), undefined);

      const byName = await withTenant(db, p.tenant, (tdb) => onHandByLocation(tdb, { search: 'قميص' }));
      assert.ok(byName.length > 0, 'searching by the Arabic name finds the item');
      assert.ok(byName.every((r) => r.sku === p.skuA), 'a name search returns only the matching item');
    });
  },
);

test(
  'the branch user sees only their own branch, and is refused what they do not hold',
  { skip: !sqlTestUrl() },
  async () => {
    const p = await seeded();
    await withDb(async (db) => {
      const { wm, bu1, bu2 } = await withTenant(db, p.tenant, async (tdb) => ({
        wm: (await createSession(tdb, { userId: p.wm })).token,
        bu1: (await createSession(tdb, { userId: p.bu1 })).token,
        bu2: (await createSession(tdb, { userId: p.bu2 })).token,
      }));

      await withTenant(db, p.tenant, async (tdb) => {
        // The warehouse sees the network.
        const net = await listStock(tdb, wm);
        assert.equal(net.maySee, true);
        assert.equal(net.scope, 'network');
        assert.ok(net.rows.some((r) => r.location === p.whName), 'the warehouse sees warehouse stock');
        assert.ok(net.rows.some((r) => r.location === p.br1Name), 'the warehouse sees branch stock');

        // A branch user sees ONLY their own branch — enforced in the query.
        const br = await listStock(tdb, bu1);
        assert.equal(br.scope, 'branch');
        assert.ok(br.rows.length > 0, 'branch one holds stock');
        assert.ok(br.rows.every((r) => r.location === p.br1Name), 'a branch user sees no other location');
        assert.equal(br.rows.find((r) => r.location === p.whName), undefined, 'no warehouse rows for a branch user');

        // The detail is scoped too: branch one may open an item it holds...
        const held = await getVariantHistory(tdb, bu1, p.variantA);
        assert.equal(held.ok, true);
        if (held.ok) {
          assert.ok(held.onHand.every((r) => r.location === p.br1Name));
          assert.equal(held.nameAr, p.itemAName, 'the detail carries the Arabic name');
        }

        // ...but branch TWO holds nothing, so the SAME answer as a missing id.
        const notHeld = await getVariantHistory(tdb, bu2, p.variantA);
        assert.deepEqual(notHeld, { ok: false, error: 'invalid' }, 'a branch is refused stock it does not hold');

        // And a garbage cookie is simply not signed in — never a throw.
        const anon = await listStock(tdb, 'not-a-real-token');
        assert.equal(anon.user, null);
        assert.equal(anon.maySee, false);
        assert.equal(anon.rows.length, 0);
      });
    });
  },
);

test('every movement reason has an Arabic and English label', () => {
  // The reason list is a closed, TRANSLATED contract: a reason added to the
  // database list with no label must fail HERE rather than render its raw enum
  // value on a screen.
  assert.deepEqual(
    Object.keys(REASON_MESSAGE_KEYS).sort(),
    [...MOVEMENT_REASONS].sort(),
    'the label map must cover exactly the closed reason list',
  );
  for (const reason of MOVEMENT_REASONS) {
    const key = REASON_MESSAGE_KEYS[reason];
    assert.equal(typeof key, 'string', `reason ${reason} has no label key`);
    assert.notEqual(key, reason, `reason ${reason} must be translated, not shown raw`);
    assert.ok(hasKey(key, 'ar'), `reason ${reason} has no Arabic label (${key})`);
    assert.ok(hasKey(key, 'en'), `reason ${reason} has no English label (${key})`);
  }
});

// ITEM 3: a malformed variant id in the URL (`/stock/not-a-uuid`) must be a
// gracefUL refusal — the SAME code a missing id gets — not a 500. Before this,
// the id reached `where v.id = $1` uncast and Postgres rejected the text with
// `invalid input syntax for type uuid` (SQLSTATE 22P02), surfacing as Next's
// "This page couldn't load".
test('a malformed variant id is refused, not a 500', { skip: !sqlTestUrl() }, async () => {
  const p = await seeded();
  await withDb(async (db) => {
    // A live session, so the ONLY reason the read is refused is the id's SHAPE
    // (a garbage cookie would refuse as `unauthenticated`, which is not the bug).
    const token = await withTenant(db, p.tenant, async (tdb) => (await createSession(tdb, { userId: p.wm })).token);

    await withTenant(db, p.tenant, async (tdb) => {
      const malformed = await getVariantHistory(tdb, token, 'not-a-uuid');
      assert.deepEqual(malformed, { ok: false, error: 'invalid' }, 'a malformed id must be a refusal, not a throw');

      // A well-formed but unknown id is refused the SAME way (no oracle).
      const unknown = await getVariantHistory(tdb, token, '00000000-0000-0000-0000-000000000000');
      assert.deepEqual(unknown, { ok: false, error: 'invalid' });

      // A genuinely malformed id CANNOT reach the database: prove the raw query
      // is exactly what used to 500 the page, so the guard (not luck) protects it.
      await assert.rejects(
        () => tdb.query('select id from item_variants where id = $1', ['not-a-uuid']),
        /invalid input syntax for type uuid/,
        'the raw query is what used to 500 the page — the shape guard is what prevents it',
      );
    });
  });
});

// ITEM 4: THE ACCOUNTS VIEW. `getUsageReport` is the whole-network money read.
//  - the TOTAL is exact in SQL (a JS float sum would differ),
//  - the window actually filters,
//  - a branch_user is refused SERVER-SIDE, and
//  - an empty window renders honestly (rows empty, total a real '0.00').
test('the accounts view sums value in SQL, filters by window, and refuses a branch user', { skip: !sqlTestUrl() }, async () => {
  const p = await seeded();

  // Two issues in a FIXED past window (2026-01), so the "now"-dated seed
  // movements are excluded by the window filter — which is what proves the
  // filter filters. Costs 0.10 and 0.20 are chosen so a JS float sum
  // (0.1 + 0.2 = 0.30000000000000004) differs from the exact '0.30'.
  const WINDOW = { from: '2026-01-01', to: '2026-02-01' };
  await withDb(async (db) => {
    await withTenant(db, p.tenant, async (tdb) => {
      const { rows: locs } = await tdb.query<{ id: string; code: string }>(
        "select id, code from locations where code in ('WH-T15', 'BR-T15A', 'BR-T15B')",
      );
      const wh = locs.find((l) => l.code === 'WH-T15')!.id;
      const brA = locs.find((l) => l.code === 'BR-T15A')!.id;
      const brB = locs.find((l) => l.code === 'BR-T15B')!.id;

      // Fractional costs through createItem — the ITEM 2 fix in the same suite.
      const a = await createItem(tdb, { nameAr: 'صنف عشرة', family: 'sellable', costEgp: 0.1, sku: 'T15-0410', barcode: 'T15-0410' });
      const b = await createItem(tdb, { nameAr: 'صنف عشرين', family: 'sellable', costEgp: 0.2, sku: 'T15-0420', barcode: 'T15-0420' });
      assert.equal(a.item.cost_egp, '0.10', 'a 0.10 cost is stored exactly');
      assert.equal(b.item.cost_egp, '0.20', 'a 0.20 cost is stored exactly');

      await postMovement(tdb, {
        variantId: a.variant.id, qty: 1, reason: 'issue_to_branch',
        fromLocationId: wh, toLocationId: brA, actorUserId: p.wm, occurredAt: '2026-01-10T10:00:00Z',
      });
      await postMovement(tdb, {
        variantId: b.variant.id, qty: 1, reason: 'issue_to_branch',
        fromLocationId: wh, toLocationId: brB, actorUserId: p.wm, occurredAt: '2026-01-20T10:00:00Z',
      });
    });

    const tokens = await withTenant(db, p.tenant, async (tdb) => ({
      wm: (await createSession(tdb, { userId: p.wm })).token,
      bu1: (await createSession(tdb, { userId: p.bu1 })).token,
    }));

    await withTenant(db, p.tenant, async (tdb) => {
      // The warehouse manager may read it.
      const report = await getUsageReport(tdb, tokens.wm, WINDOW);
      assert.equal(report.ok, true, 'the warehouse manager may read the accounts view');
      if (!report.ok) return;

      // THE TOTAL IS EXACT IN SQL: '0.30', never the JS float 0.30000000000000004.
      assert.equal(report.totalEgp, '0.30', 'the total is the database sum, exactly');
      const jsFloatSum = report.rows.reduce((s, r) => s + Number(r.valueEgp), 0);
      assert.notEqual(
        String(jsFloatSum),
        report.totalEgp,
        'a JS float sum of the rows differs from the SQL total — so this test fails if the total leaves the database',
      );
      // The rows name WHAT and WHERE and carry exact strings.
      assert.equal(report.rows.length, 2, 'two issues in the window are two rows');
      for (const row of report.rows) {
        assert.ok(row.branch.length > 0, 'the branch is named');
        assert.ok(row.nameAr.length > 0, 'the item is named');
        assert.ok(row.sku.length > 0, 'the SKU is carried');
      }

      // The same SQL total read directly agrees (one rule, no drift).
      const direct = await usageTotalEgp(tdb, WINDOW);
      assert.equal(direct, '0.30', 'usageTotalEgp agrees with the handler total');

      // THE WINDOW FILTERS: a different window holds none of these issues, and
      // the total is a real '0.00' — not a blank.
      const past = await getUsageReport(tdb, tokens.wm, { from: '2000-01-01', to: '2000-02-01' });
      assert.equal(past.ok, true);
      if (past.ok) {
        assert.equal(past.rows.length, 0, 'a window with no issues is empty');
        assert.equal(past.totalEgp, '0.00', 'an empty window sums to a real 0.00');
      }

      // The window the form offers by default is THIS MONTH, stated, not guessed.
      const w = monthWindow(new Date(Date.UTC(2026, 9, 28)));
      assert.deepEqual(w, { from: '2026-10-01', to: '2026-11-01' }, 'the default window is this month');

      // A BRANCH USER IS REFUSED SERVER-SIDE — whole-network money is not a
      // branch-level fact.
      const denied = await getUsageReport(tdb, tokens.bu1, WINDOW);
      assert.deepEqual(denied, { ok: false, error: 'forbidden' }, 'a branch user is refused the network money view');
      // ...and an anonymous request too.
      const anon = await getUsageReport(tdb, 'not-a-real-token', WINDOW);
      assert.deepEqual(anon, { ok: false, error: 'unauthenticated' });

      // A malformed window is refused, and the default is applied when omitted.
      const bad = await getUsageReport(tdb, tokens.wm, { from: 'not-a-date', to: 'also-bad' });
      assert.deepEqual(bad, { ok: false, error: 'invalid' });
      const defaulted = await getUsageReport(tdb, tokens.wm, {});
      assert.equal(defaulted.ok, true);
      if (defaulted.ok) {
        assert.equal(defaulted.from, monthWindow().from, 'an omitted window defaults to this month');
        assert.equal(defaulted.to, monthWindow().to);
      }
    });
  });
});

// MONEY CORRECTNESS — GOODS IN TRANSIT MUST BE COUNTED EXACTLY ONCE.
//
// Goods reach a branch in TWO ledger legs, BOTH with reason `issue_to_branch`:
// the issue leg (warehouse -> TRANSIT) and the branch's confirm (TRANSIT ->
// branch). A reader that grouped by DESTINATION attributed the SAME units to a
// `transit` row AND to the branch row, so the report's money total was inflated
// by everything in flight (and a `transit` pseudo-branch appeared on screen).
//
// This runs a REAL cold cycle in a FRESH tenant — issue 10, check the mid-flight
// moment, confirm 6 (partial), then the remaining 4 — and asserts the report
// counts each arrived unit ONCE. A fresh tenant means the only `issue_to_branch`
// movements in the window are this test's own, so the total is reconcilable by
// hand (the demo tenant's bumpy pre-fix movements cannot confuse it).
test('goods in transit are counted once — mid-flight, partial and full arrival', { skip: !sqlTestUrl() }, async () => {
  // Fresh tenant + its own warehouse, branch and operator.
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  let tenant: string;
  const loc: Record<string, string> = {};
  try {
    const {
      rows: [t],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Usage transit T15') returning id");
    tenant = t!.id;
    const {
      rows: [wh],
    } = await owner.query<{ id: string }>(
      `insert into locations (tenant_id, code, name_ar, type) values ($1, 'WH-UT', 'مخزن UT', 'warehouse') returning id`,
      [tenant],
    );
    const {
      rows: [br],
    } = await owner.query<{ id: string }>(
      `insert into locations (tenant_id, code, name_ar, type) values ($1, 'BR-UT', 'فرع UT', 'branch') returning id`,
      [tenant],
    );
    const {
      rows: [u],
    } = await owner.query<{ id: string }>(
      `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash)
       values ($1, 'UT Operator', public.normalise_name('UT Operator'), 'ut_operator', 'warehouse_manager', 'x') returning id`,
      [tenant],
    );
    loc.wh = wh!.id;
    loc.br = br!.id;
    loc.wm = u!.id;
    provisioned.push(tenant);
  } finally {
    await owner.end();
  }

  const win = {
    from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  await withDb(async (db) => {
    const ctx = await withTenant(db, tenant, async (tdb) => {
      const item = await createItem(tdb, {
        nameAr: 'صنف UT',
        family: 'sellable',
        costEgp: 10,
        sku: 'UT-1',
        barcode: 'UT-1',
      });
      return { variantId: item.variant.id };
    });

    const req = await withTenant(db, tenant, (tdb) =>
      createRequisition(tdb, {
        branchLocationId: loc.br!,
        requestedBy: loc.wm!,
        lines: [{ variantId: ctx.variantId, requestedQty: 10 }],
      }),
    );
    await withTenant(db, tenant, (tdb) => approve(tdb, req.id, loc.wm!));

    // ISSUE 10 — warehouse -> transit. Nothing has ARRIVED yet.
    await withTenant(db, tenant, (tdb) =>
      issue(tdb, req.id, loc.wm!, [{ variantId: ctx.variantId, qty: 10 }]),
    );

    await withTenant(db, tenant, async (tdb) => {
      const rows = await usageByBranch(tdb, win);
      assert.equal(
        rows.length,
        0,
        'MID-FLIGHT: nothing has arrived at a branch — no transit row and no branch row',
      );
      assert.equal(
        await usageTotalEgp(tdb, win),
        '0.00',
        'MID-FLIGHT: goods still in transit are NOT the branch value (the bug reported 100.00)',
      );
    });

    // CONFIRM 6 — transit -> branch. A PARTIAL arrival counts 6, not 10 and not 16.
    await withTenant(db, tenant, (tdb) =>
      confirmReceipt(tdb, req.id, loc.wm!, [{ variantId: ctx.variantId, qty: 6 }]),
    );
    await withTenant(db, tenant, async (tdb) => {
      const rows = await usageByBranch(tdb, win);
      assert.equal(rows.length, 1, 'PARTIAL: exactly ONE row — the transit leg is not a second row');
      assert.equal(rows[0]!.branch, 'فرع UT', 'the row is the BRANCH, never a transit pseudo-branch');
      assert.equal(rows[0]!.issuedQty, '6.000', 'PARTIAL: only the 6 that arrived are counted');
      assert.equal(rows[0]!.valueEgp, '60.00', 'PARTIAL: 6 x 10, counted once');
      assert.equal(await usageTotalEgp(tdb, win), '60.00', 'PARTIAL: the total agrees with the rows');
    });

    // CONFIRM the remaining 4 — the full 10 has now arrived.
    await withTenant(db, tenant, (tdb) =>
      confirmReceipt(tdb, req.id, loc.wm!, [{ variantId: ctx.variantId, qty: 4 }]),
    );
    await withTenant(db, tenant, async (tdb) => {
      const rows = await usageByBranch(tdb, win);
      assert.equal(rows.length, 1, 'ARRIVED: still ONE row');
      assert.equal(rows[0]!.issuedQty, '10.000', 'ARRIVED: all 10 counted ONCE, not 20');
      assert.equal(rows[0]!.valueEgp, '100.00', 'ARRIVED: 10 x 10, counted once');

      const total = await usageTotalEgp(tdb, win);
      assert.equal(total, '100.00', 'ARRIVED: the total counts the 10 once (the bug reported 160.00)');

      // The item-level rows AGREE with the total: the screen's figure is the sum
      // of what it lists (1 x 10 at cost 10), reconcilable by hand.
      assert.equal(rows.length, 1);
      // Compared in whole piasters (BigInt of the digits) — never a JS float sum of
      // money strings, which is exactly the bug this report exists to avoid.
      const cents = (s: string): bigint => BigInt(s.replace('.', ''));
      assert.equal(rows.reduce((s, r) => s + cents(r.valueEgp), 0n), cents(total));
    });
  });
});
