import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { Client } from 'pg';

import { REPO_ROOT, migrateUrl, sqlTestUrl } from '../harness/sql.ts';

/**
 * Runs the migration runner with the OWNER url.
 *
 * `scripts/migrate.mjs` reads `MIGRATE_DATABASE_URL ?? DATABASE_URL`, so both
 * are pinned to the owner url here — pointing the runner at the app role
 * (`authenticated`) is the bug this file guards against: Postgres makes the
 * creator of a table its owner, and a table's owner bypasses that table's own
 * RLS policies — so every table from later tasks would silently end up owned
 * by `authenticated` and every tenancy test would pass trivially. The runner
 * itself now refuses the app role too (see the refusal test below).
 */
function runMigrate(...args: string[]): string {
  return execFileSync(process.execPath, ['scripts/migrate.mjs', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, MIGRATE_DATABASE_URL: migrateUrl()!, DATABASE_URL: migrateUrl()! },
    encoding: 'utf8',
  });
}

test('migrate runner applies 0001 and records it', { skip: !migrateUrl() }, async () => {
  runMigrate();

  const c = new Client({ connectionString: sqlTestUrl()! });
  await c.connect();
  const r = await c.query<{ n: number }>(
    "select count(*)::int n from schema_migrations where name = '0001_init.sql'",
  );
  await c.end();
  assert.equal(r.rows[0].n, 1);
});

test('the runner is idempotent — a second run applies nothing', { skip: !migrateUrl() }, async () => {
  runMigrate();
  const out2 = runMigrate();

  assert.match(out2, /nothing to apply/i);

  const c = new Client({ connectionString: sqlTestUrl()! });
  await c.connect();
  const r = await c.query<{ n: number }>(
    "select count(*)::int n from schema_migrations where name = '0001_init.sql'",
  );
  await c.end();
  assert.equal(r.rows[0].n, 1, 'the migration must be recorded exactly once');
});

// The regression test for the ownership split. If someone ever points the
// runner back at `SQL_TEST_DATABASE_URL` (the `authenticated` role), the objects
// it creates are owned by `authenticated` — whose ownership bypasses RLS — and
// this test fails loudly instead of every later tenancy test passing trivially.
test('the runner owns schema_migrations as postgres, never as authenticated', { skip: !migrateUrl() }, async () => {
  runMigrate();

  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  const r = await owner.query<{ owner: string; owned_by_authenticated: boolean }>(
    `select r.rolname as owner,
            (r.rolname = 'authenticated') as owned_by_authenticated
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_roles r on r.oid = c.relowner
      where n.nspname = 'public'
        and c.relname = 'schema_migrations'`,
  );
  await owner.end();

  assert.equal(r.rows.length, 1, 'public.schema_migrations must exist');
  assert.equal(
    r.rows[0].owned_by_authenticated,
    false,
    'public.schema_migrations is owned by the `authenticated` role — the runner is being driven with the test url, not the owner url',
  );
  assert.equal(
    r.rows[0].owner,
    'postgres',
    `public.schema_migrations must be owned by the superuser "postgres", got "${r.rows[0].owner}"`,
  );
});

// The runner's own refusal: pointed at the app role it must FAIL LOUDLY, before
// it can create a single object owned by `authenticated`. This is the belt to
// the ownership test's braces — the ownership test catches the damage after the
// fact; this one proves the runner will not do it at all.
test('the runner refuses to migrate as the app role', { skip: !migrateUrl() || !sqlTestUrl() }, async () => {
  let exitCode = 0;
  let output = '';
  try {
    execFileSync(process.execPath, ['scripts/migrate.mjs'], {
      cwd: REPO_ROOT,
      // The app-role url is staged as the owner override, so a runner that
      // trusted MIGRATE_DATABASE_URL blindly would proceed as `authenticated`.
      env: { ...process.env, MIGRATE_DATABASE_URL: sqlTestUrl()! },
      encoding: 'utf8',
    });
  } catch (err) {
    exitCode = (err as { status?: number }).status ?? -1;
    output = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}`;
  }

  assert.notEqual(exitCode, 0, 'migrating as the app role must exit non-zero');
  assert.match(
    output,
    /refusing to migrate as the app role/,
    'the refusal must name the app role it refuses to migrate as',
  );
});
