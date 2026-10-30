import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { Client } from 'pg';

import { issueClient } from '@/modules/api/index';
import { getAppPool } from '@/modules/platform/index';
import { withTenant } from '@/modules/platform/index';
import { createItem, setLocationLevel } from '@/modules/catalog/index';
import { createLocation } from '@/modules/locations/index';
import { postMovement } from '@/modules/ledger/index';
import { MOVEMENT_REASONS } from '@/modules/ledger/schema';
import { API_ALLOWED_REASONS, executeMovement, parseMovementBody } from '@/modules/api/index';
import { GET as getMovements, POST as postMovements } from '../../src/app/api/v1/movements/route.ts';
import { GET as getOnHand } from '../../src/app/api/v1/on-hand/route.ts';
import { migrateUrl, sqlTestUrl } from '../harness/sql.ts';

/** Task 18a: the WRITE API for movements + the events outbox. */

const skip = !sqlTestUrl() || !migrateUrl();
const tenants: string[] = [];

type World = {
  tenant: string;
  wh: string;
  br: string;
  whCode: string;
  brCode: string;
  d: { variant: string; item: string; sku: string }; // discrete
  m: { variant: string; item: string; sku: string }; // measured
  writeTok: string;
  writeId: string;
  write2Tok: string;
  write2Id: string;
  readTok: string;
  user: string;
};

async function ownerDo<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: migrateUrl()! });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function build(tag: string): Promise<World> {
  const tenant = await ownerDo(async (o) => {
    const { rows } = await o.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [`Write API ${tag}`]);
    return rows[0]!.id;
  });
  tenants.push(tenant);
  const user = await ownerDo(async (o) => {
    const { rows } = await o.query<{ id: string }>(
      `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash)
       values ($1, $2, public.normalise_name($2), $3, 'owner', 'x') returning id`,
      [tenant, `منى ${tag}`, `own_${tag.toLowerCase()}`],
    );
    return rows[0]!.id;
  });
  const pool = await getAppPool();
  return withTenant(pool, tenant, async (db) => {
    const wh = await createLocation(db, { code: `WH-${tag}`, nameAr: `المخزن ${tag}`, type: 'warehouse' });
    const br = await createLocation(db, { code: `BR-${tag}`, nameAr: `فرع ${tag}`, type: 'branch' });
    const d = await createItem(db, { nameAr: `قميص ${tag}`, family: 'sellable', sku: `${tag}-D1`, barcode: `${tag}-BD1`, costEgp: 10 });
    const m = await createItem(db, { nameAr: `قماش ${tag}`, family: 'sellable', sku: `${tag}-M1`, barcode: `${tag}-BM1`, costEgp: 10, discrete: false });
    const w = await issueClient(db, { name: `Writer ${tag}`, scopes: ['write'] });
    const w2 = await issueClient(db, { name: `Writer Two ${tag}`, scopes: ['write'] });
    const r = await issueClient(db, { name: `Reader ${tag}`, scopes: ['read'] });
    for (const v of [d.variant.id, m.variant.id]) {
      await postMovement(db, { variantId: v, qty: 100, reason: 'opening_balance', toLocationId: wh.id, actorUserId: user });
    }
    return {
      tenant,
      wh: wh.id,
      br: br.id,
      whCode: wh.code,
      brCode: br.code,
      d: { variant: d.variant.id, item: d.item.id, sku: d.variant.sku },
      m: { variant: m.variant.id, item: m.item.id, sku: m.variant.sku },
      writeTok: w.token,
      writeId: w.id,
      write2Tok: w2.token,
      write2Id: w2.id,
      readTok: r.token,
      user,
    };
  });
}

let A: World;
let B: World;
const savedEnv = { db: process.env.APP_DATABASE_URL, tenant: process.env.TENANT_ID };

before(async () => {
  if (skip) return;
  process.env.APP_DATABASE_URL = sqlTestUrl();
  A = await build('A18');
  B = await build('B18');
  process.env.TENANT_ID = B.tenant; // must be ignored
});

after(async () => {
  if (savedEnv.db === undefined) delete process.env.APP_DATABASE_URL;
  else process.env.APP_DATABASE_URL = savedEnv.db;
  if (savedEnv.tenant === undefined) delete process.env.TENANT_ID;
  else process.env.TENANT_ID = savedEnv.tenant;
  if (tenants.length === 0 || !migrateUrl()) return;
  await ownerDo(async (o) => {
    await o.query('begin');
    await o.query(`set local session_replication_role = replica`);
    for (const t of ['domain_events', 'event_subscriptions', 'stock_movements', 'location_levels', 'item_variants', 'items', 'locations', 'api_clients', 'sessions', 'app_users']) {
      await o.query(`delete from ${t} where tenant_id = any($1)`, [tenants]);
    }
    await o.query(`delete from tenants where id = any($1)`, [tenants]);
    await o.query('commit');
  });
});

let keyN = 0;
const nextKey = (p = 'k') => `${p}-${process.pid}-${Date.now()}-${++keyN}`;

