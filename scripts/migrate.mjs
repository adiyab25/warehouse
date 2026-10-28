#!/usr/bin/env node
// Plain-SQL migration runner.
//
//   MIGRATE_DATABASE_URL=postgresql://… node scripts/migrate.mjs           # apply what is missing
//   MIGRATE_DATABASE_URL=postgresql://… node scripts/migrate.mjs --reset   # drop `public`, reapply everything
//
// Migrations are plain .sql files under supabase/migrations/, applied in
// filename order, each in its own transaction, and recorded by filename in
// public.schema_migrations. Re-running applies nothing (idempotent).
// Docker is not involved: this runner replaces `supabase db push` on machines
// where the Supabase CLI cannot start a local stack.
//
// The URL is `MIGRATE_DATABASE_URL ?? DATABASE_URL`, the SAME precedence
// `.env.example`, `scripts/gen-types.mjs` and `tests/harness/sql.ts` use — so a
// machine that sets only the owner override migrates through it rather than
// through whatever `DATABASE_URL` happens to hold.
//
// It MUST be the database OWNER. Postgres makes whoever creates a table its
// owner, and an owner bypasses that table's own RLS policies — so running this
// as the app role would make every table owned by it and silently defeat RLS.
// The runner therefore REFUSES to run when it connects as `authenticated`, and
// the tests assert the resulting ownership.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const reset = process.argv.includes('--reset');

/** Every failure path exits non-zero with a single clean `migrate: …` line. */
function fail(message) {
  console.error(`migrate: ${message}`);
  process.exit(1);
}

const connectionString = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) fail('MIGRATE_DATABASE_URL (or DATABASE_URL) is not set');

// Filenames are the ordering key. A name like `10_foo.sql` sorts before
// `0009_…` lexicographically and would silently be applied out of order, so
// reject anything that is not the four-digit `NNNN_name.sql` shape.
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
for (const file of files) {
  if (!/^\d{4}_/.test(file)) {
    fail(
      `migration filename "${file}" does not match /^\\d{4}_/ — rename it to "NNNN_${file}".sql (four digits, then underscore) so migrations sort in the intended order`,
    );
  }
}
files.sort();

const client = new pg.Client({ connectionString, application_name: 'warehouse-migrate' });
try {
  await client.connect();
} catch (err) {
  fail(`could not connect to the database: ${err.message}`);
}

// Refuse to migrate as the app role. Whoever creates a table owns it, and a
// table's OWNER bypasses that table's own RLS policies — so connecting as
// `authenticated` would leave every table owned by the app role and silently
// defeat row-level security for every tenant at once. Detected AFTER connecting
// (the role is a property of the connection, not the URL) so `postgres` reached
// through any url shape is accepted and only the app role is refused.
try {
  const { rows } = await client.query('select current_user as role');
  if (rows[0]?.role === 'authenticated') {
    fail(
      'refusing to migrate as the app role "authenticated" — whoever creates a ' +
        'table owns it, and a table owner bypasses its own RLS, so every table ' +
        'would end up owned by the app role and row-level security would be ' +
        'silently defeated. Point MIGRATE_DATABASE_URL (or DATABASE_URL) at the ' +
        'database OWNER url.',
    );
  }
} catch (err) {
  await client.end().catch(() => {});
  fail(`could not read the connection role: ${err.message}`);
}

try {
  if (reset) {
    // Only the database owner can do this; it is a development convenience.
    // Re-granting after the recreate is required: dropping a schema also drops
    // its pg_default_acl rows, so without this the non-superuser test role loses
    // both CREATE on the schema and the privileges inherited by future tables.
    // Wrapped in one transaction so a failure after `drop schema` rolls back and
    // the database is never left with no `public` schema at all.
    await client.query('begin');
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
    await client.query('grant usage, create on schema public to authenticated');
    // Tables: grant ONLY the four privileges the app actually uses. Postgres
    // hands the schema's default ACL (pg_default_acl) to every table created
    // afterwards, and `alter default privileges` is ADDITIVE, so a bare
    // `grant all` also bestows TRUNCATE, REFERENCES and TRIGGER on
    // `authenticated`. TRUNCATE is NOT governed by row level security and the
    // append-only guard is a BEFORE UPDATE OR DELETE row trigger that a
    // TRUNCATE never fires — so one `truncate public.stock_movements` as the
    // app role would empty the append-only ledger for EVERY tenant at once.
    // REFERENCES / TRIGGER would let the app role bolt constraints and
    // triggers onto the ledger. Revoke the wide default first (a no-op when
    // the schema was just recreated, but it repairs a cluster whose default
    // ACL predates this fix), then grant only the four.
    await client.query('alter default privileges in schema public revoke all on tables from authenticated');
    await client.query(
      'alter default privileges in schema public grant select, insert, update, delete on tables to authenticated',
    );
    await client.query('alter default privileges in schema public grant all on sequences to authenticated');
    await client.query('commit');
    console.log('reset: dropped and recreated schema public');
  }

  // Bookkeeping table exists from the very first run, so a failure half way
  // through a migration can never be mistaken for "already applied".
  await client.query(`
    create table if not exists public.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows } = await client.query('select name from public.schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public.schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw new Error(`failed ${file}: ${err.message}`);
    }

    console.log(`applied ${file}`);
    count += 1;
  }

  if (count === 0) {
    console.log('nothing to apply — database is up to date');
  } else {
    console.log(`done: ${count} migration(s) applied`);
  }
} catch (err) {
  await client.end().catch(() => {});
  fail(err.message);
}

await client.end();
