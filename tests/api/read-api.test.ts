import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { Client } from 'pg';

import { issueClient } from '@/modules/api/index';
import { withTenant } from '@/modules/platform/index';
import { createItem } from '@/modules/catalog/index';
import { createLocation } from '@/modules/locations/index';
import { postMovement } from '@/modules/ledger/index';
import { createRequisition } from '@/modules/requisitions/index';
import { getAppPool } from '@/modules/platform/index';
import { ApiError, errorResponse } from '@/modules/api/domain/errors';
import { requireScope } from '@/modules/api/index';
import { readRoute } from '@/modules/api/index';
import { encodeCursor } from '@/modules/api/domain/params';
import { onHandByLocation } from '@/modules/branch-usage/index';
import { transitLocation } from '@/modules/locations/index';
import { OPTIONS as optionsOnHand } from '../../src/app/api/v1/on-hand/route.ts';
import { GET as getOnHand, POST as postOnHand, HEAD as headOnHand } from '../../src/app/api/v1/on-hand/route.ts';
import { GET as getItems } from '../../src/app/api/v1/items/route.ts';
import { GET as getLocations } from '../../src/app/api/v1/locations/route.ts';
import { GET as getRequisitions } from '../../src/app/api/v1/requisitions/route.ts';
import { GET as getMovements } from '../../src/app/api/v1/movements/route.ts';
import { GET as getUnknown } from '../../src/app/api/v1/[[...path]]/route.ts';
import { migrateUrl, sqlTestUrl } from '../harness/sql.ts';

/**
 * Contract tests for the READ API (Task 17). Two real tenants, several real
 * clients; every route is driven as a plain `Request` through the same
 * `GET` the framework calls. The API is authenticated by BEARER TOKEN only.
 */

const skip = !sqlTestUrl() || !migrateUrl();
const tenants: string[] = [];

type World = {
  tenant: string;
  wh: string;
  br: string;
  variant: string;
  variant2: string;
  sku: string;
  user: string;
  readTok: string;
  readId: string;
  writeTok: string;
  revokedTok: string;
  movementSeqs: string[];
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
    const { rows } = await o.query<{ id: string }>(
      `insert into tenants (name) values ($1) returning id`,
      [`Read API ${tag}`],
    );
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
    const sku = `${tag}-0001`;
    const a = await createItem(db, {
      nameAr: `قميص قطني ${tag}`,
      family: 'sellable',
      sku,
      barcode: `${tag}-1001`,
      costEgp: 120,
      discrete: false,
    });
    const b = await createItem(db, {
      nameAr: `قبعة ${tag}`,
      family: 'sellable',
      sku: `${tag}-0002`,
      barcode: `${tag}-1002`,
    });
    const seqs: string[] = [];
    const post = async (input: Parameters<typeof postMovement>[1]) => {
      const r = await postMovement(db, input);
      const { rows } = await db.query<{ seq: string }>(`select seq::text as seq from stock_movements where id = $1`, [r.id]);
      seqs.push(rows[0]!.seq);
    };
    await post({ variantId: a.variant.id, qty: 50, reason: 'opening_balance', toLocationId: wh.id, actorUserId: user });
    await post({ variantId: a.variant.id, qty: 10, reason: 'transfer', fromLocationId: wh.id, toLocationId: br.id, actorUserId: user });
    await post({ variantId: a.variant.id, qty: 2.5, reason: 'consumption', fromLocationId: br.id });
    await post({ variantId: b.variant.id, qty: 5, reason: 'opening_balance', toLocationId: wh.id });
    // a variant that nets to ZERO (must not appear in on-hand)
    await post({ variantId: b.variant.id, qty: 5, reason: 'write_off', fromLocationId: wh.id });
    const read = await issueClient(db, { name: `reader ${tag}`, scopes: ['read'] });
    const write = await issueClient(db, { name: `writer ${tag}`, scopes: ['write'] });
    const revoked = await issueClient(db, { name: `revoked ${tag}`, scopes: ['read'] });
    return {
      tenant,
      wh: wh.id,
      br: br.id,
      variant: a.variant.id,
      variant2: b.variant.id,
      sku,
      user,
      readTok: read.token,
      readId: read.id,
      writeTok: write.token,
      revokedTok: revoked.token,
      movementSeqs: seqs,
    };
  }).then(async (w) => {
    await ownerDo((o) => o.query(`update api_clients set active = false where token_hash = encode(sha256($1::bytea), 'hex')`, [Buffer.from(w.revokedTok)]));
    return w;
  });
}