function post(token: string | undefined, body: unknown, o: { key?: string | null; ct?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (o.key !== null) headers['idempotency-key'] = o.key ?? nextKey();
  if (o.ct !== null) headers['content-type'] = o.ct ?? 'application/json';
  return postMovements(
    new Request('http://localhost/api/v1/movements', {
      method: 'POST',
      headers,
      body: o.raw ?? JSON.stringify(body),
    }),
  );
}

const get = (h: typeof getMovements, token: string, qs = '') =>
  h(new Request(`http://localhost/api/v1/movements${qs}`, { headers: { authorization: `Bearer ${token}` } }));

async function j(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

const sale = (w: World, over: Record<string, unknown> = {}) => ({
  variantId: w.d.variant,
  qty: '1',
  reason: 'sale',
  fromLocationId: w.wh,
  ...over,
});

async function events(tenant: string, type?: string): Promise<Array<{ type: string; payload: any }>> {
  return ownerDo(async (o) => {
    const { rows } = await o.query(
      `select type, payload from domain_events where tenant_id = $1 and ($2::text is null or type = $2) order by occurred_at, id`,
      [tenant, type ?? null],
    );
    return rows;
  });
}
const movementCount = (tenant: string, key?: string) =>
  ownerDo(async (o) => {
    const { rows } = await o.query(
      `select count(*)::int as n from stock_movements where tenant_id = $1 and ($2::text is null or idempotency_key like $2)`,
      [tenant, key ?? null],
    );
    return rows[0].n as number;
  });
const seqOf = (id: string) =>
  ownerDo(async (o) => (await o.query(`select seq::text s from stock_movements where id=$1`, [id])).rows[0].s as string);
const onHandQty = async (tenant: string, variant: string, loc: string) =>
  withTenant(await getAppPool(), tenant, async (db) =>
    String((await db.query(`select coalesce(sum(qty),0)::text q from on_hand where variant_id=$1 and location_id=$2`, [variant, loc])).rows[0].q),
  );

test('a write client posts a movement; it shows in on-hand and the ledger names the client as actor', { skip }, async () => {
  const before = await onHandQty(A.tenant, A.d.variant, A.wh);
  const res = await post(A.writeTok, sale(A, { qty: '3', notes: 'shop till 4' }));
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const b = await j(res);
  assert.match(b.data.id, /^[0-9a-f-]{36}$/);
  assert.equal(b.data.deduped, false);
  assert.equal(Number(before) - 3, Number(await onHandQty(A.tenant, A.d.variant, A.wh)));

  const oh = await j(await getOnHand(new Request('http://localhost/api/v1/on-hand', { headers: { authorization: `Bearer ${A.readTok}` } })));
  assert.ok(JSON.stringify(oh).includes(A.d.variant) || oh.data.length > 0);

  // ledger: actor type api_client, the client's NAME; user actor null in the DB
  const led = await j(await get(getMovements, A.readTok, `?variantId=${A.d.variant}&reason=sale`));
  const seq = await seqOf(b.data.id);
  const row = led.data.find((r: any) => r.seq === seq);
  assert.ok(row, 'posted movement visible on GET /movements');
  assert.equal(row.actor.type, 'api_client');
  assert.equal(row.actor.name, 'Writer A18');
  assert.equal(row.reason, 'sale');
  const db = await ownerDo(async (o) => (await o.query(`select actor_user_id, actor_api_client_id from stock_movements where id=$1`, [b.data.id])).rows[0]);
  assert.equal(db.actor_user_id, null);
  assert.equal(db.actor_api_client_id, A.writeId);
});

test('same Idempotency-Key + same content posts once and returns the FIRST id; changed content is 409', { skip }, async () => {
  const key = nextKey('idem');
  const body = sale(A, { qty: '2', refType: ' po ', refId: '11111111-1111-4111-8111-111111111111', notes: 'n' });
  const r1 = await post(A.writeTok, body, { key });
  const r2 = await post(A.writeTok, body, { key });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  const b1 = await j(r1);
  const b2 = await j(r2);
  assert.equal(b2.data.id, b1.data.id);
  assert.equal(b2.data.deduped, true);
  assert.equal(await movementCount(A.tenant, `api:${A.writeId}:${key}`), 1);

  // the same key with ANY content change is never answered with the old row as success
  for (const change of [{ qty: '3' }, { notes: 'other' }, { refType: 'GRN' }, { reason: 'consumption' }, { fromLocationId: A.br }, { variantId: A.m.variant, qty: '2' }, { refId: '22222222-2222-4222-8222-222222222222' }]) {
    const r = await post(A.writeTok, { ...body, ...change }, { key });
    assert.equal(r.status, 409, JSON.stringify(change));
    assert.equal((await j(r)).error.code, 'idempotency_conflict');
  }
  assert.equal(await movementCount(A.tenant, `api:${A.writeId}:${key}`), 1);
});

test('idempotency keys are namespaced by client: another client with the same key posts its OWN movement', { skip }, async () => {
  const key = nextKey('shared');
  const r1 = await post(A.writeTok, sale(A), { key });
  const r2 = await post(A.write2Tok, sale(A), { key });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.notEqual((await j(r1)).data.id, (await j(r2)).data.id);
  assert.equal(await movementCount(A.tenant, `api:%:${key}`), 2);
  // and a client can never reach another's by sending the stored form
  const r3 = await post(A.write2Tok, sale(A), { key: `api:${A.writeId}:${key}` });
  assert.equal(r3.status, 201);
  assert.equal(await movementCount(A.tenant, `api:${A.write2Id}:api:${A.writeId}:${key}`), 1);
});

test('20 PARALLEL identical requests post exactly ONE movement', { skip }, async () => {
  const key = nextKey('par');
  const rs = await Promise.all(Array.from({ length: 20 }, () => post(A.writeTok, sale(A, { qty: '1' }), { key })));
  const st = rs.map((r) => r.status).sort((x, y) => x - y);
  assert.deepEqual(st, [...Array(19).fill(200), 201]);
  const ids = new Set((await Promise.all(rs.map(j))).map((b) => b.data.id));
  assert.equal(ids.size, 1);
  assert.equal(await movementCount(A.tenant, `api:${A.writeId}:${key}`), 1);
  assert.equal((await events(A.tenant, 'movement.posted')).filter((e) => e.payload.movementId === [...ids][0]).length, 1);
});

test('20 PARALLEL sales of the LAST unit: exactly one succeeds; on-hand ends at 0, never negative', { skip }, async () => {
  const w = await withTenant(await getAppPool(), A.tenant, async (db) => {
    const it = await createItem(db, { nameAr: 'آخر قطعة', family: 'sellable', sku: 'A18-LAST', barcode: 'A18-BLAST', costEgp: 1 });
    await postMovement(db, { variantId: it.variant.id, qty: 1, reason: 'opening_balance', toLocationId: A.wh, actorUserId: A.user });
    return it.variant.id;
  });
  const rs = await Promise.all(Array.from({ length: 20 }, () => post(A.writeTok, { variantId: w, qty: '1', reason: 'sale', fromLocationId: A.wh })));
  const st = rs.map((r) => r.status);
  assert.equal(st.filter((s) => s === 201).length, 1, `statuses ${st.join(',')}`);
  assert.equal(st.filter((s) => s === 409).length, 19);
  assert.equal(await onHandQty(A.tenant, w, A.wh), '0.000');
});

test('insufficient stock is 409 naming the variant and location code, quantities as strings; nothing is written', { skip }, async () => {
  const n0 = await movementCount(A.tenant);
  const e0 = (await events(A.tenant)).length;
  const res = await post(A.writeTok, sale(A, { qty: '99999.5', variantId: A.m.variant }));
  assert.equal(res.status, 409);
  const e = (await j(res)).error;
  assert.equal(e.code, 'insufficient_stock');
  assert.equal(e.variantId, A.m.variant);
  assert.equal(e.location, A.whCode);
  assert.equal(typeof e.available, 'string');
  assert.equal(e.requested, '99999.5');
  assert.ok(e.message.includes(A.m.variant) && e.message.includes(A.whCode));
  assert.equal(await movementCount(A.tenant), n0);
  assert.equal((await events(A.tenant)).length, e0);
  // a location never touched has no row => zero => refused
  const res2 = await post(A.writeTok, sale(A, { fromLocationId: A.br }));
  assert.equal(res2.status, 409);
});

test('401 without a token, 403 for a read-only client, errors keep the standard headers', { skip }, async () => {
  const none = await post(undefined, sale(A));
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('cache-control'), 'no-store');
  const ro = await post(A.readTok, sale(A));
  assert.equal(ro.status, 403);
  assert.equal((await j(ro)).error.code, 'forbidden');
  const wr = await get(getMovements, A.writeTok);
  assert.equal(wr.status, 403); // write-only client cannot read
  const n = await get(getMovements, A.readTok);
  assert.equal(n.status, 200); // GET unchanged
});

test('every closed-list reason outside the allowlist is 403 reason_not_allowed; unknown is 400; allowed ones post', { skip }, async () => {
  assert.deepEqual([...API_ALLOWED_REASONS], ['sale', 'consumption', 'return_from_branch']);
  const denied = MOVEMENT_REASONS.filter((r) => !(API_ALLOWED_REASONS as readonly string[]).includes(r));
  assert.deepEqual([...denied].sort(), ['count_correction', 'issue_to_branch', 'opening_balance', 'receipt', 'transfer', 'write_off']);
  const n0 = await movementCount(A.tenant);
  for (const reason of denied) {
    const res = await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason, fromLocationId: A.wh, toLocationId: A.br });
    assert.equal(res.status, 403, reason);
    const e = (await j(res)).error;
    assert.equal(e.code, 'reason_not_allowed');
    assert.equal(e.field, 'reason');
  }
  assert.equal(await movementCount(A.tenant), n0);
  for (const reason of ['bogus', '', 'SALE', null, 5]) {
    const res = await post(A.writeTok, sale(A, { reason }));
    assert.equal(res.status, 400, String(reason));
  }
  assert.equal((await post(A.writeTok, sale(A, { reason: 'consumption' }))).status, 201);
  assert.equal((await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason: 'return_from_branch', fromLocationId: (await stockedLoc(A, 'branch', A.d.variant, 5)).id, toLocationCode: A.whCode.toLowerCase() })).status, 201);
  // a sale can never ADD stock, a return must name where it arrives
  assert.equal((await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason: 'sale', toLocationId: A.wh })).status, 422);
  assert.equal((await post(A.writeTok, sale(A, { toLocationId: A.br }))).status, 422);
  assert.equal((await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason: 'return_from_branch', fromLocationId: A.br })).status, 422);
});

