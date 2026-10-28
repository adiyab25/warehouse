import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, test } from 'node:test';

import { Client, Pool } from 'pg';

import { withTenant } from '../../src/db/client.ts';
import { createLocation } from '../../src/db/locations.ts';
import { postMovement } from '../../src/db/movements.ts';
import { createItem } from '../../src/db/items.ts';
import {
  COLUMNS,
  formatSummary,
  importLockText,
  parseCsv,
  parseOpeningCsv,
  runOpeningImport,
  type ImportResult,
} from '../../src/import/opening.ts';
import { REPO_ROOT, migrateUrl, sqlTestUrl } from '../harness/sql.ts';

/**
 * Contract tests for the OPENING-BALANCE IMPORT (Task 19) — a privileged bulk
 * write to the append-only ledger. The properties that matter: all-or-nothing,
 * dry-run writes nothing, a re-run is harmless but never swallows a different
 * number, an opening balance is first or refused, existing items are never
 * overwritten, numbers are exact strings, and the actor is always recorded.
 */

const HEADER = COLUMNS.join(',');
const SAMPLE = resolve(REPO_ROOT, 'docs', 'opening-sample.csv');
const POOL = new Pool({ connectionString: sqlTestUrl()! });
const OWNER_POOL = new Pool({ connectionString: migrateUrl()! });
const tenants: string[] = [];

type Fx = {
  tenant: string;
  userId: string;
  loc: Record<string, string>;
};

async function owner<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: migrateUrl()! });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function fixture(): Promise<Fx> {
  const { tenant, userId } = await owner(async (c) => {
    const {
      rows: [t],
    } = await c.query<{ id: string }>("insert into tenants (name) values ('Opening Import') returning id");
    const mk = async (username: string, role: string, active = true): Promise<string> => {
      const {
        rows: [u],
      } = await c.query<{ id: string }>(
        `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash, active)
         values ($1, $2, public.normalise_name($2), $2, $3, 'x', $4) returning id`,
        [t!.id, username, role, active],
      );
      return u!.id;
    };
    const userId = await mk('wm_one', 'warehouse_manager');
    await mk('owner_x', 'owner');
    await mk('branch_x', 'branch_user');
    await mk('gone_x', 'owner', false);
    return { tenant: t!.id, userId };
  });
  tenants.push(tenant);
  const loc: Record<string, string> = {};
  await withTenant(POOL, tenant, async (db) => {
    for (const [code, type] of [
      ['MAIN', 'warehouse'],
      ['BR1', 'branch'],
      ['QUAR', 'quarantine'],
      ['TRN', 'transit'],
      ['VND', 'vendor'],
      ['BIN1', 'bin'],
      ['OLD', 'warehouse'],
    ] as const) {
      loc[code] = (await createLocation(db, { code, nameAr: `موقع ${code}`, type })).id;
    }
  });
  await owner((c) => c.query('update locations set active = false where id = $1', [loc.OLD]));
  return { tenant, userId, loc };
}

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n') + '\n';
}

function run(
  fx: Fx,
  text: string | Buffer,
  o: { apply?: boolean; user?: string; name?: string; tenant?: string; pool?: Pool } = {},
): Promise<ImportResult> {
  return runOpeningImport(o.pool ?? POOL, {
    tenantId: o.tenant ?? fx.tenant,
    username: o.user ?? 'wm_one',
    fileName: o.name ?? 'test.csv',
    apply: o.apply ?? false,
    readInput: () => (typeof text === 'string' ? Buffer.from(text, 'utf8') : text),
  });
}

/** A digest of every row the import could touch, for byte-identical checks. */
async function snap(tenant: string): Promise<string> {
  return owner(async (c) => {
    const out: string[] = [];
    for (const [t, order] of [
      ['items', 'id'],
      ['item_variants', 'id'],
      ['stock_movements', 'id'],
    ] as const) {
      const { rows } = await c.query<{ n: string; h: string }>(
        `select count(*)::text n, md5(coalesce(string_agg(x::text, '|' order by ${order}), '')) h
           from ${t} x where tenant_id = $1`,
        [tenant],
      );
      out.push(`${t}:${rows[0]!.n}:${rows[0]!.h}`);
    }
    return out.join(' ');
  });
}

async function movements(tenant: string): Promise<Array<Record<string, string | null>>> {
  return owner(async (c) => {
    const { rows } = await c.query(
      `select m.idempotency_key, m.qty::text qty, m.reason, m.ref_type, m.notes, m.actor_user_id,
              l.code as to_code, v.sku
         from stock_movements m
         join item_variants v on v.id = m.variant_id
         join locations l on l.id = m.to_location_id
        where m.tenant_id = $1 order by m.seq`,
      [tenant],
    );
    return rows;
  });
}