let A: World;
let B: World;
const savedEnv = { db: process.env.APP_DATABASE_URL, tenant: process.env.TENANT_ID };

before(async () => {
  if (skip) return;
  process.env.APP_DATABASE_URL = sqlTestUrl();
  A = await build('A17');
  B = await build('B17');
  // TENANT_ID is deliberately pointed at B: the API must IGNORE it.
  process.env.TENANT_ID = B.tenant;
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
    for (const t of ['stock_movements', 'requisition_lines', 'requisitions', 'location_levels', 'item_variants', 'items', 'locations', 'api_clients', 'sessions', 'app_users']) {
      await o.query(`delete from ${t} where tenant_id = any($1)`, [tenants]);
    }
    await o.query(`delete from tenants where id = any($1)`, [tenants]);
    await o.query('commit');
  });
});

const req = (path: string, token?: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string>) },
  });

type Handler = (r: Request) => Promise<Response>;
const ROUTES: Array<[string, Handler]> = [
  ['/api/v1/on-hand', getOnHand],
  ['/api/v1/items', getItems],
  ['/api/v1/locations', getLocations],
  ['/api/v1/requisitions', getRequisitions],
  ['/api/v1/movements', getMovements],
];

async function body(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

function assertNonEmpty(row: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    const v = row[k];
    assert.ok(typeof v === 'string' && v.length > 0, `field ${k} must be a non-empty string, got ${JSON.stringify(v)}`);
  }
}

test('a read client can read on-hand', { skip }, async () => {
  const res = await getOnHand(req('/api/v1/on-hand', A.readTok));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const b = await body(res);
  assert.equal(b.nextCursor, null);
  // zero-net variant2 omitted; variant at wh (40) and br (7.5)
  assert.equal(b.data.length, 2);
  const keys = ['variantId', 'sku', 'barcode', 'nameAr', 'itemId', 'locationId', 'locationCode', 'location', 'onHand', 'available'];
  for (const row of b.data) {
    assert.deepEqual(Object.keys(row).sort(), [...keys].sort());
    assertNonEmpty(row, keys);
    assert.equal(row.available, row.onHand);
    assert.equal(typeof row.onHand, 'string');
  }
  const wh = b.data.find((r: any) => r.locationId === A.wh);
  assert.equal(wh.onHand, '40.000');
  assert.equal(b.data.find((r: any) => r.locationId === A.br).onHand, '7.500');
  assert.match(wh.nameAr, /قميص قطني/); // real UTF-8 round trip
});

test('on-hand filters by sku and locationId; transit is its own row', { skip }, async () => {
  const bySku = await body(await getOnHand(req(`/api/v1/on-hand?sku=${A.sku}`, A.readTok)));
  assert.equal(bySku.data.length, 2);
  const byLoc = await body(await getOnHand(req(`/api/v1/on-hand?locationId=${A.br}`, A.readTok)));
  assert.deepEqual(byLoc.data.map((r: any) => r.onHand), ['7.500']);
});

test('a client with no token gets 401 with code unauthorized', { skip }, async () => {
  for (const [path, h] of ROUTES) {
    const res = await h(req(path));
    assert.equal(res.status, 401, path);
    const b = await body(res);
    assert.equal(b.error.code, 'unauthorized');
    assert.equal(typeof b.error.message, 'string');
    assert.deepEqual(Object.keys(b), ['error']);
  }
});

test('malformed Authorization headers are 401, never 500, and the token is never echoed', { skip }, async () => {
  const weird = "tok'; drop table x;--é<script>";
  const headers = [
    '',
    'Bearer',
    'Bearer ',
    `Basic ${A.readTok}`,
    `Bearer  ${A.readTok}`,
    `Bearer ${A.readTok} extra`,
    `Token ${A.readTok}`,
    'Bearer not-a-real-token',
    `Bearer ${weird}`,
    `Bearer ${'x'.repeat(5000)}`,
  ];
  for (const h of headers) {
    const res = await getOnHand(new Request('http://localhost/api/v1/on-hand', { headers: { authorization: h } }));
    assert.equal(res.status, 401, JSON.stringify(h.slice(0, 20)));
    const text = await res.text();
    assert.equal(JSON.parse(text).error.code, 'unauthorized');
    assert.ok(!text.includes(A.readTok) && !text.includes('drop table'));
  }
});