test('qty must be an exact decimal STRING', { skip }, async () => {
  const badQty: unknown[] = [2, 1.5, 0, '0', '0.000', '-1', '1e3', '0x10', ' 5', '5 ', '5.', '.5', '+5', '1.2345', '1234567890', '1000000000', 'Infinity', 'NaN', '٣', '５', '', '1,5', null, true, [], {}, '007'];
  for (const qty of badQty) {
    const res = await post(A.writeTok, sale(A, { qty }));
    assert.equal(res.status, 400, `qty ${JSON.stringify(qty)}`);
    assert.equal((await j(res)).error.field, 'qty');
  }
  // whole numbers only for a discrete item; the ITEM decides
  const frac = await post(A.writeTok, sale(A, { qty: '1.5' }));
  assert.equal(frac.status, 422);
  assert.equal((await j(frac)).error.field, 'qty');
  const ok = await post(A.writeTok, sale(A, { variantId: A.m.variant, qty: '1.250' }));
  assert.equal(ok.status, 201);
  const exact = await ownerDo(async (o) => (await o.query(`select qty::text q from stock_movements where id=$1`, [(await j(ok)).data.id])).rows[0].q);
  assert.equal(exact, '1.250');
  assert.equal((await post(A.writeTok, sale(A, { qty: '2.000' }))).status, 201);
});

test('strict body: unknown keys, actor spoofing, pollution, content-type, size, JSON shape, idempotency header', { skip }, async () => {
  const unknown = async (k: string, v: unknown = 'x') => {
    const res = await post(A.writeTok, { ...sale(A), [k]: v });
    assert.equal(res.status, 400, k);
    const e = (await j(res)).error;
    assert.equal(e.code, 'invalid_parameter');
    assert.equal(e.field, k);
  };
  for (const k of ['quantiy', 'actor', 'actorUserId', 'actorApiClientId', 'tenantId', 'idempotencyKey', 'seq']) await unknown(k);
  const n0 = await movementCount(A.tenant);
  for (const raw of ['{"__proto__":{"actor":"x"},"variantId":"%V","qty":"1","reason":"sale","fromLocationId":"%W"}', '{"constructor":{"x":1},"variantId":"%V","qty":"1","reason":"sale","fromLocationId":"%W"}']) {
    const res = await post(A.writeTok, null, { raw: raw.replace('%V', A.d.variant).replace('%W', A.wh) });
    assert.equal(res.status, 400);
  }
  assert.equal(({} as any).actor, undefined);
  assert.equal(await movementCount(A.tenant), n0);
  // duplicate keys: last wins, never an extra movement or an actor override
  const dup = await post(A.writeTok, null, { raw: `{"variantId":"${A.d.variant}","qty":"9","qty":"1","reason":"sale","fromLocationId":"${A.wh}"}` });
  assert.equal(dup.status, 201);
  assert.equal(await movementCount(A.tenant), n0 + 1);

  for (const ct of [null, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonx', 'application/json; charset=latin1']) {
    const res = await post(A.writeTok, sale(A), { ct });
    assert.equal(res.status, 415, String(ct));
  }
  assert.equal((await post(A.writeTok, sale(A), { ct: 'application/json; charset=utf-8' })).status, 201);
  assert.equal((await post(A.writeTok, sale(A, { notes: 'x'.repeat(20000) }))).status, 413);
  assert.equal((await post(A.writeTok, sale(A, { notes: 'x'.repeat(501) }))).status, 400);
  for (const raw of ['{', '', 'null', '[]', '"str"', '5', 'true']) {
    assert.equal((await post(A.writeTok, null, { raw })).status, 400, raw);
  }
  for (const key of [null, '', 'short', 'a'.repeat(129), 'has space!', 'üüüüüüüüüü', 'a/b/c/d/e/f/g']) {
    const res = await post(A.writeTok, sale(A), { key });
    assert.equal(res.status, 400, String(key));
    assert.equal((await j(res)).error.code, 'invalid_parameter');
  }
  // variantId xor sku; locations id xor code; at least one side; not same
  for (const b of [{ ...sale(A), sku: A.d.sku }, { qty: '1', reason: 'sale', fromLocationId: A.wh }, sale(A, { fromLocationCode: A.whCode })]) {
    assert.equal((await post(A.writeTok, b)).status, 400);
  }
  assert.equal((await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason: 'consumption' })).status, 422);
  assert.equal((await post(A.writeTok, sale(A, { fromLocationId: 'nope' }))).status, 400);
});

