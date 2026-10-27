#!/usr/bin/env node
// Plain-SQL migration runner.
//
//   DATABASE_URL=postgresql://… node scripts/migrate.mjs            # apply what is missing
//   DATABASE_URL=postgresql://… node scripts/migrate.mjs --reset    # drop `public`, reapply everything
//
// Migrations are plain .sql files under supabase/migrations/, applied in
// filename order, each in its own transaction, and recorded by filename in
// public.schema_migrations. Re-running applies nothing (idempotent).
// Docker is not involved: this runner replaces `supabase db push` on machines
// where the Supabase CLI cannot start a local stack.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const reset = process.argv.includes('--reset');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('migrate: DATABASE_URL is not set');
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const client = new pg.Client({ connectionString, application_name: 'warehouse-migrate' });
await client.connect();

if (reset) {
  // Only the database owner can do this; it is a development convenience.
  // Re-granting after the recreate is required: dropping a schema also drops
  // its pg_default_acl rows, so without this the non-superuser test role loses
  // both CREATE on the schema and the privileges inherited by future tables.
  await client.query(`
    drop schema if exists public cascade;
    create schema public;
    grant usage, create on schema public to authenticated;
    alter default privileges in schema public grant all on tables to authenticated;
    alter default privileges in schema public grant all on sequences to authenticated;
  `);
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
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into public.schema_migrations (name) values ($1)', [file]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error(`failed ${file}: ${err.message}`);
    await client.end();
    process.exit(1);
  }

  console.log(`applied ${file}`);
  count += 1;
}

if (count === 0) {
  console.log('nothing to apply — database is up to date');
} else {
  console.log(`done: ${count} migration(s) applied`);
}

await client.end();