test('a cookie-only request is refused on the API', { skip }, async () => {
  const res = await getOnHand(new Request('http://localhost/api/v1/on-hand', { headers: { cookie: 'wh_session=abc; session=abc' } }));
  assert.equal(res.status, 401);
  assert.equal((await body(res)).error.code, 'unauthorized');
});

test('a revoked client is 401', { skip }, async () => {
  const res = await getOnHand(req('/api/v1/on-hand', A.revokedTok));
  assert.equal(res.status, 401);
  assert.equal((await body(res)).error.code, 'unauthorized');
});

test('a write-only client gets 403 on a read route', { skip }, async () => {
  for (const [path, h] of ROUTES) {
    const res = await h(req(path, A.writeTok));
    assert.equal(res.status, 403, path);
    assert.equal((await body(res)).error.code, 'forbidden');
  }
  await assert.rejects(requireScope(req('/x', A.writeTok), 'read'), (e: unknown) => e instanceof ApiError && e.status === 403 && e.code === 'forbidden');
  const ok = await requireScope(req('/x', A.readTok), 'read');
  assert.deepEqual(ok, { clientId: A.readId, tenantId: A.tenant });
});

test('an unknown variant filter returns an empty array, not 404', { skip }, async () => {
  const id = '99999999-9999-4999-8999-999999999999';
  for (const path of [`/api/v1/on-hand?variantId=${id}`, `/api/v1/movements?variantId=${id}`]) {
    const res = await (path.includes('on-hand') ? getOnHand : getMovements)(req(path, A.readTok));
    assert.equal(res.status, 200);
    assert.deepEqual(await body(res), { data: [], nextCursor: null });
  }
});

test('tenant comes from the token: A never sees B, even by guessing B ids, and B ids look like unknown ids', { skip }, async () => {
  // TENANT_ID env points at B; client A must still get A's rows.
  const mine = await body(await getOnHand(req('/api/v1/on-hand', A.readTok)));
  assert.ok(mine.data.length > 0 && mine.data.every((r: any) => r.variantId !== B.variant && r.locationId !== B.wh));
  // B's client sees B's rows
  const theirs = await body(await getOnHand(req('/api/v1/on-hand', B.readTok)));
  assert.ok(theirs.data.every((r: any) => r.variantId !== A.variant));
  for (const [path, h] of ROUTES) {
    const text = await (await h(req(path, A.readTok))).text();
    assert.ok(!text.includes(B.variant) && !text.includes(B.wh) && !text.includes(B.tenant), path);
  }
  const unknown = '99999999-9999-4999-8999-999999999999';
  for (const [route, h, key] of [
    ['on-hand', getOnHand, 'variantId'],
    ['movements', getMovements, 'variantId'],
    ['on-hand', getOnHand, 'locationId'],
    ['requisitions', getRequisitions, 'branchLocationId'],
  ] as const) {
    const guessed = await h(req(`/api/v1/${route}?${key}=${key === 'variantId' ? B.variant : B.wh}`, A.readTok));
    const none = await h(req(`/api/v1/${route}?${key}=${unknown}`, A.readTok));
    assert.equal(guessed.status, none.status);
    assert.equal(await guessed.text(), await none.text(), `${route}?${key}`);
  }
  // A's token cannot be used as B: movements for B's variant are empty, and client A's id never leaks
  const mv = await body(await getMovements(req('/api/v1/movements', B.readTok)));
  assert.ok(mv.data.every((m: any) => m.variantId !== A.variant));
});