test('occurredAt window (31 days back, 5 minutes ahead), refType/refId round trip', { skip }, async () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const day = 24 * 3600 * 1000;
  for (const [v, st] of [
    [iso(-2 * day), 201],
    [iso(-30 * day), 201],
    [iso(-32 * day), 400],
    [iso(10 * 60 * 1000), 400],
    [iso(60 * 1000), 201],
    ['2026-02-30T10:00:00Z', 400],
    ['2026-10-28', 400],
    ['2026-10-28T10:00:00', 400],
    ['yesterday', 400],
    [1234567890, 400],
  ] as const) {
    const res = await post(A.writeTok, sale(A, { occurredAt: v }));
    assert.equal(res.status, st, String(v));
  }
  const refId = '33333333-3333-4333-8333-333333333333';
  const r = await post(A.writeTok, sale(A, { refType: 'pos-receipt', refId, occurredAt: '2026-10-27T10:00:00+02:00' }));
  assert.equal(r.status, 201);
  const newId = (await j(r)).data.id;
  const led = await j(await get(getMovements, A.readTok, `?variantId=${A.d.variant}&reason=sale&limit=200`));
  const seq2 = await seqOf(newId);
  const row = led.data.find((x: any) => x.seq === seq2);
  assert.ok(row, 'visible via GET /movements');
  const stored = await ownerDo(async (o) => (await o.query(`select ref_type, ref_id, to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as t from stock_movements where ref_id=$1`, [refId])).rows[0]);
  assert.equal(stored.ref_type, 'POS-RECEIPT');
  assert.equal(stored.ref_id, refId);
  assert.equal(stored.t, '2026-10-27T08:00:00.000Z');
  for (const b of [{ refId: 'abc' }, { refType: '' }, { refType: 'x'.repeat(41) }, { refId: 7 }]) {
    assert.equal((await post(A.writeTok, sale(A, b))).status, 400, JSON.stringify(b));
  }
});

test('unknown / inactive variants and locations are 422 invalid_field naming the field', { skip }, async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [sale(A, { variantId: '99999999-9999-4999-8999-999999999999' }), 'variantId'],
    [{ sku: 'NOPE-123', qty: '1', reason: 'sale', fromLocationId: A.wh }, 'sku'],
    [sale(A, { fromLocationId: '99999999-9999-4999-8999-999999999999' }), 'fromLocationId'],
    [sale(A, { fromLocationId: undefined, fromLocationCode: 'NOPE' }), 'fromLocationCode'],
    [{ variantId: A.d.variant, qty: '1', reason: 'return_from_branch', fromLocationId: A.br, toLocationCode: 'NOPE' }, 'toLocationCode'],
  ];
  for (const [b, field] of cases) {
    const res = await post(A.writeTok, b);
    assert.equal(res.status, 422, field);
    const e = (await j(res)).error;
    assert.equal(e.code, 'invalid_field');
    assert.equal(e.field, field);
    assert.ok(e.message.length > 0);
  }
  // sku and location codes are normalised like the UI (trim + upper-case)
  const ok = await post(A.writeTok, { sku: `  ${A.d.sku.toLowerCase()} `, qty: '1', reason: 'sale', fromLocationCode: ` ${A.whCode.toLowerCase()}` });
  assert.equal(ok.status, 201);
  // inactive item / variant / location look exactly like unknown
  await ownerDo(async (o) => {
    await o.query(`update items set active=false where id=$1`, [A.m.item]);
  });
  const gone = await post(A.writeTok, sale(A, { variantId: A.m.variant }));
  assert.equal(gone.status, 422);
  assert.equal((await j(gone)).error.field, 'variantId');
  await ownerDo(async (o) => {
    await o.query(`update items set active=true where id=$1`, [A.m.item]);
    await o.query(`update item_variants set active=false where id=$1`, [A.m.variant]);
  });
  assert.equal((await post(A.writeTok, sale(A, { variantId: A.m.variant }))).status, 422);
  await ownerDo(async (o) => {
    await o.query(`update item_variants set active=true where id=$1`, [A.m.variant]);
    await o.query(`update locations set active=false where id=$1`, [A.br]);
  });
  const inactiveFrom = await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason: 'return_from_branch', fromLocationId: A.br, toLocationId: A.wh });
  assert.equal(inactiveFrom.status, 422);
  assert.equal((await j(inactiveFrom)).error.field, 'fromLocationId');
  assert.equal((await post(A.writeTok, sale(A, { fromLocationId: A.br }))).status, 422);
  await ownerDo((o) => o.query(`update locations set active=true where id=$1`, [A.br]));
});

test('movement.posted is emitted once, in the same transaction, with a safe string payload; dedupe emits none', { skip }, async () => {
  const key = nextKey('ev');
  const body = sale(A, { qty: '2', refType: 'pos', notes: 'secret-looking notes are NOT in events' });
  const e0 = (await events(A.tenant, 'movement.posted')).length;
  const r1 = await j(await post(A.writeTok, body, { key }));
  const r2 = await post(A.writeTok, body, { key }); // deduped replay
  assert.equal(r2.status, 200);
  const all = await events(A.tenant, 'movement.posted');
  assert.equal(all.length, e0 + 1, 'a deduped replay emits no second event');
  const ev = all.find((e) => e.payload.movementId === r1.data.id)!;
  const p = ev.payload;
  assert.equal(p.qty, '2');
  assert.equal(p.reason, 'sale');
  assert.equal(p.fromLocation, A.whCode);
  assert.equal(p.toLocation, null);
  assert.equal(p.variantId, A.d.variant);
  assert.equal(p.sku, A.d.sku);
  assert.deepEqual(p.actor, { type: 'api_client', name: 'Writer A18' });
  assert.match(p.seq, /^[0-9]+$/);
  assert.equal(typeof p.seq, 'string');
  const text = JSON.stringify(p);
  assert.ok(!text.includes(A.writeTok.slice(0, 12)));
  for (const needle of ['token', 'hash', 'password', '@', 'secret']) assert.ok(!text.toLowerCase().includes(needle), needle);
  assert.ok(!('notes' in p));
});

test('the movement and its event are atomic: a failure after the insert leaves NEITHER row', { skip }, async () => {
  const pool = await getAppPool();
  const key = nextKey('atomic');
  const n0 = await movementCount(A.tenant);
  const e0 = (await events(A.tenant)).length;
  await assert.rejects(
    withTenant(pool, A.tenant, (db) =>
      executeMovement(
        { db, body: {}, clientId: A.writeId, tenantId: A.tenant, idempotencyKey: key },
        parseMovementBody(sale(A)),
        { beforeCommit: async () => { throw new Error('boom after insert'); } },
      ),
    ),
    /boom after insert/,
  );
  assert.equal(await movementCount(A.tenant), n0);
  assert.equal((await events(A.tenant)).length, e0);
  assert.equal(await movementCount(A.tenant, `api:${A.writeId}:${key}`), 0);
  // an actor-less call is refused outright
  await assert.rejects(
    withTenant(pool, A.tenant, (db) =>
      executeMovement({ db, body: {}, clientId: '', tenantId: A.tenant, idempotencyKey: key }, parseMovementBody(sale(A))),
    ),
    /actor/,
  );
});

