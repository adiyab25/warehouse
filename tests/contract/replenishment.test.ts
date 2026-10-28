import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { createSession } from '../../src/auth/session.ts';
import { withTenant } from '../../src/db/client.ts';
import { createItem, setLocationLevel } from '../../src/db/items.ts';
import { postMovement } from '../../src/db/movements.ts';
import { approve, confirmReceipt, createRequisition, issue } from '../../src/db/requisitions.ts';
import { belowMinimum, consumptionRate } from '../../src/db/replenishment.ts';
import { REPORT_REFUSAL_MESSAGE_KEYS, getReplenishmentReport } from '../../src/app/reports/handler.ts';
import { hasKey } from '../../src/i18n/index.ts';
import { migrateUrl, sqlTestUrl, withDb } from '../harness/sql.ts';

/**
 * Contract tests for the below-minimum report and the consumption rate (Task 16).
 * A fresh tenant makes every figure hand-reconcilable.
 *
 * Layout (B1 = branch one, B2 = branch two, WH = warehouse):
 *   AT  min 5 @B1, on hand 5            -> listed (AT the minimum)
 *   AB  min 5 @B1, on hand 6            -> NOT listed
 *   NV  min 4 @B1, NEVER any movement   -> listed with onHand '0.000'
 *   NM  level with NULL min @B1         -> NOT listed
 *   IN  min 5 @B1, item INACTIVE        -> NOT listed
 *   RD  min 5 @B1, 31 in, 30 consumed   -> on hand 1, rate 1/day over 30d, cover 1.0
 *   RC  min 5 @B1, 6 in, 4 consumed     -> on hand 2, cover 15.0
 *   X2  min 3 @B2, on hand 1            -> listed for the owner, never for B1's user
 *   T   stock at WH, used for the two-leg transit cycle
 */

const SKU = (n: number) => `T16-${String(n).padStart(4, '0')}`;
const provisioned: string[] = [];
const ids: Record<string, string> = {};
let tenant = '';
let tokens: Record<string, string> = {};
let setup: Promise<void> | undefined;

after(async () => {
  if (provisioned.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('set session_replication_role = replica');
    for (const tbl of ['requisition_lines', 'requisitions', 'stock_movements']) {
      await owner.query(`delete from ${tbl} where tenant_id = any($1)`, [provisioned]);
    }
    await owner.query('set session_replication_role = origin');
    for (const tbl of ['location_levels', 'item_variants', 'items', 'sessions', 'app_users', 'locations']) {
      await owner.query(`delete from ${tbl} where tenant_id = any($1)`, [provisioned]);
    }
    await owner.query('delete from tenants where id = any($1)', [provisioned]);
  } finally {
    await owner.end();
  }
});