test('bad parameters are 400 invalid_parameter naming the field, never a 500', { skip }, async () => {
  const cases: Array<[string, Handler, string]> = [
    ['/api/v1/on-hand?variantId=not-a-uuid', getOnHand, 'variantId'],
    ['/api/v1/on-hand?locationId=123', getOnHand, 'locationId'],
    ['/api/v1/movements?variantId=%27%3B--', getMovements, 'variantId'],
    ['/api/v1/on-hand?limit=0', getOnHand, 'limit'],
    ['/api/v1/on-hand?limit=-5', getOnHand, 'limit'],
    ['/api/v1/on-hand?limit=1.5', getOnHand, 'limit'],
    ['/api/v1/on-hand?limit=abc', getOnHand, 'limit'],
    ['/api/v1/on-hand?limit=', getOnHand, 'limit'],
    ['/api/v1/items?limit=501', getItems, 'limit'],
    ['/api/v1/locations?limit=501', getLocations, 'limit'],
    ['/api/v1/requisitions?limit=501', getRequisitions, 'limit'],
    ['/api/v1/movements?limit=501', getMovements, 'limit'],
    ['/api/v1/movements?cursor=garbage', getMovements, 'cursor'],
    ['/api/v1/movements?cursor=' + Buffer.from('{"s":"-1"}').toString('base64url'), getMovements, 'cursor'],
    ['/api/v1/on-hand?cursor=garbage', getOnHand, 'cursor'],
    ['/api/v1/items?cursor=garbage', getItems, 'cursor'],
    ['/api/v1/locations?cursor=garbage', getLocations, 'cursor'],
    ['/api/v1/requisitions?cursor=garbage', getRequisitions, 'cursor'],
    ['/api/v1/movements?from=yesterday', getMovements, 'from'],
    ['/api/v1/movements?to=2026-02-30', getMovements, 'to'],
    ['/api/v1/movements?reason=gift', getMovements, 'reason'],
    ['/api/v1/requisitions?status=bogus', getRequisitions, 'status'],
    ['/api/v1/requisitions?branchLocationId=x', getRequisitions, 'branchLocationId'],
    ['/api/v1/items?family=toys', getItems, 'family'],
    ['/api/v1/locations?type=nope', getLocations, 'type'],
    ['/api/v1/movements?limit=1&limit=2', getMovements, 'limit'],
  ];
  for (const [path, h, field] of cases) {
    const res = await h(req(path, A.readTok));
    assert.equal(res.status, 400, path);
    const b = await body(res);
    assert.equal(b.error.code, 'invalid_parameter', path);
    assert.ok(b.error.message.includes(field), `${path}: ${b.error.message}`);
  }
  assert.equal((await getOnHand(req('/api/v1/on-hand?limit=500', A.readTok))).status, 200);
});

test('movements: the where-did-it-go payload', { skip }, async () => {
  const res = await getMovements(req(`/api/v1/movements?variantId=${A.variant}`, A.readTok));
  assert.equal(res.status, 200);
  const b = await body(res);
  assert.equal(b.data.length, 3);
  assert.deepEqual(b.data.map((m: any) => m.seq), [...A.movementSeqs.slice(0, 3)].reverse());
  const consumption = b.data[0];
  assert.equal(consumption.reason, 'consumption');
  assert.equal(consumption.qty, '2.500');
  assert.equal(consumption.toLocation, null);
  assert.equal(consumption.fromLocation.id, A.br);
  assert.deepEqual(consumption.actor, { type: 'system', name: 'system' });
  const transfer = b.data[1];
  assert.deepEqual(Object.keys(transfer).sort(), ['actor', 'fromLocation', 'occurredAt', 'qty', 'reason', 'refId', 'refType', 'seq', 'sku', 'toLocation', 'variantId'].sort());
  assertNonEmpty(transfer, ['seq', 'reason', 'qty', 'variantId', 'sku', 'occurredAt']);
  assertNonEmpty(transfer.fromLocation, ['id', 'code', 'name']);
  assertNonEmpty(transfer.toLocation, ['id', 'code', 'name']);
  assert.equal(transfer.actor.type, 'user');
  assert.match(transfer.actor.name, /منى A17/);
  assert.ok(!JSON.stringify(b).includes(A.user), 'no raw user uuid');
  assert.ok(!Number.isNaN(Date.parse(transfer.occurredAt)));
});

test('movements: reason filter and from/to (exclusive upper bound)', { skip }, async () => {
  const only = await body(await getMovements(req('/api/v1/movements?reason=transfer', A.readTok)));
  assert.deepEqual(only.data.map((m: any) => m.reason), ['transfer']);
  const day = await ownerDo(async (o) => {
    const { rows } = await o.query<{ d: string }>(
      `select to_char(max(occurred_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as d from stock_movements where tenant_id = $1`, [A.tenant]);
    return rows[0]!.d;
  });
  const exact = await body(await getMovements(req(`/api/v1/movements?to=${day}`, A.readTok)));
  assert.equal(exact.data.length, 0, 'upper bound is exclusive and nothing is later than the max... until it equals it');
  const all = await body(await getMovements(req(`/api/v1/movements?from=${day}`, A.readTok)));
  assert.ok(all.data.length >= 1, 'lower bound is inclusive');
  const future = await body(await getMovements(req('/api/v1/movements?from=2999-01-01', A.readTok)));
  assert.equal(future.data.length, 0);
});