test('stock.low is EDGE-triggered: one event on the crossing, none while it stays below, again after a restock', { skip }, async () => {
  const { variant, item } = await withTenant(await getAppPool(), A.tenant, async (db) => {
    const it = await createItem(db, { nameAr: 'منتج حد أدنى', family: 'sellable', sku: 'A18-LOW', barcode: 'A18-BLOW', costEgp: 1 });
    await postMovement(db, { variantId: it.variant.id, qty: 20, reason: 'opening_balance', toLocationId: A.wh, actorUserId: A.user });
    await setLocationLevel(db, { itemId: it.item.id, locationId: A.wh, minQty: 5 });
    return { variant: it.variant.id, item: it.item.id };
  });
  const lows = async () => (await events(A.tenant, 'stock.low')).filter((e) => e.payload.itemId === item);
  const sell = async (qty: string) => assert.equal((await post(A.writeTok, { variantId: variant, qty, reason: 'sale', fromLocationId: A.wh })).status, 201);
  await sell('10'); // 20 -> 10, above 5
  assert.equal((await lows()).length, 0);
  await sell('5'); // 10 -> 5: at-or-below => FIRST event
  assert.equal((await lows()).length, 1);
  await sell('1'); // 4
  await sell('1'); // 3
  await sell('1'); // 2
  assert.equal((await lows()).length, 1, 'still below: no new event on every movement');
  const p = (await lows())[0]!.payload;
  assert.deepEqual([p.itemId, p.location, p.onHand, p.minQty], [item, A.whCode, '5.000', '5.000']);
  assert.equal(p.locationId, A.wh);
  // restock above the minimum, then cross again => a second event
  assert.equal((await post(A.writeTok, { variantId: variant, qty: '20', reason: 'return_from_branch', fromLocationId: (await stockedLoc(A, 'branch', variant, 30)).id, toLocationId: A.wh })).status, 201);
  assert.equal((await lows()).length, 1, 'a credit never emits');
  await sell('16'); // 22 -> 6, above
  assert.equal((await lows()).length, 1);
  await sell('3'); // 6 -> 3
  const two = await lows();
  assert.equal(two.length, 2);
  assert.equal(two[1]!.payload.onHand, '3.000');
  // a failed (refused) sale emits nothing
  assert.equal((await post(A.writeTok, { variantId: variant, qty: '100', reason: 'sale', fromLocationId: A.wh })).status, 409);
  assert.equal((await lows()).length, 2);
});

test('no minimum, or a location with no level, never emits stock.low', { skip }, async () => {
  const lows0 = (await events(A.tenant, 'stock.low')).length;
  const v = await withTenant(await getAppPool(), A.tenant, async (db) => {
    const it = await createItem(db, { nameAr: 'بدون حد', family: 'sellable', sku: 'A18-NOMIN', barcode: 'A18-BNOMIN', costEgp: 1 });
    await postMovement(db, { variantId: it.variant.id, qty: 3, reason: 'opening_balance', toLocationId: A.wh, actorUserId: A.user });
    await setLocationLevel(db, { itemId: it.item.id, locationId: A.wh, maxQty: 50 });
    return it.variant.id;
  });
  for (let i = 0; i < 3; i++) assert.equal((await post(A.writeTok, { variantId: v, qty: '1', reason: 'sale', fromLocationId: A.wh })).status, 201);
  assert.equal((await events(A.tenant, 'stock.low')).length, lows0);
});

test('cross-tenant: ids and codes of another tenant look like unknown; keys and events never cross', { skip }, async () => {
  const bad: Array<[Record<string, unknown>, string]> = [
    [sale(A, { variantId: B.d.variant }), 'variantId'],
    [{ sku: B.d.sku, qty: '1', reason: 'sale', fromLocationId: A.wh }, 'sku'],
    [sale(A, { fromLocationId: B.wh }), 'fromLocationId'],
    [sale(A, { fromLocationId: undefined, fromLocationCode: B.whCode }), 'fromLocationCode'],
  ];
  for (const [b, f] of bad) {
    const res = await post(A.writeTok, b);
    assert.equal(res.status, 422);
    assert.equal((await j(res)).error.field, f);
  }
  // B's client can post to B's world with the same key A used: independent
  const key = nextKey('xt');
  const a = await post(A.writeTok, sale(A), { key });
  const b = await post(B.writeTok, sale(B), { key });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual((await j(a)).data.id, (await j(b)).data.id);
  const evA = await events(A.tenant);
  const evB = await events(B.tenant);
  assert.ok(evB.length >= 1);
  const blob = (es: unknown) => JSON.stringify(es);
  for (const id of [B.d.variant, B.m.variant, B.wh, B.br, B.writeId, B.tenant, B.whCode]) assert.ok(!blob(evA).includes(id), `A's events leak ${id}`);  for (const id of [A.d.variant, A.m.variant, A.wh, A.br, A.writeId, A.tenant, A.whCode]) assert.ok(!blob(evB).includes(id), `B's events leak ${id}`);
});

test('events tables: tenant isolation as `authenticated`, append-only outbox, https-only subscriptions', { skip }, async () => {
  const pool = await getAppPool();
  const countAs = (tenant: string, table: string) =>
    withTenant(pool, tenant, async (db) => Number((await db.query(`select count(*) c from ${table}`)).rows[0].c));
  await withTenant(pool, A.tenant, (db) =>
    db.query(`insert into event_subscriptions (tenant_id, client_id, event_type, url) values ($1, $2, 'stock.low', 'https://example.test/hook')`, [A.tenant, A.writeId]),
  );
  assert.equal(await countAs(A.tenant, 'event_subscriptions'), 1);
  assert.equal(await countAs(B.tenant, 'event_subscriptions'), 0);
  const evA = await countAs(A.tenant, 'domain_events');
  const evB = await countAs(B.tenant, 'domain_events');
  assert.ok(evA > 0 && evB > 0);
  assert.equal(evA, (await events(A.tenant)).length);
  // B cannot write an event or a subscription into A, nor point at A's client
  await assert.rejects(withTenant(pool, B.tenant, (db) => db.query(`insert into domain_events (tenant_id, type, payload) values ($1, 'stock.low', '{}')`, [A.tenant])), /row-level security/);
  await assert.rejects(withTenant(pool, B.tenant, (db) => db.query(`insert into event_subscriptions (tenant_id, client_id, event_type, url) values ($1, $2, 'stock.low', 'https://x.test/h')`, [B.tenant, A.writeId])), /foreign key|violates/);
  // https only
  for (const url of ['http://x.test/h', 'ftp://x.test', 'https://', 'https://a b', 'javascript:alert(1)']) {
    await assert.rejects(withTenant(pool, A.tenant, (db) => db.query(`insert into event_subscriptions (tenant_id, client_id, event_type, url) values ($1, $2, 'stock.low', $3)`, [A.tenant, A.writeId, url])), /check/, url);
  }
  // append-only
  await assert.rejects(withTenant(pool, A.tenant, (db) => db.query(`delete from domain_events`)), /permission denied|append-only/);
  await assert.rejects(withTenant(pool, A.tenant, (db) => db.query(`update domain_events set payload = '{}'`)), /permission denied|append-only/);
  await assert.rejects(withTenant(pool, A.tenant, (db) => db.query(`update domain_events set type = 'stock.low'`)), /permission denied|append-only/);
  await assert.rejects(withTenant(pool, A.tenant, (db) => db.query(`truncate domain_events`)), /permission denied|append-only/);
  await withTenant(pool, A.tenant, (db) => db.query(`update domain_events set delivered_at = now() where id = (select id from domain_events limit 1)`));
  // the trigger (not just the grant) holds even for the owner
  await assert.rejects(ownerDo((o) => o.query(`update domain_events set payload = '{}' where tenant_id = $1`, [A.tenant])), /append-only/);
  await assert.rejects(ownerDo((o) => o.query(`delete from domain_events where tenant_id = $1`, [A.tenant])), /append-only/);
});