async function ready(): Promise<void> {
  setup ??= (async () => {
    const owner = new Client({ connectionString: migrateUrl()! });
    await owner.connect();
    try {
      const {
        rows: [t],
      } = await owner.query<{ id: string }>("insert into tenants (name) values ('Replen T16') returning id");
      tenant = t!.id;
      provisioned.push(tenant);
      const loc = async (code: string, name: string, type: string) =>
        (
          await owner.query<{ id: string }>(
            'insert into locations (tenant_id, code, name_ar, type) values ($1, $2, $3, $4) returning id',
            [tenant, code, name, type],
          )
        ).rows[0]!.id;
      ids.wh = await loc('WH-T16', 'المخزن الرئيسي T16', 'warehouse');
      ids.b1 = await loc('BR-T16A', 'فرع أ T16', 'branch');
      ids.b2 = await loc('BR-T16B', 'فرع ب T16', 'branch');
      const user = async (key: string, username: string, role: string, branch: string | null) => {
        ids[key] = (
          await owner.query<{ id: string }>(
            `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash, branch_location_id)
             values ($1, $2, public.normalise_name($2), $3, $4, 'x', $5) returning id`,
            [tenant, `User ${username}`, username, role, branch],
          )
        ).rows[0]!.id;
      };
      await user('own', 'own_t16', 'owner', null);
      await user('bu1', 'bu1_t16', 'branch_user', ids.b1!);
      await user('bu2', 'bu2_t16', 'branch_user', ids.b2!);
      await user('bux', 'bux_t16', 'branch_user', null);
    } finally {
      await owner.end();
    }

    await withDb(async (db) => {
      await withTenant(db, tenant, async (tdb) => {
        const mk = async (n: number, name: string) =>
          createItem(tdb, { nameAr: name, family: 'sellable', costEgp: 1, sku: SKU(n), barcode: SKU(n) });
        const items: Record<string, Awaited<ReturnType<typeof mk>>> = {};
        items.AT = await mk(1, 'صنف عند الحد');
        items.AB = await mk(2, 'صنف فوق الحد');
        items.NV = await mk(3, 'صنف لم يدخل المخزن');
        items.NM = await mk(4, 'صنف بلا حد أدنى');
        items.IN = await mk(5, 'صنف متوقف');
        items.RD = await mk(6, 'صنف سريع الصرف');
        items.RC = await mk(7, 'صنف بطيء الصرف');
        items.X2 = await mk(8, 'صنف الفرع الثاني');
        items.T = await mk(9, 'صنف العبور');
        for (const [k, v] of Object.entries(items)) {
          ids[`item${k}`] = v.item.id;
          ids[`var${k}`] = v.variant.id;
        }

        const lvl = (k: string, loc: string, minQty?: number) =>
          setLocationLevel(tdb, { itemId: ids[`item${k}`]!, locationId: loc, minQty, maxQty: 100 });
        await lvl('AT', ids.b1!, 5);
        await lvl('AB', ids.b1!, 5);
        await lvl('NV', ids.b1!, 4);
        await lvl('NM', ids.b1!, undefined);
        await lvl('IN', ids.b1!, 5);
        await lvl('RD', ids.b1!, 5);
        await lvl('RC', ids.b1!, 5);
        await lvl('X2', ids.b2!, 3);

        const receive = (k: string, qty: number, at: string) =>
          postMovement(tdb, {
            variantId: ids[`var${k}`]!,
            qty,
            reason: 'opening_balance',
            toLocationId: at,
            actorUserId: ids.own!,
          });
        const consume = (k: string, qty: number, at: string) =>
          postMovement(tdb, {
            variantId: ids[`var${k}`]!,
            qty,
            reason: 'consumption',
            fromLocationId: at,
            actorUserId: ids.own!,
          });
        await receive('AT', 5, ids.b1!);
        await receive('AB', 6, ids.b1!);
        await receive('IN', 1, ids.b1!);
        await receive('RD', 31, ids.b1!);
        await consume('RD', 30, ids.b1!);
        await receive('RC', 6, ids.b1!);
        await consume('RC', 4, ids.b1!);
        await receive('X2', 1, ids.b2!);
        await receive('T', 20, ids.wh!);
        // Retired AFTER it was stocked: its (real) shortfall must raise no alert.
        await tdb.query('update items set active = false where id = $1', [items.IN!.item.id]);
      });
      tokens = await withTenant(db, tenant, async (tdb) => ({
        own: (await createSession(tdb, { userId: ids.own! })).token,
        bu1: (await createSession(tdb, { userId: ids.bu1! })).token,
        bu2: (await createSession(tdb, { userId: ids.bu2! })).token,
        bux: (await createSession(tdb, { userId: ids.bux! })).token,
      }));
    });
  })();
  return setup;
}

const opts = { skip: !sqlTestUrl() };

test('an item at or below its minimum for a location is listed', opts, async () => {
  await ready();
  await withDb(async (db) => {
    const rows = await withTenant(db, tenant, (tdb) => belowMinimum(tdb, { days: 30 }));
    const at = rows.find((r) => r.itemId === ids.itemAT);
    assert.ok(at, 'the item exactly AT its minimum (5 of 5) must be listed');
    assert.equal(at!.onHand, '5.000');
    assert.equal(at!.minQty, '5.000');
    const rd = rows.find((r) => r.itemId === ids.itemRD);
    assert.equal(rd!.onHand, '1.000', 'below the minimum is listed');
    assert.ok(rows.length >= 4);
    // Every returned field is NON-EMPTY (not just rows.length > 0).
    for (const r of rows) {
      for (const f of ['itemId', 'nameAr', 'location', 'onHand', 'minQty'] as const) {
        assert.ok(typeof r[f] === 'string' && r[f].length > 0, `${f} is empty: ${JSON.stringify(r)}`);
      }
    }
    assert.equal(at!.nameAr, 'صنف عند الحد');
    assert.equal(at!.location, 'فرع أ T16');
  });
});

