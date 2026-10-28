import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { SESSION_COOKIE } from '../../src/auth/cookie.ts';
import { createSession } from '../../src/auth/session.ts';
import { withTenant } from '../../src/db/client.ts';
import { createItem } from '../../src/db/items.ts';
import { createLocation } from '../../src/db/locations.ts';
import { GET as getLocationLabel } from '../../src/app/api/labels/location/[locationId]/route.ts';
import { GET as getVariantLabel } from '../../src/app/api/labels/variant/[variantId]/route.ts';
import { migrateUrl, sqlTestUrl, withDb } from '../harness/sql.ts';

/**
 * The label ROUTES, driven directly.
 *
 * The routes are imported and called as plain functions with a real `Request` —
 * which works because they return a standard `Response` and do not touch
 * `next/headers`. That is deliberate: the two things a review worries about on a
 * label endpoint, that it is AUTHENTICATED and that an unknown id is a 404
 * rather than a blank sticker, are then PROVEN here rather than assumed.
 *
 * The gate reuses the app's one session mechanism (`currentUser` over the
 * request's `cookies`), inside one `withTenant` boundary, so a test drives it by
 * carrying the same `session=…` cookie the browser would.
 */

const provisioned: string[] = [];

/** Creates a tenant with an `owner` user, over the OWNER connection. */
async function provision(): Promise<{ t1: string; u1: string }> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const {
      rows: [t1],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Label One') returning id");
    const {
      rows: [u1],
    } = await owner.query<{ id: string }>(
      `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash)
       values ($1, 'Label Owner', public.normalise_name('Label Owner'), 'label_owner', 'owner', 'x')
       returning id`,
      [t1!.id],
    );
    provisioned.push(t1!.id);
    return { t1: t1!.id, u1: u1!.id };
  } finally {
    await owner.end();
  }
}

// Child rows first: sessions → item_variants → items → locations → app_users → tenants.
after(async () => {
  if (provisioned.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('delete from sessions where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from item_variants where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from items where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from locations where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from app_users where tenant_id = any($1)', [provisioned]);
    await owner.query('delete from tenants where id = any($1)', [provisioned]);
  } finally {
    await owner.end();
  }
});

/** Sets the deployment's env for the route, and returns a restore function. */
function configureDeployment(tenantId: string): () => void {
  const savedDb = process.env.APP_DATABASE_URL;
  const savedTenant = process.env.TENANT_ID;
  process.env.APP_DATABASE_URL = sqlTestUrl();
  process.env.TENANT_ID = tenantId;
  return () => {
    if (savedDb === undefined) delete process.env.APP_DATABASE_URL;
    else process.env.APP_DATABASE_URL = savedDb;
    if (savedTenant === undefined) delete process.env.TENANT_ID;
    else process.env.TENANT_ID = savedTenant;
  };
}

/** A `Request` carrying a session cookie (or none). */
function labelRequest(path: string, token?: string): Request {
  const headers = token ? { cookie: `${SESSION_COOKIE}=${token}` } : undefined;
  return new Request(`http://localhost${path}`, { headers });
}

test('the variant label route returns image/svg+xml for a real variant', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();
  const restore = configureDeployment(t1);
  try {
    const { variantId, token } = await withDb(async (db) => {
      const created = await withTenant(db, t1, (tdb) =>
        createItem(tdb, {
          nameAr: 'قميص قطني',
          family: 'sellable',
          sku: 'SH-0001',
          barcode: 'SH-0001',
          attrs: { size: 'L', colour: 'أبيض' },
        }),
      );
      const session = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));
      return { variantId: created.variant.id, token: session.token };
    });

    const response = await getVariantLabel(
      labelRequest(`/api/labels/variant/${variantId}`, token),
      { params: Promise.resolve({ variantId }) },
    );

    assert.equal(response.status, 200, 'a signed-in caller gets the label');
    assert.match(
      String(response.headers.get('content-type')),
      /^image\/svg\+xml/,
      'the media type is image/svg+xml',
    );

    const body = await response.text();
    assert.match(body, /^<svg /, 'the body is an SVG document');
    assert.match(body, /SH-0001/, 'the label carries the SKU');
    assert.match(body, /قميص قطني/, 'the label carries the Arabic name');
  } finally {
    restore();
  }
});

test('the location label route returns image/svg+xml for a real location', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();
  const restore = configureDeployment(t1);
  try {
    const { locationId, token } = await withDb(async (db) => {
      const loc = await withTenant(db, t1, (tdb) =>
        createLocation(tdb, { code: 'BIN-A1', nameAr: 'الرف أ١', type: 'bin' }),
      );
      const session = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));
      return { locationId: loc.id, token: session.token };
    });

    const response = await getLocationLabel(
      labelRequest(`/api/labels/location/${locationId}`, token),
      { params: Promise.resolve({ locationId }) },
    );

    assert.equal(response.status, 200, 'a signed-in caller gets the location label');
    assert.match(String(response.headers.get('content-type')), /^image\/svg\+xml/);
    const body = await response.text();
    assert.match(body, /BIN-A1/, 'the label carries the location code');
    assert.match(body, /الرف أ١/, 'the label carries the Arabic location name');
  } finally {
    restore();
  }
});

test('the variant label route refuses an unauthenticated caller', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();
  const restore = configureDeployment(t1);
  try {
    // A real variant exists — so a 401 here is the GATE, not a missing row.
    const variantId = await withDb(async (db) => {
      const created = await withTenant(db, t1, (tdb) =>
        createItem(tdb, { nameAr: 'قبعة', family: 'sellable', sku: 'HT-0001', barcode: 'HT-0001' }),
      );
      return created.variant.id;
    });

    const anonymous = await getVariantLabel(labelRequest(`/api/labels/variant/${variantId}`), {
      params: Promise.resolve({ variantId }),
    });
    assert.equal(anonymous.status, 401, 'no cookie ⇒ 401, never the label');

    const forged = await getVariantLabel(
      labelRequest(`/api/labels/variant/${variantId}`, 'not-a-real-token'),
      { params: Promise.resolve({ variantId }) },
    );
    assert.equal(forged.status, 401, 'a forged cookie ⇒ 401, never the label');

    // The positive control: WITH the session the same id is a 200. Without this,
    // a route that simply always 401s would pass the two assertions above.
    const token = await withDb(async (db) =>
      (await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }))).token,
    );
    const authed = await getVariantLabel(
      labelRequest(`/api/labels/variant/${variantId}`, token),
      { params: Promise.resolve({ variantId }) },
    );
    assert.equal(authed.status, 200, 'with a session the same variant is served');

    const locationAnon = await getLocationLabel(labelRequest('/api/labels/location/whatever'), {
      params: Promise.resolve({ locationId: '11111111-1111-1111-1111-111111111111' }),
    });
    assert.equal(locationAnon.status, 401, 'the location route is gated too');
  } finally {
    restore();
  }
});

test('an unknown variant id is a 404, not an empty label', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();
  const restore = configureDeployment(t1);
  try {
    const token = await withDb(async (db) =>
      (await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }))).token,
    );

    const missingId = '11111111-1111-1111-1111-111111111111';
    const response = await getVariantLabel(
      labelRequest(`/api/labels/variant/${missingId}`, token),
      { params: Promise.resolve({ variantId: missingId }) },
    );
    assert.equal(response.status, 404, 'an unknown id must be a 404, not a 200 with an empty sticker');
    assert.doesNotMatch(String(response.headers.get('content-type')), /svg/, 'no SVG body on a 404');
  } finally {
    restore();
  }
});