// ───────────────────────── review round 1: fixes pinned (written RED first) ─────────────────────────

type LocType = 'warehouse' | 'bin' | 'branch' | 'transit' | 'vendor' | 'scrap' | 'quarantine' | 'holder';
let locN = 0;
async function stockedLoc(w: World, type: LocType, variant: string, qty: number): Promise<{ id: string; code: string }> {
  return withTenant(await getAppPool(), w.tenant, async (db) => {
    const l = await createLocation(db, { code: `X${type.slice(0, 3).toUpperCase()}${++locN}-${process.pid % 1000}`, nameAr: `موقع ${type} ${locN}`, type } as any);
    if (qty > 0) await postMovement(db, { variantId: variant, qty, reason: 'opening_balance', toLocationId: l.id, actorUserId: w.user });
    return { id: l.id, code: l.code };
  });
}
const ret = (w: World, over: Record<string, unknown> = {}) => ({ variantId: w.d.variant, qty: '1', reason: 'return_from_branch', ...over });
const totalOnHand = async (w: World, variant: string) =>
  withTenant(await getAppPool(), w.tenant, async (db) => String((await db.query(`select coalesce(sum(qty),0)::text q from on_hand where variant_id=$1`, [variant])).rows[0].q));
const freshVariant = async (w: World, sku: string) =>
  withTenant(await getAppPool(), w.tenant, async (db) => {
    const it = await createItem(db, { nameAr: `صنف ${sku}`, family: 'sellable', sku, barcode: `B-${sku}`, costEgp: 1 });
    return { variant: it.variant.id, item: it.item.id };
  });

test('A: sale/consumption from transit, vendor, scrap, quarantine, holder, bin is 422 fromLocationId naming the allowed types; warehouse and branch work', { skip }, async () => {
  for (const reason of ['sale', 'consumption']) {
    for (const type of ['transit', 'vendor', 'scrap', 'quarantine', 'holder', 'bin'] as const) {
      const l = await stockedLoc(A, type, A.d.variant, 10);
      const n0 = await movementCount(A.tenant);
      const res = await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason, fromLocationId: l.id });
      assert.equal(res.status, 422, `${reason} from ${type}`);
      const e = (await j(res)).error;
      assert.equal(e.code, 'invalid_field');
      assert.equal(e.field, 'fromLocationId');
      assert.match(e.message, /warehouse/);
      assert.match(e.message, /branch/);
      assert.equal(await movementCount(A.tenant), n0);
      assert.equal(await onHandQty(A.tenant, A.d.variant, l.id), '10.000');
    }
    const br = await stockedLoc(A, 'branch', A.d.variant, 10);
    assert.equal((await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason, fromLocationId: A.wh })).status, 201, `${reason} wh`);
    assert.equal((await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason, fromLocationCode: br.code })).status, 201, `${reason} branch`);
  }
});

test('A: a return with NO source is refused and no stock appears', { skip }, async () => {
  const before = await totalOnHand(A, A.d.variant);
  const n0 = await movementCount(A.tenant);
  const res = await post(A.writeTok, ret(A, { qty: '1000', toLocationId: A.wh }));
  assert.equal(res.status, 422);
  const e = (await j(res)).error;
  assert.equal(e.code, 'invalid_field');
  assert.equal(e.field, 'fromLocationId');
  assert.equal(await totalOnHand(A, A.d.variant), before);
  assert.equal(await movementCount(A.tenant), n0);
});

test('A: a return must leave a BRANCH; from wh/bin/transit/vendor/scrap/quarantine/holder is 422 fromLocationId', { skip }, async () => {
  const to = await stockedLoc(A, 'quarantine', A.d.variant, 0);
  for (const type of ['warehouse', 'bin', 'transit', 'vendor', 'scrap', 'quarantine', 'holder'] as const) {
    const l = await stockedLoc(A, type, A.d.variant, 10);
    const res = await post(A.writeTok, ret(A, { fromLocationId: l.id, toLocationId: to.id }));
    assert.equal(res.status, 422, type);
    const e = (await j(res)).error;
    assert.equal(e.field, 'fromLocationId', type);
    assert.match(e.message, /branch/);
    assert.equal(await onHandQty(A.tenant, A.d.variant, l.id), '10.000');
  }
});

test('A: a return goes only INTO warehouse or quarantine; vendor/scrap/transit/holder/bin/branch are 422 toLocationId', { skip }, async () => {
  const from = await stockedLoc(A, 'branch', A.d.variant, 50);
  for (const type of ['vendor', 'scrap', 'transit', 'holder', 'bin', 'branch'] as const) {
    const l = await stockedLoc(A, type, A.d.variant, 0);
    const res = await post(A.writeTok, ret(A, { fromLocationId: from.id, toLocationId: l.id }));
    assert.equal(res.status, 422, type);
    const e = (await j(res)).error;
    assert.equal(e.field, 'toLocationId', type);
    assert.match(e.message, /warehouse/);
    assert.match(e.message, /quarantine/);
    assert.equal(await onHandQty(A.tenant, A.d.variant, l.id), '0');
  }
  assert.equal(await onHandQty(A.tenant, A.d.variant, from.id), '50.000');
  const q = await stockedLoc(A, 'quarantine', A.d.variant, 0);
  assert.equal((await post(A.writeTok, ret(A, { fromLocationId: from.id, toLocationId: A.wh }))).status, 201);
  assert.equal((await post(A.writeTok, ret(A, { fromLocationId: from.id, toLocationId: q.id }))).status, 201);
  assert.equal(await onHandQty(A.tenant, A.d.variant, from.id), '48.000');
  assert.equal(await onHandQty(A.tenant, A.d.variant, q.id), '1.000');
});

test('A: a return cannot send back more than the branch holds (409 insufficient_stock); nothing written', { skip }, async () => {
  const br = await stockedLoc(A, 'branch', A.d.variant, 3);
  const n0 = await movementCount(A.tenant);
  const res = await post(A.writeTok, ret(A, { qty: '4', fromLocationId: br.id, toLocationId: A.wh }));
  assert.equal(res.status, 409);
  assert.equal((await j(res)).error.code, 'insufficient_stock');
  assert.equal(await movementCount(A.tenant), n0);
  assert.equal(await onHandQty(A.tenant, A.d.variant, br.id), '3.000');
});

test('A/D2: from === to is refused by the API itself with its own message (by id, by code, mixed)', { skip }, async () => {
  const br = await stockedLoc(A, 'branch', A.d.variant, 5);
  const cases: Array<Record<string, unknown>> = [
    ret(A, { fromLocationId: br.id, toLocationId: br.id }),
    ret(A, { fromLocationCode: br.code, toLocationCode: br.code.toLowerCase() }),
    ret(A, { fromLocationId: br.id, toLocationCode: br.code }),
  ];
  for (const b of cases) {
    const res = await post(A.writeTok, b);
    assert.equal(res.status, 422);
    const e = (await j(res)).error;
    assert.match(e.message, /different locations/);
    assert.match(e.field, /^toLocation/);
  }
  assert.equal(await onHandQty(A.tenant, A.d.variant, br.id), '5.000');
});

