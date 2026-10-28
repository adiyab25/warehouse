import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from 'pg';

import { appDatabaseUrl, assertServingRole, createAppPool } from '../../src/db/app-pool.ts';
import { migrateUrl, sqlTestUrl } from '../harness/sql.ts';

/**
 * The app-side half of the ownership split.
 *
 * `scripts/migrate.mjs` REFUSES to migrate as the app role (it must be the
 * OWNER). This file is the inverse: the APP must refuse to SERVE as the owner
 * (or any superuser / `BYPASSRLS` role), because a table's owner bypasses that
 * table's own RLS policies — so a deployment pointed at the owner url would run
 * with every tenant protection silently switched off, while every test still
 * passed (tests connect as `authenticated`).
 *
 * The refusal is detected from the CONNECTED ROLE, not the url, so `postgres`
 * reached through any url shape is caught.
 */

test('the app refuses to serve as the owner (superuser / BYPASSRLS) role', { skip: !migrateUrl() }, async () => {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await assert.rejects(
      () => assertServingRole(owner),
      /refusing to serve as role/,
      'the owner/superuser role must be refused with an explanatory message',
    );
  } finally {
    await owner.end();
  }
});

test('the refusal names the reason — RLS would be silently defeated', { skip: !migrateUrl() }, async () => {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await assert.rejects(() => assertServingRole(owner), (err: Error) => {
      assert.match(
        String(err.message),
        /row-level security would be silently defeated/,
        'the refusal must explain that RLS would be silently defeated',
      );
      assert.match(String(err.message), /APP_DATABASE_URL/, 'the refusal must name the variable to point right');
      return true;
    });
  } finally {
    await owner.end();
  }
});

test('createAppPool refuses an owner connection and hands back no pool', { skip: !migrateUrl() }, async () => {
  await assert.rejects(
    () => createAppPool(migrateUrl()!),
    /refusing to serve as role/,
    'a pool built from the owner url must never be returned',
  );
});

// The positive control: the non-bypassing `authenticated` role IS accepted, so
// the refusal above is a real check and not simply "everything is refused".
test('the app accepts the non-bypassing authenticated role', { skip: !sqlTestUrl() }, async () => {
  const pool = await createAppPool(sqlTestUrl()!);
  try {
    const { rows } = await pool.query<{ role: string }>('select current_user as role');
    assert.equal(rows[0].role, 'authenticated', 'the accepted role is the non-owner app role');
    await assertServingRole(pool); // resolves — no throw — for a non-bypassing role
  } finally {
    await pool.end();
  }
});

// The core of defect 1(a): the app reads APP_DATABASE_URL and NEVER falls back
// to the owner variable. If someone reintroduced a `?? DATABASE_URL` fallback,
// the first assertion below would return the owner url instead of throwing — and
// in a real deployment that fallback is how the app would silently run with RLS
// bypassed.
test('the app reads its OWN variable and never falls back to the owner variable', () => {
  const savedApp = process.env.APP_DATABASE_URL;
  const savedDb = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = 'postgresql://owner-must-not-be-used';
    delete process.env.APP_DATABASE_URL;

    assert.throws(
      () => appDatabaseUrl(),
      /APP_DATABASE_URL is not set/,
      'with APP_DATABASE_URL unset the app must refuse, NOT fall back to DATABASE_URL',
    );

    process.env.APP_DATABASE_URL = 'postgresql://the-app-role';
    assert.equal(appDatabaseUrl(), 'postgresql://the-app-role');
  } finally {
    if (savedApp === undefined) delete process.env.APP_DATABASE_URL;
    else process.env.APP_DATABASE_URL = savedApp;
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
  }
});
