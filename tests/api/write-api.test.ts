import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { Client } from 'pg';

import { issueClient } from '../../src/db/api-clients.ts';
import { getAppPool } from '../../src/db/app-pool.ts';
import { withTenant } from '../../src/db/client.ts';
import { createItem, setLocationLevel } from '../../src/db/items.ts';
import { createLocation } from '../../src/db/locations.ts';
import { postMovement } from '../../src/db/movements.ts';
import { MOVEMENT_REASONS } from '../../src/domain/movement.ts';
import { API_ALLOWED_REASONS, executeMovement, parseMovementBody } from '../../src/api/movements-write.ts';
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
  assert.equal((await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason: 'return_from_branch', toLocationCode: A.whCode.toLowerCase() })).status, 201);
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
    [{ variantId: A.d.variant, qty: '1', reason: 'return_from_branch', toLocationCode: 'NOPE' }, 'toLocationCode'],
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
  const inactiveLoc = await post(A.writeTok, { variantId: A.d.variant, qty: '1', reason: 'return_from_branch', toLocationId: A.br });
  assert.equal(inactiveLoc.status, 422);
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
  assert.equal((await post(A.writeTok, { variantId: variant, qty: '20', reason: 'return_from_branch', toLocationId: A.wh })).status, 201);
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