test('A: 20 PARALLEL returns of the last unit: exactly one succeeds; branch ends at 0, never negative', { skip }, async () => {
  const { variant: v } = await freshVariant(A, 'A18-RLAST');
  const br = await stockedLoc(A, 'branch', v, 1);
  const rs = await Promise.all(Array.from({ length: 20 }, () => post(A.writeTok, { variantId: v, qty: '1', reason: 'return_from_branch', fromLocationId: br.id, toLocationId: A.wh })));
  const st = rs.map((r) => r.status);
  assert.equal(st.filter((s) => s === 201).length, 1, `statuses ${st.join(',')}`);
  assert.equal(st.filter((s) => s === 409).length, 19);
  assert.equal(await onHandQty(A.tenant, v, br.id), '0.000');
  assert.equal(await onHandQty(A.tenant, v, A.wh), '1.000');
});

test('B: a location at 999999999.000 can still be debited; a credit past 999999999.999 is 409 quantity_limit — never a 500', { skip }, async () => {
  const O = await build('OVF');
  const { variant, item } = await freshVariant(O, 'OVF-BIG');
  await ownerDo((o) =>
    o.query(
      `insert into stock_movements (tenant_id, variant_id, qty, reason, to_location_id, actor_user_id) values ($1,$2,'999999999.000','opening_balance',$3,$4)`,
      [O.tenant, variant, O.wh, O.user],
    ),
  );
  await withTenant(await getAppPool(), O.tenant, (db) => setLocationLevel(db, { itemId: item, locationId: O.wh, minQty: 5 }));
  const br = await stockedLoc(O, 'branch', variant, 10);
  const sell = (q: string) => post(O.writeTok, { variantId: variant, qty: q, reason: 'sale', fromLocationId: O.wh });
  const give = (q: string) => post(O.writeTok, { variantId: variant, qty: q, reason: 'return_from_branch', fromLocationId: br.id, toLocationId: O.wh });
  let res = await sell('1');
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(await onHandQty(O.tenant, variant, O.wh), '999999998.000');
  res = await give('2'); // 999999998 + 2 = 1e9 > 999999999.999
  assert.equal(res.status, 409);
  assert.equal((await j(res)).error.code, 'quantity_limit');
  assert.equal(await onHandQty(O.tenant, variant, br.id), '10.000', 'a refused credit moves nothing');
  res = await give('1'); // exactly 999999999.000
  assert.equal(res.status, 201);
  res = await give('1.000'); // 1000000000.000 would overflow
  assert.equal(res.status, 409);
  res = await sell('999999999');
  assert.equal(res.status, 201, 'a debit from a huge balance works');
  assert.equal(await onHandQty(O.tenant, variant, O.wh), '0.000');
});

test('C1: authenticated may UPDATE only domain_events.delivered_at (by privilege, not just by trigger)', { skip }, async () => {
  const q = (sql: string) => ownerDo(async (o) => (await o.query(sql)).rows[0].p as boolean);
  assert.equal(await q(`select has_table_privilege('authenticated','public.domain_events','UPDATE') p`), false);
  assert.equal(await q(`select has_column_privilege('authenticated','public.domain_events','delivered_at','UPDATE') p`), true);
  for (const c of ['payload', 'type', 'tenant_id', 'occurred_at', 'id']) {
    assert.equal(await q(`select has_column_privilege('authenticated','public.domain_events','${c}','UPDATE') p`), false, c);
  }
});

test('C2: delivered_at is write-once (NULL -> value only), for authenticated AND the owner', { skip }, async () => {
  const pool = await getAppPool();
  for (let i = 0; i < 3; i++) assert.equal((await post(A.writeTok, sale(A))).status, 201); // events to work on, independent of test order
  const { rows } = await ownerDo((o) => o.query(`select id from domain_events where tenant_id=$1 and delivered_at is null order by occurred_at limit 3`, [A.tenant]));
  const [e1, e2] = [rows[0].id as string, rows[1].id as string];
  await withTenant(pool, A.tenant, (db) => db.query(`update domain_events set delivered_at = now() where id=$1`, [e1]));
  await assert.rejects(withTenant(pool, A.tenant, (db) => db.query(`update domain_events set delivered_at = null where id=$1`, [e1])), /write-once/);
  await assert.rejects(withTenant(pool, A.tenant, (db) => db.query(`update domain_events set delivered_at = now() + interval '1 day' where id=$1`, [e1])), /write-once/);
  await ownerDo((o) => o.query(`update domain_events set delivered_at = now() where id=$1`, [e2]));
  await assert.rejects(ownerDo((o) => o.query(`update domain_events set delivered_at = null where id=$1`, [e2])), /write-once/);
  await assert.rejects(ownerDo((o) => o.query(`update domain_events set delivered_at = now() + interval '1 day' where id=$1`, [e2])), /write-once/);
  // a no-op rewrite of the same value is harmless
  await ownerDo((o) => o.query(`update domain_events set delivered_at = delivered_at where id=$1`, [e2]));
});

test('C3: subscription URLs refuse userinfo, loopback, private, link-local and IPv6-literal hosts; a normal https host is accepted', { skip }, async () => {
  const pool = await getAppPool();
  const ins = (url: string) =>
    withTenant(pool, A.tenant, (db) => db.query(`insert into event_subscriptions (tenant_id, client_id, event_type, url) values ($1, $2, 'stock.low', $3)`, [A.tenant, A.writeId, url]));
  const refused = [
    'https://a@b.com', 'https://user:pw@hooks.example.com/x', 'https://hooks.example.com@evil.com/',
    'https://localhost/x', 'https://LOCALHOST:8443/x', 'https://app.localhost/x', 'https://db.internal/x', 'https://printer.local/x', 'https://localhost./x',
    'https://127.0.0.1/x', 'https://127.1.2.3:9/x', 'https://0.0.0.0/x', 'https://0.1.2.3/x', 'https://10.0.0.5/x', 'https://10.255.255.255/',
    'https://100.64.0.1/x', 'https://100.127.255.255/x', 'https://169.254.169.254/latest/meta-data', 'https://172.16.0.1/x', 'https://172.31.255.255/x',
    'https://192.168.1.1/x', 'https://[::1]/x', 'https://[2001:db8::1]:8443/x', 'https://[::ffff:127.0.0.1]/x',
    'https://2130706433/x', 'https://0x7f000001/x', 'https://0177.0.0.1/x', 'https://127.1/x',
    'https://localhost\\.evil.com/x', 'https://999.1.1.1/x', 'https://1.256.3.4/x', 'https://1.2.256.4/x', 'https://1.2.3.256/x',
  ];
  for (const url of refused) await assert.rejects(ins(url), /check|violates/, url);
  for (const url of ['https://hooks.example.com/x', 'https://hooks.example.com:8443/a?b=c', 'https://8.8.8.8/x', 'https://100.63.0.1/x', 'https://172.15.0.1/x', 'https://172.32.0.1/x', 'https://192.169.0.1/x', 'https://localhost.example.com/x', 'https://internalfoo.example.com/x']) {
    await ins(url);
  }
});