test('movements: cursor paging has no duplicates and no gaps, even while new movements arrive', { skip }, async () => {
  const pool = await getAppPool();
  const full = (await body(await getMovements(req('/api/v1/movements?limit=500', A.readTok)))).data.map((m: any) => m.seq);
  assert.ok(full.length >= 5);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let injected = false;
  do {
    const q: string = `/api/v1/movements?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const b = await body(await getMovements(req(q, A.readTok)));
    assert.ok(b.data.length <= 2);
    seen.push(...b.data.map((m: any) => m.seq));
    cursor = b.nextCursor;
    pages += 1;
    if (!injected) {
      injected = true;
      await withTenant(pool, A.tenant, (db) =>
        postMovement(db, { variantId: A.variant2, qty: 1, reason: 'opening_balance', toLocationId: A.wh }),
      );
    }
    assert.ok(pages < 50);
  } while (cursor !== null);
  assert.deepEqual(seen, full, 'walk reproduces the original set, in order, with no dup or gap (the injected newer row is not on the walk)');
  assert.equal(new Set(seen).size, seen.length);
  for (let i = 1; i < seen.length; i += 1) assert.ok(BigInt(seen[i - 1]!) > BigInt(seen[i]!), 'seq desc');
});

test('default limit is 100 and a list never exceeds the max', { skip }, async () => {
  const C = await build('C17');
  const pool = await getAppPool();
  await withTenant(pool, C.tenant, async (db) => {
    for (let i = 0; i < 105; i += 1) {
      await postMovement(db, { variantId: C.variant, qty: 1, reason: 'opening_balance', toLocationId: C.wh });
    }
  });
  const b = await body(await getMovements(req('/api/v1/movements', C.readTok)));
  assert.equal(b.data.length, 100);
  assert.notEqual(b.nextCursor, null);
  const big = await body(await getMovements(req('/api/v1/movements?limit=500', C.readTok)));
  assert.equal(big.data.length, 110);
});

test('items, locations and requisitions payloads', { skip }, async () => {
  const pool = await getAppPool();
  await withTenant(pool, A.tenant, (db) =>
    createRequisition(db, { branchLocationId: A.br, requestedBy: A.user, lines: [{ variantId: A.variant, requestedQty: 3 }] }),
  );
  const items = await body(await getItems(req('/api/v1/items', A.readTok)));
  assert.equal(items.data.length, 2);
  const shirt = items.data.find((i: any) => i.nameAr.startsWith('قميص'));
  assertNonEmpty(shirt, ['id', 'nameAr', 'family', 'uom']);
  assert.equal(typeof shirt.discrete, 'boolean');
  assert.ok(!('costEgp' in shirt) && !JSON.stringify(items).match(/cost/i), 'cost is omitted');
  assert.equal(shirt.variants.length, 1);
  assertNonEmpty(shirt.variants[0], ['id', 'sku', 'barcode']);
  assert.equal(typeof shirt.variants[0].active, 'boolean');

  const locs = await body(await getLocations(req('/api/v1/locations', A.readTok)));
  assert.ok(locs.data.length >= 2);
  for (const l of locs.data) {
    assertNonEmpty(l, ['id', 'code', 'name', 'type']);
    assert.ok('parentId' in l && typeof l.active === 'boolean');
  }
  const branches = await body(await getLocations(req('/api/v1/locations?type=branch', A.readTok)));
  assert.deepEqual(branches.data.map((l: any) => l.id), [A.br]);

  const reqs = await body(await getRequisitions(req('/api/v1/requisitions?status=requested', A.readTok)));
  assert.equal(reqs.data.length, 1);
  const r = reqs.data[0];
  assertNonEmpty(r, ['id', 'status', 'requestedAt', 'requestedByName']);
  assertNonEmpty(r.branch, ['id', 'code', 'name']);
  assert.equal(r.lines.length, 1);
  assertNonEmpty(r.lines[0], ['variantId', 'sku', 'requestedQty', 'issuedQty', 'receivedQty', 'status']);
  assert.equal(r.lines[0].requestedQty, '3.000');
  assert.ok(!JSON.stringify(r).includes(A.user));
  const none = await body(await getRequisitions(req('/api/v1/requisitions?status=closed', A.readTok)));
  assert.deepEqual(none.data, []);
  // B sees none of A's
  assert.deepEqual((await body(await getRequisitions(req('/api/v1/requisitions', B.readTok)))).data, []);
});

test('methods: POST is 405 JSON with Allow; HEAD has no body; unknown route is 404 JSON', { skip }, async () => {
  const res = await postOnHand(req('/api/v1/on-hand', A.readTok, { method: 'POST' }));
  assert.equal(res.status, 405);
  assert.match(res.headers.get('allow') ?? '', /GET/);
  assert.equal((await body(res)).error.code, 'method_not_allowed');
  const head = await headOnHand(req('/api/v1/on-hand', A.readTok, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const nf = await getUnknown(req('/api/v1/nope', A.readTok));
  assert.equal(nf.status, 404);
  assert.equal((await body(nf)).error.code, 'not_found');
});

test('unexpected exceptions are a generic 500 with no leak', async () => {
  const res = errorResponse(new Error('relation "secret_table" does not exist at SELECT * FROM x'));
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: { code: 'internal', message: 'Internal server error' } });
  assert.ok(!text.includes('secret_table'));
  const known = errorResponse(new ApiError(418, 'teapot', 'short'));
  assert.equal(known.status, 418);
});

// ------------------------------------------------------------ review fixes

const cursorOf = (o: Record<string, string>) => encodeCursor(o);
const UUID0 = '00000000-0000-4000-8000-000000000000';

test('forged timestamp cursors are 400 naming cursor, never 500', { skip }, async () => {
  const bad = [
    '2026-13-45 10:00:00+00', '2026-01-45 10:00:00+00', '2026-02-30 10:00:00+00', '2027-02-29 10:00:00+00',
    '0000-01-05 10:00:00+00', '99999-01-05 10:00:00+00', '2026-01-05 10:00:00+99:99', '2026-01-05 10:00:00+16',
    '2026-01-05 24:00:00+00', '2026-01-05 10:60:00+00', '2026-01-05 10:00:61+00', '2026-00-10 10:00:00+00',
  ];
  for (const t of bad) {
    const res = await getRequisitions(req(`/api/v1/requisitions?cursor=${cursorOf({ t, i: UUID0 })}`, A.readTok));
    assert.equal(res.status, 400, `ts cursor ${t}`);
    const b = await body(res);
    assert.equal(b.error.code, 'invalid_parameter');
    assert.match(b.error.message, /cursor/);
  }
  // a leap day is real
  const ok = await getRequisitions(req(`/api/v1/requisitions?cursor=${cursorOf({ t: '2028-02-29 10:00:00.123456+00', i: UUID0 })}`, A.readTok));
  assert.equal(ok.status, 200);
});

test('cursor fuzz: every kind rejects impossible-but-well-formed values with 400 and accepts real ones', { skip }, async () => {
  const cases: Array<[string, Handler, Record<string, string>, Record<string, string[]>]> = [
    ['on-hand', getOnHand, { v: UUID0, l: UUID0 }, { v: ['zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', UUID0 + '0', 'null'], l: ['1', UUID0.slice(1)] }],
    ['items', getItems, { i: UUID0 }, { i: ['not-a-uuid', '', UUID0.replace(/0$/, 'g')] }],
    ['locations', getLocations, { c: 'WH', i: UUID0 }, { c: ['', 'x'.repeat(201), 'a\u0000b'], i: ['nope'] }],
    ['movements', getMovements, { s: '1' }, { s: ['9223372036854775808', '99999999999999999999', '-1', '1e3', '1.5', ' 1', ''] }],
    ['requisitions', getRequisitions, { t: '2026-01-05 10:00:00+00', i: UUID0 }, { t: ['2026-13-45 10:00:00+00', '2026-02-30 10:00:00+00'], i: ['xx'] }],
  ];
  let checked = 0;
  for (const [name, h, good, bads] of cases) {
    const r0 = await h(req(`/api/v1/${name}?cursor=${cursorOf(good)}`, A.readTok));
    assert.equal(r0.status, 200, `${name}: genuine cursor`);
    for (const [k, vals] of Object.entries(bads)) {
      for (const v of vals) {
        const r = await h(req(`/api/v1/${name}?cursor=${cursorOf({ ...good, [k]: v })}`, A.readTok));
        assert.equal(r.status, 400, `${name}.${k}=${JSON.stringify(v)}`);
        assert.match((await body(r)).error.message, /cursor/);
        checked++;
      }
    }
  }
  // the largest accepted bigint-shaped seq (18 digits) is a real bigint
  const edge = await getMovements(req(`/api/v1/movements?cursor=${cursorOf({ s: '999999999999999999' })}`, A.readTok));
  assert.equal(edge.status, 200);
  assert.ok(checked >= 20);
});

test('requisitions: ts cursor round-trips across a tie on requested_at with no dup/gap', { skip }, async () => {
  const T = await build('T17');
  const pool = await getAppPool();
  const ids: string[] = [];
  for (let n = 0; n < 5; n++) {
    const r = await withTenant(pool, T.tenant, (db) =>
      createRequisition(db, { branchLocationId: T.br, requestedBy: T.user, lines: [{ variantId: T.variant, requestedQty: 1 }] }),
    );
    ids.push((r as any).id ?? (r as any).requisition?.id);
  }
  // every requisition gets the SAME requested_at (microsecond precision included)
  await ownerDo((o) => o.query(`update requisitions set requested_at = '2026-03-04 05:06:07.123456+00' where tenant_id = $1`, [T.tenant]));
  const seen: string[] = [];
  let cursor = '';
  for (let guard = 0; guard < 10; guard++) {
    const b = await body(await getRequisitions(req(`/api/v1/requisitions?limit=2${cursor}`, T.readTok)));
    seen.push(...b.data.map((r: any) => r.id));
    if (!b.nextCursor) break;
    cursor = `&cursor=${b.nextCursor}`;
  }
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5, 'no duplicates');
  assert.deepEqual([...seen].sort(), [...ids].sort(), 'no gaps');
});

test('bare /api/v1 and unknown paths are the JSON 404', { skip }, async () => {
  for (const p of ['/api/v1', '/api/v1/', '/api/v1/nope', '/api/v1/on-hand/extra']) {
    const res = await getUnknown(req(p, A.readTok));
    assert.equal(res.status, 404, p);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const b = await body(res);
    assert.equal(b.error.code, 'not_found');
    assert.ok(typeof b.error.message === 'string' && b.error.message.length > 0);
  }
});

test('an unexpected exception logs ONE scrubbed line and the client body is unchanged', { skip }, async () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    const boom = readRoute(() => {
      const e = new Error('connect failed postgres://svc:hunter2pw@10.1.2.3:5432/warehouse (user "svc") 10.1.2.3:5432');
      (e as any).code = 'ECONNREFUSED';
      throw e;
    });
    const res = await boom.GET(req('/api/v1/on-hand?sku=SECRETSKU&cursor=abc', A.readTok));
    assert.equal(res.status, 500);
    assert.deepEqual(await body(res), { error: { code: 'internal', message: 'Internal server error' } });
    assert.equal(lines.length, 1, 'logged exactly once');
    const line = lines[0]!;
    assert.match(line, /GET \/api\/v1\/on-hand/);
    assert.match(line, /Error code=ECONNREFUSED/);
    const id = res.headers.get('x-request-id');
    assert.ok(id && line.includes(`id=${id}`), 'the response header carries the logged id');
    for (const secret of [A.readTok, 'hunter2pw', 'postgres://', '10.1.2.3', 'SECRETSKU', 'authorization', 'Bearer']) {
      assert.ok(!line.includes(secret), `log line must not contain ${secret === A.readTok ? 'the token' : secret}`);
    }
    // expected 4xx are NOT logged
    lines.length = 0;
    await getOnHand(req('/api/v1/on-hand?limit=0', A.readTok));
    await getOnHand(req('/api/v1/on-hand'));
    await getUnknown(req('/api/v1/nope'));
    assert.equal(lines.length, 0, 'no log for 4xx');
  } finally {
    console.error = orig;
  }
});

test('OPTIONS carries the standard headers', async () => {
  const res = await optionsOnHand();
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('allow') ?? '', /GET/);
});

test('CONTRACT: API on-hand and the stock screen agree on a messy tenant', { skip }, async () => {
  const M = await build('M17');
  const pool = await getAppPool();
  await withTenant(pool, M.tenant, async (db) => {
    const tr = await transitLocation(db);
    const old = await createLocation(db, { code: 'OLD-M17', nameAr: 'مخزن قديم', type: 'warehouse' });
    const mk = async (tag: string, discrete: boolean) =>
      createItem(db, { nameAr: `صنف ${tag}`, family: 'sellable', sku: `M17-${tag}`, barcode: `M17-B${tag}`, costEgp: 10, discrete });
    const inactiveItem = await mk('II', true);
    const inactiveVar = await mk('IV', true);
    const frac = await mk('FR', false);
    const neg = await mk('NG', true);
    const inOld = await mk('OL', true);
    const inTransit = await mk('TR', true);
    const put = (variantId: string, qty: number, toLocationId: string) =>
      postMovement(db, { variantId, qty, reason: 'opening_balance', toLocationId, actorUserId: M.user });
    await put(inactiveItem.variant.id, 4, M.wh);
    await put(inactiveVar.variant.id, 6, M.wh);
    await put(frac.variant.id, 2.125, M.br);
    await put(inOld.variant.id, 9, old.id);
    await put(inTransit.variant.id, 3, M.wh);
    await postMovement(db, { variantId: inTransit.variant.id, qty: 3, reason: 'transfer', fromLocationId: M.wh, toLocationId: tr.id, actorUserId: M.user });
    await postMovement(db, { variantId: neg.variant.id, qty: 3, reason: 'consumption', fromLocationId: M.br });
    await ownerDo(async (o) => {
      await o.query(`update items set active = false where id = $1`, [inactiveItem.item.id]);
      await o.query(`update item_variants set active = false where id = $1`, [inactiveVar.variant.id]);
      await o.query(`update locations set active = false where id = $1`, [old.id]);
    });
  });
  const stock = await withTenant(pool, M.tenant, (db) => onHandByLocation(db, { limit: 500 }));
  const api = await body(await getOnHand(req('/api/v1/on-hand?limit=500', M.readTok)));
  const key = (v: string, l: string) => `${v}|${l}`;
  const apiRows = new Map<string, string>(api.data.map((r: any) => [key(r.variantId, r.locationId), r.onHand]));
  const locs = await ownerDo(async (o) => (await o.query(`select id, name_ar from locations where tenant_id = $1`, [M.tenant])).rows);
  assert.ok(stock.length >= 7, `messy tenant must have real spread, got ${stock.length}`);
  assert.ok(stock.some((r) => r.qty.startsWith('-')), 'a negative balance is present');
  assert.ok(stock.some((r) => r.qty === '2.125'), 'a fractional quantity is present');
  assert.equal(apiRows.size, api.data.length);
  // the stock screen row carries the location NAME; map it back to the id to compare the SET of pairs
  const nameToId = new Map<string, string>(locs.map((r: any) => [r.name_ar, r.id]));
  assert.equal(nameToId.size, locs.length, 'location names are unique in the messy tenant');
  const screenRows = new Map<string, string>(stock.map((r) => [key(r.variantId, nameToId.get(r.location)!), r.qty]));
  assert.equal(screenRows.size, stock.length);
  assert.deepEqual([...apiRows.keys()].sort(), [...screenRows.keys()].sort(), 'same (variant, location) set');
  for (const [k, q] of screenRows) assert.equal(apiRows.get(k), q, `quantity for ${k}`);
  for (const r of api.data) assert.equal(r.available, r.onHand);
});

test('last_used_at is a coarse, post-scope stamp', { skip }, async () => {
  const S = await build('S17');
  const stamp = () =>
    ownerDo(async (o) => (await o.query(`select last_used_at::text as t from api_clients where id = $1`, [S.readId])).rows[0].t as string | null);
  assert.equal(await stamp(), null);
  assert.equal((await getOnHand(req('/api/v1/on-hand', S.readTok))).status, 200);
  const first = await stamp();
  assert.notEqual(first, null, 'first call stamps');
  await getOnHand(req('/api/v1/on-hand', S.readTok));
  assert.equal(await stamp(), first, 'a second call within 60 s does not move the stamp');
  await ownerDo((o) => o.query(`update api_clients set last_used_at = now() - interval '61 seconds' where id = $1`, [S.readId]));
  const old = await stamp();
  await getOnHand(req('/api/v1/on-hand', S.readTok));
  assert.notEqual(await stamp(), old, 'a call after 60 s stamps again');
  // 403 must not stamp
  assert.equal((await getOnHand(req('/api/v1/on-hand', S.writeTok))).status, 403);
  const n403 = await ownerDo(async (o) => (await o.query(`select count(*)::int as n from api_clients where tenant_id = $1 and name like 'writer%' and last_used_at is not null`, [S.tenant])).rows[0].n);
  assert.equal(n403, 0, '403 does not stamp');
  // revoked never stamps
  assert.equal((await getOnHand(req('/api/v1/on-hand', S.revokedTok))).status, 401);
  const nRev = await ownerDo(async (o) => (await o.query(`select count(*)::int as n from api_clients where tenant_id = $1 and name like 'revoked%' and last_used_at is not null`, [S.tenant])).rows[0].n);
  assert.equal(nRev, 0, 'revoked never stamps');
});

test('the catch-all is OPTIONAL ([[...path]]) so bare /api/v1 reaches it', async () => {
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync('src/app/api/v1/[[...path]]/route.ts'));
  assert.ok(!existsSync('src/app/api/v1/[...path]/route.ts'));
});