const msgs = (r: ImportResult): string => r.errors.map((e) => `${e.line ?? 'file'}: ${e.message}`).join('\n');

after(async () => {
  await POOL.end();
  await OWNER_POOL.end();
  if (tenants.length === 0) return;
  await owner(async (c) => {
    await c.query('set session_replication_role = replica');
    const { rows } = await c.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'tenant_id'
          and table_name in (select table_name from information_schema.tables where table_type = 'BASE TABLE')`,
    );
    for (const { table_name } of rows) {
      await c.query(`delete from "${table_name}" where tenant_id = any($1)`, [tenants]);
    }
    await c.query('delete from tenants where id = any($1)', [tenants]);
    await c.query('set session_replication_role = origin');
  });
});

// ---------------------------------------------------------------------------
// The three plan tests
// ---------------------------------------------------------------------------

test('importing a CSV posts one opening movement per line', async () => {
  const fx = await fixture();
  const sample = readFileSync(SAMPLE);
  const r = await run(fx, sample, { apply: true, name: 'opening-sample.csv' });
  assert.equal(r.ok, true, msgs(r));
  assert.equal(r.applied, true);
  assert.equal(r.rowsRead, 5);
  assert.equal(r.itemsToCreate, 4);
  assert.equal(r.movementsToPost, 5);

  const ms = await movements(fx.tenant);
  assert.equal(ms.length, 5);
  for (const m of ms) {
    assert.equal(m.reason, 'opening_balance');
    assert.equal(m.ref_type, 'IMPORT');
    assert.equal(m.actor_user_id, fx.userId, 'the actor is the resolved user, never null');
    assert.equal(m.idempotency_key, `opening:${m.sku}:${m.to_code}`);
  }
  const rice = ms.find((m) => m.sku === 'RIC-0001')!;
  assert.equal(rice.qty, '150.500');
  assert.match(rice.notes!, /opening-sample\.csv line 5/);

  // on_hand and the item details come out exactly as the CSV says.
  const detail = await owner(async (c) => {
    const { rows } = await c.query(
      `select v.sku, v.barcode, i.cost_egp::text cost, i.discrete, i.name_ar, i.pack_factor::text pf, o.qty::text qty, l.code
         from on_hand o join item_variants v on v.id = o.variant_id join items i on i.id = v.item_id
         join locations l on l.id = o.location_id where v.tenant_id = $1 order by v.sku, l.code`,
      [fx.tenant],
    );
    return rows;
  });
  assert.equal(detail.length, 5);
  const ppr = detail.find((d) => d.sku === 'PPR-0001')!;
  assert.equal(ppr.cost, '120.50', 'piasters round-trip exactly');
  assert.equal(ppr.barcode, 'PPR-0001', 'barcode = sku');
  assert.equal(ppr.name_ar, 'ورق تصوير A4');
  assert.equal(ppr.discrete, true);
  assert.equal(detail.find((d) => d.sku === 'RIC-0001')!.discrete, false, 'kg is measured, not counted');
  assert.deepEqual(
    detail.map((d) => `${d.sku}@${d.code}=${d.qty}`),
    ['CHR-0001@MAIN=12.000', 'PEN-0001@BR1=36.000', 'PEN-0001@MAIN=240.000', 'PPR-0001@MAIN=40.000', 'RIC-0001@MAIN=150.500'],
  );
});

test('re-running the import posts nothing new', async () => {
  const fx = await fixture();
  const sample = readFileSync(SAMPLE);
  assert.equal((await run(fx, sample, { apply: true })).ok, true);
  const before = await snap(fx.tenant);
  const again = await run(fx, sample, { apply: true });
  assert.equal(again.ok, true, msgs(again));
  assert.equal(again.unchanged, 5);
  assert.equal(again.movementsToPost, 0);
  assert.equal(again.itemsToCreate, 0);
  assert.equal(await snap(fx.tenant), before, 'byte-identical after a re-run');
});

test('a row naming an unknown location fails the whole import, not half of it', async () => {
  const fx = await fixture();
  const before = await snap(fx.tenant);
  const r = await run(
    fx,
    csv('AAA-0001,صنف أول,consumable,unit,1,1.00,MAIN,5', 'AAA-0002,صنف ثان,consumable,unit,1,1.00,MAIN,6', 'AAA-0003,صنف ثالث,consumable,unit,1,1.00,NOWHERE,7'),
    { apply: true },
  );
  assert.equal(r.ok, false);
  assert.equal(r.applied, false);
  assert.equal(r.movementsToPost, 0, 'a failed import reports nothing to post');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]!.line, 4);
  assert.match(r.errors[0]!.message, /unknown location "NOWHERE"/);
  assert.equal(await snap(fx.tenant), before, 'no items, variants or movements were written');
});

// ---------------------------------------------------------------------------
// Dry run, atomicity
// ---------------------------------------------------------------------------

test('dry-run is the default: same code path, reports the plan, writes nothing', async () => {
  const fx = await fixture();
  const before = await snap(fx.tenant);
  const dry = await run(fx, readFileSync(SAMPLE));
  assert.equal(dry.ok, true, msgs(dry));
  assert.equal(dry.applied, false);
  assert.equal(dry.itemsToCreate, 4);
  assert.equal(dry.movementsToPost, 5);
  assert.equal(dry.plan.length, 9);
  assert.equal(await snap(fx.tenant), before, 'a dry run leaves the database byte-identical');
  const real = await run(fx, readFileSync(SAMPLE), { apply: true });
  assert.deepEqual(
    [real.itemsToCreate, real.movementsToPost, real.plan],
    [dry.itemsToCreate, dry.movementsToPost, dry.plan],
    'dry run and apply do exactly the same thing',
  );
});

test('a row the database refuses late in the file rolls back the EARLIER rows too', async () => {
  const fx = await fixture();
  const trg = `import_poison_${fx.tenant.replace(/-/g, '').slice(0, 12)}`;
  await owner(async (c) => {
    await c.query(
      `create function ${trg}() returns trigger language plpgsql as $f$
       begin
         if new.tenant_id = '${fx.tenant}' and new.notes like '%poison.csv line 4' then
           raise exception 'poisoned row';
         end if;
         return new;
       end $f$`,
    );
    await c.query(`create trigger ${trg} before insert on stock_movements for each row execute function ${trg}()`);
  });
  try {
    const before = await snap(fx.tenant);
    const r = await run(
      fx,
      csv('POI-0001,صنف,consumable,unit,1,1.00,MAIN,1', 'POI-0002,صنف,consumable,unit,1,1.00,MAIN,2', 'POI-0003,صنف,consumable,unit,1,1.00,MAIN,3'),
      { apply: true, name: 'poison.csv' },
    );
    assert.equal(r.ok, false);
    assert.equal(r.applied, false);
    assert.equal(r.errors[0]!.line, 4);
    assert.match(r.errors[0]!.message, /poisoned row/);
    assert.equal(await snap(fx.tenant), before, 'rows 2 and 3 were rolled back with the failing row');
  } finally {
    await owner(async (c) => {
      await c.query(`drop trigger if exists ${trg} on stock_movements`);
      await c.query(`drop function if exists ${trg}()`);
    });
  }
});

test('every error is listed with its CSV line number, not just the first', async () => {
  const fx = await fixture();
  const before = await snap(fx.tenant);
  const r = await run(
    fx,
    csv(
      'ERR-0001,صنف,consumable,unit,1,1.00,NOWHERE,5',
      'ERR-0002,صنف,consumable,unit,1,1.00,MAIN,"1,200"',
      'ERR-0003,صنف,consumable,unit,1,1.00,MAIN,\u0661\u0662\u0663',
      'ERR-0004,صنف,consumable,unit,1,1.00,MAIN,4',
    ),
    { apply: true },
  );
  assert.equal(r.ok, false);
  const byLine = new Map(r.errors.map((e) => [e.line, e.message]));
  assert.match(byLine.get(2)!, /unknown location/);
  assert.match(byLine.get(3)!, /thousands separator/);
  assert.match(byLine.get(4)!, /Arabic-Indic/);
  assert.equal(byLine.has(5), false);
  assert.equal(await snap(fx.tenant), before);
});

test('the error list is capped at 50 with "... and N more"', async () => {
  const fx = await fixture();
  const rows = Array.from({ length: 60 }, (_, i) => `CAP-${String(i + 1).padStart(4, '0')},صنف,consumable,unit,1,1.00,NOWHERE,1`);
  const r = await run(fx, csv(...rows));
  assert.equal(r.errors.length, 60);
  const text = formatSummary(r, false);
  assert.match(text, /\.\.\. and 10 more/);
  assert.equal((text.match(/unknown location/g) ?? []).length, 50);
  assert.doesNotMatch(text, /postgres|password/i);
});

// ---------------------------------------------------------------------------
// The idempotency key must not swallow a different number
// ---------------------------------------------------------------------------

test('a re-run with a DIFFERENT qty for the same sku+location is an error, not a silent skip', async () => {
  const fx = await fixture();
  const row = (q: string): string => csv(`QTY-0001,صنف,consumable,unit,1,1.00,MAIN,${q}`);
  assert.equal((await run(fx, row('10'), { apply: true })).ok, true);
  const before = await snap(fx.tenant);
  const r = await run(fx, row('12'), { apply: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0]!.line, 2);
  assert.match(r.errors[0]!.message, /stored 10, this file says 12/);
  assert.match(r.errors[0]!.message, /COUNT SESSION/);
  assert.equal(await snap(fx.tenant), before);
  // The same number with a different spelling is unchanged, not an error.
  const same = await run(fx, row('10.000'), { apply: true });
  assert.equal(same.ok, true, msgs(same));
  assert.equal(same.unchanged, 1);
});

test('duplicate sku+location rows in one file are refused, naming both lines', async () => {
  const fx = await fixture();
  const before = await snap(fx.tenant);
  const r = await run(
    fx,
    csv(
      'DUP-0001,صنف,consumable,unit,1,1.00,MAIN,5',
      'DUP-0001,صنف,consumable,unit,1,1.00,BR1,5',
      'dup-0001,صنف,consumable,unit,1,1.00,main,6',
    ),
  );
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1, 'same sku at a different location is fine; only the repeat is refused');
  assert.equal(r.errors[0]!.line, 4);
  assert.match(r.errors[0]!.message, /lines 2 and 4/);
  assert.equal(await snap(fx.tenant), before);
});

test('opening balance must come first: trading already started at that location is refused', async () => {
  const fx = await fixture();
  const variantId = await withTenant(POOL, fx.tenant, async (db) => {
    const { variant } = await createItem(db, { sku: 'TRD-0001', barcode: 'TRD-0001', nameAr: 'صنف', family: 'consumable', uom: 'unit', packFactor: 1, costEgp: 1 });
    await postMovement(db, { variantId: variant.id, qty: 4, reason: 'receipt', toLocationId: fx.loc.MAIN, actorUserId: fx.userId });
    return variant.id;
  });
  const before = await snap(fx.tenant);
  const r = await run(fx, csv('TRD-0001,صنف,consumable,unit,1,1.00,MAIN,9', 'NEW-0001,جديد,consumable,unit,1,1.00,MAIN,1'), { apply: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]!.line, 2);
  assert.match(r.errors[0]!.message, /double count/);
  assert.equal(await snap(fx.tenant), before, 'nothing written, including the valid second row');
  // A different location for that item is still fine.
  const ok = await run(fx, csv('TRD-0001,صنف,consumable,unit,1,1.00,BR1,9'), { apply: true });
  assert.equal(ok.ok, true, msgs(ok));
  assert.ok(variantId);
});

// ---------------------------------------------------------------------------
// Existing items are never overwritten
// ---------------------------------------------------------------------------

test('a known sku must MATCH the CSV on every attribute; the import never edits an item', async () => {
  const fx = await fixture();
  await withTenant(POOL, fx.tenant, (db) =>
    createItem(db, { sku: 'KNW-0001', barcode: 'KNW-0001', nameAr: 'كرسي مكتب', family: 'asset', uom: 'unit', packFactor: 2, costEgp: 120.5 }),
  );
  const before = await snap(fx.tenant);
  const good = 'KNW-0001,كرسي مكتب,asset,unit,2,120.50,MAIN,3';
  const dry = await run(fx, csv(good));
  assert.equal(dry.ok, true, msgs(dry));
  assert.equal(dry.itemsToCreate, 0);
  const cases: Array<[string, string, RegExp]> = [
    ['KNW-0001,كرسي آخر,asset,unit,2,120.50,MAIN,3', 'name_ar', /name_ar differs: CSV has "كرسي آخر", the item has "كرسي مكتب"/],
    ['KNW-0001,كرسي مكتب,sellable,unit,2,120.50,MAIN,3', 'family', /family differs: CSV has "sellable", the item has "asset"/],
    ['KNW-0001,كرسي مكتب,asset,box,2,120.50,MAIN,3', 'uom', /uom differs: CSV has "box", the item has "unit"/],
    ['KNW-0001,كرسي مكتب,asset,unit,3,120.50,MAIN,3', 'pack', /pack_factor differs: CSV has "3", the item has "2"/],
    ['KNW-0001,كرسي مكتب,asset,unit,2,120.55,MAIN,3', 'cost', /cost_egp differs: CSV has "120.55", the item has "120.5"/],
  ];
  for (const [row, field, re] of cases) {
    const r = await run(fx, csv(row), { apply: true });
    assert.equal(r.ok, false, field);
    assert.match(r.errors[0]!.message, re, field);
    assert.equal(r.errors[0]!.line, 2);
  }
  assert.equal(await snap(fx.tenant), before, 'the item is untouched and nothing was posted');
});

test('the same new sku on two rows must carry the same details', async () => {
  const fx = await fixture();
  const r = await run(fx, csv('SAM-0001,صنف,consumable,unit,1,1.00,MAIN,1', 'SAM-0001,اسم آخر,consumable,unit,1,1.00,BR1,1'));
  assert.equal(r.ok, false);
  assert.match(msgs(r), /2?:?.*also appears on line 2 with a different name_ar/);
});

test('a sku the scanner would reject is rejected at write time; codes are normalised', async () => {
  const fx = await fixture();
  for (const sku of ['abc', 'AB 0012', 'PEN_0001', '']) {
    const r = await run(fx, csv(`${sku},صنف,consumable,unit,1,1.00,MAIN,1`));
    assert.equal(r.ok, false, JSON.stringify(sku));
    assert.match(msgs(r), /sku/);
  }
  const ok = await run(fx, csv(' pen-0007 ,صنف,consumable,unit,1,1.00, main ,3'), { apply: true });
  assert.equal(ok.ok, true, msgs(ok));
  const [m] = await movements(fx.tenant);
  assert.equal(m!.idempotency_key, 'opening:PEN-0007:MAIN');
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

test('locations must exist, be active and be warehouse/branch/quarantine — with distinct errors', async () => {
  const fx = await fixture();
  const row = (loc: string, n: number): string => `LOC-000${n},صنف,consumable,unit,1,1.00,${loc},1`;
  const r = await run(fx, csv(row('MAIN', 1), row('BR1', 2), row('QUAR', 3), row('TRN', 4), row('VND', 5), row('BIN1', 6), row('OLD', 7), row('NOPE', 8)));
  const byLine = new Map(r.errors.map((e) => [e.line, e.message]));
  assert.deepEqual([...byLine.keys()], [5, 6, 7, 8, 9]);
  assert.match(byLine.get(5)!, /"TRN" is a transit location/);
  assert.match(byLine.get(6)!, /"VND" is a vendor location/);
  assert.match(byLine.get(7)!, /"BIN1" is a bin location/);
  assert.match(byLine.get(8)!, /"OLD" is inactive/);
  assert.match(byLine.get(9)!, /unknown location "NOPE"/);
  // and the importer never created a location
  const n = await owner(async (c) => (await c.query('select count(*)::int n from locations where tenant_id = $1', [fx.tenant])).rows[0].n);
  assert.equal(n, 7);
});

// ---------------------------------------------------------------------------
// Exact numbers
// ---------------------------------------------------------------------------

test('qty / cost / pack_factor: specific rejections for every bad shape', async () => {
  const fx = await fixture();
  const before = await snap(fx.tenant);
  const row = (pack: string, cost: string, qty: string): string => `NUM-0001,صنف,consumable,kg,${pack},${cost},MAIN,${qty}`;
  const bad: Array<[string, string, string, RegExp]> = [
    ['1', '1.00', '"1,200"', /qty "1,200" has a thousands separator/],
    ['1', '1.00', '"1,5"', /qty "1,5" uses a comma as the decimal point/],
    ['1', '1.00', '\u0661\u0662\u0663', /qty .* Arabic-Indic or full-width digits/],
    ['1', '1.00', '\uFF11\uFF12', /full-width/],
    ['1', '1.00', '1e3', /qty "1e3" is in scientific notation/],
    ['1', '1.00', 'NaN', /qty "NaN" is not a number/],
    ['1', '1.00', 'Infinity', /qty "Infinity" is not a number/],
    ['1', '1.00', '-5', /qty "-5" is negative/],
    ['1', '1.00', '+5', /plus sign/],
    ['1', '1.00', '5 units', /qty "5 units" is not a plain decimal/],
    ['1', '1.00', '£5', /currency/],
    ['1', '1.00', '', /qty is blank/],
    ['1', '1.00', '1.2345', /more than 3 decimal places/],
    ['1', '1.00', '1234567890', /too large/],
    ['1', '1.00', '.5', /not a plain decimal/],
    ['1', '1.00', '007', /leading zeros/],
    ['1', '£5', '1', /cost_egp "£5" contains a currency/],
    ['1', '"1,200.50"', '1', /cost_egp .* thousands separator/],
    ['1', '120.555', '1', /cost_egp .* more than 2 decimal places/],
    ['1', '-1', '1', /cost_egp "-1" is negative/],
    ['1', '', '1', /cost_egp is blank/],
    ['1', '12345678901', '1', /cost_egp .* too large/],
    ['2.5', '1', '1', /pack_factor "2.5" must be a whole number/],
    ['0', '1', '1', /pack_factor "0" must be greater than zero/],
    ['\u0662', '1', '1', /pack_factor .* Arabic-Indic/],
    ['', '1', '1', /pack_factor is blank/],
  ];
  for (const [pack, cost, qty, re] of bad) {
    const r = await run(fx, csv(row(pack, cost, qty)), { apply: true });
    assert.equal(r.ok, false, `${pack}|${cost}|${qty}`);
    assert.match(msgs(r), re, `${pack}|${cost}|${qty}`);
    assert.equal(r.errors[0]!.line, 2);
  }
  assert.equal(await snap(fx.tenant), before);
});

test('awkward decimals are stored EXACTLY; whole numbers only for discrete items; zero is skipped', async () => {
  const fx = await fixture();
  const r = await run(
    fx,
    csv(
      'DEC-0001,صنف,consumable,kg,1,0.10,MAIN,0.1',
      'DEC-0002,صنف,consumable,kg,1,0.70,MAIN,0.7',
      'DEC-0003,صنف,consumable,kg,1,1.00,MAIN,1234567.891',
      'DEC-0004,صنف,consumable,kg,1,1.00,MAIN,999999999.999',
      'DEC-0005,صنف,consumable,unit,1,1.00,MAIN,7',
      'DEC-0006,صنف,consumable,unit,1,1.00,MAIN,0',
      'DEC-0007,صنف,consumable,kg,1,1.00,MAIN,0.000',
    ),
    { apply: true },
  );
  assert.equal(r.ok, true, msgs(r));
  assert.equal(r.skippedZero, 2);
  assert.equal(r.movementsToPost, 5);
  assert.equal(r.itemsToCreate, 5, 'zero-qty rows create no item');
  const got = Object.fromEntries((await movements(fx.tenant)).map((m) => [m.sku, m.qty]));
  assert.deepEqual(got, {
    'DEC-0001': '0.100',
    'DEC-0002': '0.700',
    'DEC-0003': '1234567.891',
    'DEC-0004': '999999999.999',
    'DEC-0005': '7.000',
  });
  const frac = await run(fx, csv('WHL-0001,صنف,consumable,unit,1,1.00,MAIN,2.5'), { apply: true });
  assert.equal(frac.ok, false);
  assert.match(msgs(frac), /not a whole number .* counted in whole units/);
});

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

test('the CSV parser is RFC-4180: quotes, commas, newlines, CRLF/LF, BOM, blank lines, ragged rows', () => {
  const t = parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,"two\nlines",z\n\n\n3,,\n,,\n');
  assert.deepEqual(t.errors, []);
  assert.deepEqual(t.records, [
    { line: 1, fields: ['a', 'b', 'c'] },
    { line: 2, fields: ['1', 'x, y', 'say "hi"'] },
    { line: 4, fields: ['2', 'two\nlines', 'z'] },
    { line: 8, fields: ['3', '', ''] },
  ]);
  assert.equal(parseCsv('a,b').records.length, 1, 'no trailing newline is fine');
  assert.match(parseCsv('a,"b\n').errors[0]!.message, /never closed/);
  assert.match(parseCsv('a,b"c\n').errors[0]!.message, /quote mark appears in the middle/);
  assert.match(parseCsv('a,"b"c\n').errors[0]!.message, /follows a closing quote/);
});

test('header: any order, any case, exactly the 8 columns; ragged rows and BOM; invalid UTF-8; caps', () => {
  const rowText = 'PEN-0001,قلم,consumable,unit,1,1.00,MAIN,5';
  const reordered = `\uFEFF QTY ,Location_Code,cost_EGP,pack_factor,UOM,family,name_ar,SKU\n5,MAIN,1.00,1,unit,consumable,قلم,PEN-0001\r\n`;
  const ok = parseOpeningCsv(Buffer.from(reordered, 'utf8'));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.rows[0]!.sku, 'PEN-0001');
  assert.equal(ok.rows[0]!.locationCode, 'MAIN');
  assert.equal(ok.rows[0]!.qty, '5');

  const missing = parseOpeningCsv(Buffer.from(`sku,name_ar\nA-1,x\n`));
  assert.match(missing.errors[0]!.message, /missing column\(s\): family, uom, pack_factor, cost_egp, location_code, qty/);
  const unknown = parseOpeningCsv(Buffer.from(`${HEADER},colour\n${rowText},red\n`));
  assert.match(unknown.errors[0]!.message, /unknown column\(s\): "colour"/);
  const dup = parseOpeningCsv(Buffer.from(`${HEADER},qty\n${rowText},1\n`));
  assert.match(dup.errors[0]!.message, /repeats column\(s\): qty/);

  const ragged = parseOpeningCsv(Buffer.from(`${HEADER}\n${rowText}\n\nPEN-0002,قلم,consumable,unit,1,1.00,MAIN\n${rowText},extra\n`));
  assert.deepEqual(
    ragged.errors.map((e) => e.line),
    [4, 5],
  );
  assert.match(ragged.errors[0]!.message, /7 value\(s\) but the header has 8/);

  // Windows-1256 'ق' = 0xE2 is not valid UTF-8.
  const win1256 = Buffer.concat([Buffer.from(`${HEADER}\nPEN-0001,`), Buffer.from([0xe2, 0xe1, 0xe3]), Buffer.from(',consumable,unit,1,1.00,MAIN,5\n')]);
  const bad = parseOpeningCsv(win1256);
  assert.match(bad.errors[0]!.message, /not valid UTF-8.*CSV UTF-8/);
  assert.equal(bad.rows.length, 0);

  assert.match(parseOpeningCsv(Buffer.alloc(5 * 1024 * 1024 + 1, 97)).errors[0]!.message, /larger than 5 MB/);
  const many = [HEADER, ...Array.from({ length: 20_001 }, (_, i) => `K-${i + 1},n,consumable,unit,1,1,MAIN,1`)].join('\n');
  assert.match(parseOpeningCsv(Buffer.from(many)).errors[0]!.message, /20001 data rows; the limit is 20000/);
  assert.match(parseOpeningCsv(Buffer.from('')).errors[0]!.message, /empty/);
  assert.match(parseOpeningCsv(Buffer.from(`${HEADER}\n`)).errors[0]!.message, /no data rows/);
});

test('names: quoted commas and Arabic survive; blank, long and control characters are refused', async () => {
  const fx = await fixture();
  const ok = await run(fx, csv('NAM-0001,"قلم, أزرق ""فاخر""",consumable,unit,1,1.00,MAIN,1'), { apply: true });
  assert.equal(ok.ok, true, msgs(ok));
  const stored = await owner(async (c) => (await c.query('select name_ar from items where tenant_id = $1', [fx.tenant])).rows[0].name_ar);
  assert.equal(stored, 'قلم, أزرق "فاخر"');
  const cases: Array<[string, RegExp]> = [
    ['NAM-0002,   ,consumable,unit,1,1.00,MAIN,1', /name_ar is blank/],
    [`NAM-0003,${'ا'.repeat(201)},consumable,unit,1,1.00,MAIN,1`, /longer than 200/],
    ['NAM-0004,"two\nlines",consumable,unit,1,1.00,MAIN,1', /control character/],
    ['NAM-0005,x\u0007y,consumable,unit,1,1.00,MAIN,1', /control character/],
    ['NAM-0006,صنف,gadget,unit,1,1.00,MAIN,1', /family "gadget" is not one of/],
    ['NAM-0007,صنف,consumable,,1,1.00,MAIN,1', /uom is blank/],
    [`NAM-0008,صنف,consumable,${'u'.repeat(21)},1,1.00,MAIN,1`, /uom is longer than 20/],
  ];
  for (const [row, re] of cases) {
    const r = await run(fx, csv(row));
    assert.equal(r.ok, false, row);
    assert.match(msgs(r), re, row);
  }
});

// ---------------------------------------------------------------------------
// Actor, tenant, role
// ---------------------------------------------------------------------------

test('the actor must be an active owner/warehouse_manager IN THIS tenant, refused before the file is read', async () => {
  const fx = await fixture();
  const other = await fixture();
  let read = 0;
  const attempt = (user: string, tenant = fx.tenant): Promise<ImportResult> =>
    runOpeningImport(POOL, { tenantId: tenant, username: user, fileName: 'x.csv', apply: true, readInput: () => (read++, Buffer.from(csv('ACT-0001,صنف,consumable,unit,1,1.00,MAIN,1'))) });
  const unknown = await attempt('nobody');
  assert.match(msgs(unknown), /user "nobody" does not exist in this tenant/);
  const branch = await attempt('branch_x');
  assert.match(msgs(branch), /only an owner or warehouse_manager/);
  const gone = await attempt('gone_x');
  assert.match(msgs(gone), /deactivated/);
  // a real user of ANOTHER tenant is not an actor here
  const crossed = await owner(async (c) =>
    (await c.query(`insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1,'zed_only',public.normalise_name('zed_only'),'zed_only','owner','x') returning id`, [other.tenant])).rows[0].id,
  );
  assert.ok(crossed);
  assert.match(msgs(await attempt('zed_only')), /does not exist in this tenant/);
  assert.equal(read, 0, 'the file is never read for a refused actor');
  assert.equal((await movements(fx.tenant)).length, 0);
  // normalised username, and the owner role is also fine
  const okOwner = await attempt(' OWNER_X ');
  assert.equal(okOwner.ok, true, msgs(okOwner));
  assert.equal(read, 1);
  assert.equal((await movements(fx.tenant))[0]!.actor_user_id !== null, true);
  // a malformed tenant id is refused, with no fallback
  assert.match(msgs(await attempt('wm_one', 'not-a-uuid')), /not a valid tenant id/);
});

test('the importer REFUSES a superuser / BYPASSRLS connection', async () => {
  const fx = await fixture();
  await assert.rejects(run(fx, csv('OWN-0001,صنف,consumable,unit,1,1.00,MAIN,1'), { apply: true, pool: OWNER_POOL }), /refusing to serve as role/);
  assert.equal((await movements(fx.tenant)).length, 0);
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('rows for EXISTING items hold a pair lock each: 4,000 are fine, 4,001 are refused up front', async () => {
  const fx = await fixture();
  await owner((c) =>
    c.query(
      `with s as (select g, gen_random_uuid() id from generate_series(1, 4001) g),
            i as (insert into items (id, tenant_id, name_ar, family, uom, pack_factor, cost_egp)
                   select id, $1, 'صنف', 'consumable', 'unit', 1, 1 from s returning id)
       insert into item_variants (tenant_id, item_id, sku, barcode)
       select $1, s.id, 'EX-' || lpad(g::text, 5, '0'), 'EX-' || lpad(g::text, 5, '0') from s`,
      [fx.tenant],
    ),
  );
  const rows = (n: number): string[] => Array.from({ length: n }, (_, i) => `EX-${String(i + 1).padStart(5, '0')},صنف,consumable,unit,1,1.00,MAIN,2`);
  const before = await snap(fx.tenant);
  const over = await run(fx, csv(...rows(4001)), { apply: true });
  assert.equal(over.ok, false);
  assert.match(msgs(over), /4001 items that already exist; the limit is 4000/);
  assert.equal(await snap(fx.tenant), before);
  const ok = await run(fx, csv(...rows(4000)), { apply: true });
  assert.equal(ok.ok, true, msgs(ok));
  assert.equal(ok.movementsToPost, 4000);
  assert.equal(ok.itemsToCreate, 0);
  assert.equal((await movements(fx.tenant)).length, 4000);
});

test('an import waits for the tenant import lock (same key as every other import)', async () => {
  const fx = await fixture();
  const holder = new Client({ connectionString: migrateUrl()! });
  await holder.connect();
  try {
    await holder.query('begin');
    await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [importLockText(fx.tenant)]);
    let done = false;
    const p = run(fx, readFileSync(SAMPLE), { apply: true }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(done, false, 'the import must be blocked while another import holds the tenant lock');
    await holder.query('commit');
    const r = await p;
    assert.equal(r.ok, true, msgs(r));
  } finally {
    await holder.end();
  }
});

test('two parallel --apply runs of the same file: one set of movements, neither errors', async () => {
  const fx = await fixture();
  const sample = readFileSync(SAMPLE);
  const [a, b] = await Promise.all([run(fx, sample, { apply: true }), run(fx, sample, { apply: true })]);
  assert.equal(a.ok, true, msgs(a));
  assert.equal(b.ok, true, msgs(b));
  assert.deepEqual([a.movementsToPost, b.movementsToPost].sort(), [0, 5]);
  assert.deepEqual([a.unchanged, b.unchanged].sort(), [0, 5]);
  assert.equal((await movements(fx.tenant)).length, 5);
});

// ---------------------------------------------------------------------------
// The real CLI
// ---------------------------------------------------------------------------

function cli(args: string[], env: Record<string, string | undefined>): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/import-opening.mjs', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('the CLI: usage errors exit 2, dry-run exits 0 and writes nothing, owner url is refused, no secrets printed', async () => {
  const fx = await fixture();
  const appEnv = { APP_DATABASE_URL: sqlTestUrl()!, TENANT_ID: fx.tenant };
  const base = ['--tenant', fx.tenant, '--user', 'wm_one', '--file', SAMPLE];

  const noTenant = cli(['--user', 'wm_one', '--file', SAMPLE], appEnv);
  assert.equal(noTenant.code, 2, 'no TENANT_ID fallback');
  assert.match(noTenant.out, /--tenant is required/);

  const before = await snap(fx.tenant);
  const dry = cli(base, appEnv);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /DRY RUN/);
  assert.match(dry.out, /movements to post:    5/);
  assert.match(dry.out, new RegExp(fx.tenant));
  assert.match(dry.out, /file:    opening-sample\.csv/);
  assert.equal(await snap(fx.tenant), before);

  const applied = cli([...base, '--apply'], appEnv);
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /RESULT: SAVED/);
  assert.equal((await movements(fx.tenant)).length, 5);

  const again = cli([...base, '--apply'], appEnv);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /unchanged \(re-run\):   5/);
  assert.equal((await movements(fx.tenant)).length, 5);

  const asOwner = cli([...base, '--apply'], { APP_DATABASE_URL: migrateUrl()! });
  assert.equal(asOwner.code, 1);
  assert.match(asOwner.out, /refusing to serve as role/);
  assert.doesNotMatch(asOwner.out, /postgresql:\/\//);
});