test('D1: the same key with a different occurredAt is 409; the same occurredAt dedupes', { skip }, async () => {
  const key = nextKey('occ');
  const t1 = new Date(Date.now() - 3600_000).toISOString();
  const t2 = new Date(Date.now() - 7200_000).toISOString();
  assert.equal((await post(A.writeTok, sale(A, { occurredAt: t1 }), { key })).status, 201);
  assert.equal((await post(A.writeTok, sale(A, { occurredAt: t1 }), { key })).status, 200);
  const res = await post(A.writeTok, sale(A, { occurredAt: t2 }), { key });
  assert.equal(res.status, 409);
  assert.equal((await j(res)).error.code, 'idempotency_conflict');
});


test('B: 20 PARALLEL credits at the edge of the range: only the ones that fit succeed, never past 999999999.999', { skip }, async () => {
  const O = await build('OV2');
  const { variant } = await freshVariant(O, 'OV2-BIG');
  await ownerDo((o) =>
    o.query(`insert into stock_movements (tenant_id, variant_id, qty, reason, to_location_id, actor_user_id) values ($1,$2,'999999995.000','opening_balance',$3,$4)`, [O.tenant, variant, O.wh, O.user]),
  );
  // one branch per racer so the debit sides do not serialise the credits on the same lock
  const brs = await Promise.all(Array.from({ length: 20 }, () => stockedLoc(O, 'branch', variant, 1)));
  const rs = await Promise.all(brs.map((b) => post(O.writeTok, { variantId: variant, qty: '1', reason: 'return_from_branch', fromLocationId: b.id, toLocationId: O.wh })));
  const st = rs.map((r) => r.status);
  assert.equal(st.filter((s) => s === 201).length, 4, `statuses ${st.join(',')}`);
  assert.equal(st.filter((s) => s === 409).length, 16);
  assert.equal(await onHandQty(O.tenant, variant, O.wh), '999999999.000');
});

test('B: a ledger ALREADY past 1e9 at a location (owner inserts) is still debitable and never 500s; credits are 409 quantity_limit', { skip }, async () => {
  const O = await build('OV3');
  const { variant, item } = await freshVariant(O, 'OV3-HUGE');
  for (let i = 0; i < 2; i++) {
    await ownerDo((o) =>
      o.query(`insert into stock_movements (tenant_id, variant_id, qty, reason, to_location_id, actor_user_id) values ($1,$2,'999999999.000','opening_balance',$3,$4)`, [O.tenant, variant, O.wh, O.user]),
    );
  }
  await withTenant(await getAppPool(), O.tenant, (db) => setLocationLevel(db, { itemId: item, locationId: O.wh, minQty: 5 }));
  const br = await stockedLoc(O, 'branch', variant, 10);
  let res = await post(O.writeTok, { variantId: variant, qty: '1', reason: 'sale', fromLocationId: O.wh });
  assert.equal(res.status, 201, await res.clone().text());
  res = await post(O.writeTok, { variantId: variant, qty: '1', reason: 'consumption', fromLocationId: O.wh });
  assert.equal(res.status, 201);
  res = await post(O.writeTok, { variantId: variant, qty: '1', reason: 'return_from_branch', fromLocationId: br.id, toLocationId: O.wh });
  assert.equal(res.status, 409);
  assert.equal((await j(res)).error.code, 'quantity_limit');
  res = await post(O.writeTok, { variantId: variant, qty: '5000', reason: 'sale', fromLocationId: O.wh });
  assert.equal(res.status, 201);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('D4: the API debit WAITS for a UI-side guarded debit (postReturn) holding the same (variant, location) lock, then sees its effect: never negative', { skip }, async () => {
  const pool = await getAppPool();
  const { postReturn } = await import('@/modules/returns/index');
  const { variant } = await freshVariant(A, 'A18-RACE');
  const br = await stockedLoc(A, 'branch', variant, 1);
  let uiHolding!: () => void;
  const held = new Promise<void>((r) => (uiHolding = r));
  let uiCommit!: () => void;
  const gate = new Promise<void>((r) => (uiCommit = r));
  // the UI writer takes the last unit and keeps the pair lock (uncommitted) until we say so
  const ui = withTenant(pool, A.tenant, async (db) => {
    await postReturn(db, { variantId: variant, fromLocationId: br.id, qty: 1, disposition: 'restock', actorUserId: A.user, idempotencyKey: `ui-${process.pid}-${Date.now()}` });
    uiHolding();
    await gate;
  });
  await held;
  let apiDone = false;
  const api = withTenant(pool, A.tenant, (db2) =>
    executeMovement({ db: db2, clientId: A.writeId, tenantId: A.tenant, idempotencyKey: `race-${process.pid}-${Date.now()}`, body: {} }, parseMovementBody({ variantId: variant, qty: '1', reason: 'sale', fromLocationId: br.id })),
  ).then(
    (r) => ((apiDone = true), r),
    (e) => ((apiDone = true), e),
  );
  await sleep(500);
  const blocked = !apiDone;
  uiCommit(); // always release, so a failing assertion cannot leave the UI transaction (and the pool) hanging
  await ui;
  const out: any = await api;
  assert.equal(blocked, true, 'the API write must be blocked on the pair lock while the UI debit is uncommitted');
  assert.equal(out.status, 409, 'after the UI debit commits the API sees 0 and refuses');
  assert.equal(out.code, 'insufficient_stock');
  assert.equal(await onHandQty(A.tenant, variant, br.id), '0.000');
});

test('D5: the idempotency-key lock: a concurrent retry waits for the first commit and answers 200 deduped (without the lock it fails on the unique key)', { skip }, async () => {
  const pool = await getAppPool();
  const key = nextKey('d5');
  const mk = (db: any, hooks = {}) =>
    executeMovement({ db, clientId: A.writeId, tenantId: A.tenant, idempotencyKey: key, body: {} }, parseMovementBody(sale(A, { qty: '1' })), hooks);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inHook = new Promise<void>((r) => (entered = r));
  const t1 = withTenant(pool, A.tenant, (db) => mk(db, { beforeCommit: async () => { entered(); await gate; } }));
  await inHook;
  const t2 = withTenant(pool, A.tenant, (db) => mk(db)).then((r) => r, (e) => e);
  await sleep(400);
  release();
  const r1: any = await t1;
  const r2: any = await t2;
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200, String(r2?.message ?? ''));
  assert.deepEqual(r2.body.data, { id: r1.body.data.id, deduped: true });
  assert.equal(await movementCount(A.tenant, `api:${A.writeId}:${key}`), 1);
});
