#!/usr/bin/env node
// Smoke check: can we reach the database and what has been applied?
//
//   DATABASE_URL=… node scripts/db-check.mjs
//
// Prints the server version, the schemas the Supabase bootstrap created and
// every recorded migration. Exits non-zero if the database is unreachable.

import pg from 'pg';

const connectionString = process.env.DATABASE_URL ?? process.env.SQL_TEST_DATABASE_URL;
if (!connectionString) {
  console.error('db-check: set DATABASE_URL (or SQL_TEST_DATABASE_URL)');
  process.exit(1);
}

const client = new pg.Client({ connectionString, application_name: 'warehouse-db-check' });
try {
  await client.connect();

  const version = await client.query('select version()');
  console.log(version.rows[0].version);

  const who = await client.query(
    'select current_user, current_database(), current_setting(\'is_superuser\') as is_superuser',
  );
  const me = who.rows[0];
  console.log(`user=${me.current_user} database=${me.current_database} superuser=${me.is_superuser}`);
  if (me.is_superuser === 'on') {
    console.log('note: this connection is a superuser — row-level security does not apply to it');
  }

  const schemas = await client.query(
    "select nspname from pg_namespace where nspname in ('auth','extensions','storage') order by 1",
  );
  console.log(`compat schemas: ${schemas.rows.map((r) => r.nspname).join(', ') || '(none)'}`);

  const exists = await client.query("select to_regclass('public.schema_migrations') as t");
  if (!exists.rows[0].t) {
    console.log('migrations: schema_migrations does not exist yet — run `npm run db:migrate`');
  } else {
    const applied = await client.query('select name, applied_at from public.schema_migrations order by name');
    console.log(`migrations: ${applied.rows.length} applied`);
    for (const row of applied.rows) {
      console.log(`  ${row.name}  ${row.applied_at.toISOString?.() ?? row.applied_at}`);
    }
  }
} catch (err) {
  console.error(`db-check: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
