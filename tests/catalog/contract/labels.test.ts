import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { SESSION_COOKIE } from '@/modules/auth/schema';
import { createSession } from '@/modules/auth/index';
import { withTenant } from '@/modules/platform/index';
import { createItem } from '@/modules/catalog/index';
import { createLocation } from '@/modules/locations/index';
import { GET as getLocationLabel } from '@/app/api/labels/location/[locationId]/route';
import { GET as getVariantLabel } from '@/app/api/labels/variant/[variantId]/route';
import { migrateUrl, sqlTestUrl, withDb } from '../../harness/sql.ts';

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
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(
      response.headers.get('x-content-type-options'),
      'nosniff',
      'the SVG must not be sniffed as another type',
    );
    assert.equal(
      response.headers.get('content-disposition'),
      'inline; filename="label-SH-0001.svg"',
      'the label downloads with a filename derived from its code',
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

test('an empty id is a 401 for an anonymous caller, not a 400', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();
  const restore = configureDeployment(t1);
  try {
    // The GATE comes first: an anonymous caller must not be able to tell an
    // empty id (400) from a well-formed one (401) — that is a shape oracle.
    const anon = await getVariantLabel(labelRequest('/api/labels/variant/'), {
      params: Promise.resolve({ variantId: '' }),
    });
    assert.equal(anon.status, 401, 'an empty id from an anonymous caller must be 401');

    const anonLocation = await getLocationLabel(labelRequest('/api/labels/location/'), {
      params: Promise.resolve({ locationId: '' }),
    });
    assert.equal(anonLocation.status, 401, 'the location route gates before the id too');

    // With a session, an empty id IS a 400 (the caller is now identified).
    const token = await withDb(async (db) =>
      (await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }))).token,
    );
    const authed = await getVariantLabel(labelRequest('/api/labels/variant/', token), {
      params: Promise.resolve({ variantId: '' }),
    });
    assert.equal(authed.status, 400, 'a signed-in caller with an empty id gets a 400');
  } finally {
    restore();
  }
});

test('a barcode too long to print is a 400, not a clipped label', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();
  const restore = configureDeployment(t1);
  try {
    const { variantId, token } = await withDb(async (db) => {
      const created = await withTenant(db, t1, (tdb) =>
        createItem(tdb, {
          nameAr: 'منتج طويل',
          family: 'sellable',
          sku: 'PRODUCTPREFIX-00000042',
          barcode: 'PRODUCTPREFIX-00000042',
        }),
      );
      const session = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));
      return { variantId: created.variant.id, token: session.token };
    });

    const response = await getVariantLabel(
      labelRequest(`/api/labels/variant/${variantId}`, token),
      { params: Promise.resolve({ variantId }) },
    );
    assert.equal(response.status, 400, 'a code that cannot be shown in full must be refused');
    assert.doesNotMatch(String(response.headers.get('content-type')), /svg/, 'no SVG on a 400');
  } finally {
    restore();
  }
});

test('two distinct variants produce two distinct labels', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();
  const restore = configureDeployment(t1);
  try {
    const { aId, bId, token } = await withDb(async (db) => {
      const a = await withTenant(db, t1, (tdb) =>
        createItem(tdb, { nameAr: 'قميص', family: 'sellable', sku: 'AB-0012', barcode: 'AB-0012' }),
      );
      const b = await withTenant(db, t1, (tdb) =>
        createItem(tdb, { nameAr: 'بنطلون', family: 'sellable', sku: 'XY-9999', barcode: 'XY-9999' }),
      );
      const session = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));
      return { aId: a.variant.id, bId: b.variant.id, token: session.token };
    });

    const [a, b] = await Promise.all([
      getVariantLabel(labelRequest(`/api/labels/variant/${aId}`, token), {
        params: Promise.resolve({ variantId: aId }),
      }),
      getVariantLabel(labelRequest(`/api/labels/variant/${bId}`, token), {
        params: Promise.resolve({ variantId: bId }),
      }),
    ]);
    const [aBody, bBody] = [await a.text(), await b.text()];
    assert.notEqual(aBody, bBody, 'distinct variants must not render byte-identical labels');
    assert.match(aBody, /AB-0012/);
    assert.match(bBody, /XY-9999/);
  } finally {
    restore();
  }
});

test('a variant whose SKU differs from its barcode renders BOTH codes', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();
  const restore = configureDeployment(t1);
  try {
    // `item_variants.sku` and `item_variants.barcode` are SEPARATE columns that
    // can differ, so a label must carry both: the encoded value for the scanner
    // and the internal code for a person.
    const { variantId, token } = await withDb(async (db) => {
      const created = await withTenant(db, t1, (tdb) =>
        createItem(tdb, {
          nameAr: 'قميص قطني',
          family: 'sellable',
          sku: 'SH-0001',
          barcode: 'BC-0001',
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
    assert.equal(response.status, 200, 'a variant with two codes is still a valid label');

    const body = await response.text();
    // The scannable/printed value is the BARCODE …
    assert.match(body, /BC-0001/, 'the encoded code is the barcode');
    // … and the internal SKU is on its OWN, clearly labelled line.
    assert.match(body, /class="label-internal"/, 'the internal code gets its own line');
    assert.match(body, /SH-0001/, 'the internal line carries the SKU');
    assert.match(body, /كود داخلي/, 'the internal line is labelled, not a second naked code');
  } finally {
    restore();
  }
});

test('a variant whose SKU equals its barcode renders a SINGLE code line', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();
  const restore = configureDeployment(t1);
  try {
    const { variantId, token } = await withDb(async (db) => {
      const created = await withTenant(db, t1, (tdb) =>
        createItem(tdb, { nameAr: 'قبعة', family: 'sellable', sku: 'SH-0002', barcode: 'SH-0002' }),
      );
      const session = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));
      return { variantId: created.variant.id, token: session.token };
    });

    const response = await getVariantLabel(
      labelRequest(`/api/labels/variant/${variantId}`, token),
      { params: Promise.resolve({ variantId }) },
    );
    assert.equal(response.status, 200);

    const body = await response.text();
    assert.match(body, /SH-0002/, 'the one code is printed');
    assert.doesNotMatch(
      body,
      /class="label-internal"/,
      'an identical SKU must NOT waste a line — the code is already on the sticker',
    );
  } finally {
    restore();
  }
});