test('an item above its minimum is not listed (nor inactive, nor null-minimum ones)', opts, async () => {
  await ready();
  await withDb(async (db) => {
    const rows = await withTenant(db, tenant, (tdb) => belowMinimum(tdb, { days: 30 }));
    assert.equal(rows.find((r) => r.itemId === ids.itemAB), undefined, '6 of min 5 is fine');
    assert.equal(rows.find((r) => r.itemId === ids.itemIN), undefined, 'a retired product raises no alert');
    assert.equal(rows.find((r) => r.itemId === ids.itemNM), undefined, 'a level with no minimum is not a policy');
  });
});

test('a level that has NEVER held stock is listed with zero on hand', opts, async () => {
  await ready();
  await withDb(async (db) => {
    const rows = await withTenant(db, tenant, (tdb) => belowMinimum(tdb, { days: 30 }));
    const nv = rows.find((r) => r.itemId === ids.itemNV);
    assert.ok(nv, 'absent on_hand row means ZERO - the worst case must not vanish');
    assert.equal(nv!.onHand, '0.000');
    assert.equal(nv!.minQty, '4.000');
    assert.equal(nv!.coverDays, '0.0', 'no stock is zero days of cover');
  });
});

test('cover is computed in SQL: lowest first, null (not Infinity) with no history', opts, async () => {
  await ready();
  await withDb(async (db) => {
    const rows = await withTenant(db, tenant, (tdb) => belowMinimum(tdb, { days: 30, locationId: ids.b1! }));
    const by = (k: string) => rows.find((r) => r.itemId === ids[`item${k}`])!;
    assert.equal(by('RD').ratePerDay, '1.000');
    assert.equal(by('RD').coverDays, '1.0');
    assert.equal(by('RC').coverDays, '15.0', '2 on hand / (4/30 per day)');
    assert.equal(by('AT').coverDays, null, 'no history: no cover figure, never a division error');
    assert.equal(by('AT').ratePerDay, null);
    assert.deepEqual(
      rows.map((r) => r.itemId),
      [ids.itemNV, ids.itemRD, ids.itemRC, ids.itemAT],
      'lowest cover first; no-cover figure last',
    );
  });
});

test('the rate is zero, not an error, with no history', opts, async () => {
  await ready();
  await withDb(async (db) => {
    const rate = await withTenant(db, tenant, (tdb) =>
      consumptionRate(tdb, { itemId: ids.itemAT!, locationId: ids.b1!, days: 30 }),
    );
    assert.equal(rate, 0);
    await assert.rejects(
      withTenant(db, tenant, (tdb) => consumptionRate(tdb, { itemId: ids.itemAT!, locationId: ids.b1!, days: 0 })),
      /days/,
    );
  });
});

test('the rate averages issued quantity over the window', opts, async () => {
  await ready();
  await withDb(async (db) => {
    const rate = await withTenant(db, tenant, (tdb) =>
      consumptionRate(tdb, { itemId: ids.itemRD!, locationId: ids.b1!, days: 30 }),
    );
    assert.equal(rate, 1, '30 consumed over 30 days');
    // The plan's own example: 60 issued over 30 days is 2.
    await withTenant(db, tenant, async (tdb) => {
      await postMovement(tdb, { variantId: ids.varX2!, qty: 60, reason: 'opening_balance', toLocationId: ids.b2!, actorUserId: ids.own! });
      await postMovement(tdb, { variantId: ids.varX2!, qty: 60, reason: 'consumption', fromLocationId: ids.b2!, actorUserId: ids.own! });
    });
    const r2 = await withTenant(db, tenant, (tdb) =>
      consumptionRate(tdb, { itemId: ids.itemX2!, locationId: ids.b2!, days: 30 }),
    );
    assert.equal(r2, 2);
  });
});

test('a unit that reaches a branch is counted once, not once per ledger leg', opts, async () => {
  await ready();
  await withDb(async (db) => {
    const rate = (loc: string) =>
      withTenant(db, tenant, (tdb) => consumptionRate(tdb, { itemId: ids.itemT!, locationId: loc, days: 10 }));
    const req = await withTenant(db, tenant, (tdb) =>
      createRequisition(tdb, { branchLocationId: ids.b1!, requestedBy: ids.own!, lines: [{ variantId: ids.varT!, requestedQty: 10 }] }),
    );
    await withTenant(db, tenant, (tdb) => approve(tdb, req.id, ids.own!));
    await withTenant(db, tenant, (tdb) => issue(tdb, req.id, ids.own!, [{ variantId: ids.varT!, qty: 10 }]));
    assert.equal(await rate(ids.wh!), 0, 'mid-flight: nothing has arrived, so nothing is outflow');
    await withTenant(db, tenant, (tdb) => confirmReceipt(tdb, req.id, ids.own!, [{ variantId: ids.varT!, qty: 10 }]));
    assert.equal(await rate(ids.wh!), 1, '10 arrived over 10 days = 1/day, NOT 2 (the transit leg is not a second outflow)');
    assert.equal(await rate(ids.b1!), 0, 'arrival is not consumption at the branch');
  });
});

test('stock in transit is not the branch on hand', opts, async () => {
  await ready();
  await withDb(async (db) => {
    // 10 of T arrived at B1 in the previous test. Put 6 more in flight: on hand stays 10.
    await withTenant(db, tenant, async (tdb) => {
      await setLocationLevel(tdb, { itemId: ids.itemT!, locationId: ids.b1!, minQty: 12, maxQty: 100 });
      const req = await createRequisition(tdb, { branchLocationId: ids.b1!, requestedBy: ids.own!, lines: [{ variantId: ids.varT!, requestedQty: 6 }] });
      await approve(tdb, req.id, ids.own!);
      await issue(tdb, req.id, ids.own!, [{ variantId: ids.varT!, qty: 6 }]);
      const rows = await belowMinimum(tdb, { locationId: ids.b1!, days: 30 });
      const t = rows.find((r) => r.itemId === ids.itemT);
      assert.ok(t, '10 on hand + 6 in transit is still below 12');
      assert.equal(t!.onHand, '10.000');
    });
  });
});

test('the owner sees every branch; a branch user sees only their own', opts, async () => {
  await ready();
  await withDb(async (db) => {
    await withTenant(db, tenant, async (tdb) => {
      const own = await getReplenishmentReport(tdb, tokens.own);
      assert.ok(own.ok);
      if (!own.ok) return;
      assert.equal(own.scope, 'network');
      assert.deepEqual(own.groups.map((g) => g.location).sort(), ['فرع أ T16', 'فرع ب T16']);

      const b1 = await getReplenishmentReport(tdb, tokens.bu1);
      assert.ok(b1.ok);
      if (!b1.ok) return;
      assert.equal(b1.scope, 'branch');
      assert.deepEqual(b1.groups.map((g) => g.location), ['فرع أ T16']);
      assert.ok(
        !b1.groups.flatMap((g) => g.rows).some((r) => r.itemId === ids.itemX2),
        "another branch's row must not leave the database",
      );

      const b2 = await getReplenishmentReport(tdb, tokens.bu2);
      assert.ok(b2.ok);
      if (!b2.ok) return;
      assert.deepEqual(
        b2.groups.flatMap((g) => g.rows).map((r) => r.itemId),
        [ids.itemX2],
        'branch two sees only its own row',
      );
    });
  });
});

test('refusals carry their own code and message', opts, async () => {
  await ready();
  await withDb(async (db) => {
    await withTenant(db, tenant, async (tdb) => {
      const none = await getReplenishmentReport(tdb, tokens.bux);
      assert.deepEqual(none, { ok: false, error: 'invalid' }, 'a branch user with no branch is refused, not shown the network');
      const anon = await getReplenishmentReport(tdb, 'not-a-session');
      assert.deepEqual(anon, { ok: false, error: 'unauthenticated' });
    });
  });
  const keys = Object.values(REPORT_REFUSAL_MESSAGE_KEYS);
  assert.equal(new Set(keys).size, keys.length, 'each code has its OWN message');
  for (const k of keys) assert.ok(hasKey(k), k);
});

test('the list is bounded and says when it was cut', opts, async () => {
  await ready();
  await withDb(async (db) => {
    await withTenant(db, tenant, async (tdb) => {
      const cut = await belowMinimum(tdb, { days: 30, limit: 2 });
      assert.equal(cut.length, 2, 'the explicit LIMIT binds');
      const rep = await getReplenishmentReport(tdb, tokens.own, { limit: 2 });
      assert.ok(rep.ok);
      if (!rep.ok) return;
      assert.equal(rep.truncated, true);
      assert.equal(rep.groups.flatMap((g) => g.rows).length, 2);
      const whole = await getReplenishmentReport(tdb, tokens.own, { limit: 100 });
      assert.ok(whole.ok && whole.truncated === false);
    });
  });
});
