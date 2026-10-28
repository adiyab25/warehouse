# Warehouse — inventory backbone

One central warehouse feeding 14 branches. **Movements are the truth; on-hand is
derived from them.** Nothing is edited or deleted — a mistake is fixed by posting
a compensating movement. Every later feature (receipts, requisitions, counts,
returns, labels, the API) sits on that single decision.

This repo is the backbone only: it does not sell, price or invoice.

## Layout

```
supabase/migrations/*.sql   plain SQL migrations, applied in filename order
scripts/migrate.mjs         the migration runner (replaces `supabase db push`)
scripts/db-check.mjs        connectivity + applied-migrations smoke check
scripts/gen-types.mjs       (Task 2) catalog-driven type generator — no Docker needed
tests/harness/sql.ts        withDb(fn) / sqlTestUrl() for database-backed tests
tests/                      node:test suites, run through tsx
src/                        the Next.js app (added from Task 11 onwards)
```

## Setup on this machine

Docker is **not** available, so `supabase start` and `supabase gen types` do not
work. `supabase init` is used for layout (`supabase/config.toml`) and nothing
else; migrations are applied by `scripts/migrate.mjs`. A Postgres 15 cluster is
already running on `127.0.0.1:55499` (`C:/Workspace/pg/pgsql/bin`).

`psql.exe` mis-parses its own flags under MSYS/git-bash. Never pass `-c`, `-f` or
`ON_ERROR_STOP`; set the `PG*` environment variables and pipe SQL on stdin.

### One-time database setup

```bash
export PGHOST=127.0.0.1 PGPORT=55499 PGUSER=postgres PGDATABASE=postgres
echo "create database warehouse;" | /c/Workspace/pg/pgsql/bin/psql.exe

# Supabase compatibility shim: auth / extensions / storage schemas + auth.* helpers
export PGDATABASE=warehouse
cat /c/Workspace/pg/bootstrap-supabase.sql | /c/Workspace/pg/pgsql/bin/psql.exe
```

`bootstrap-supabase.sql` already creates a **`authenticated` role without LOGIN**,
so the role must be altered, not created. The tests run as this non-superuser
role — a superuser bypasses row-level security, so a tenancy test run as
`postgres` would prove nothing:

```bash
echo "alter role authenticated login;" | /c/Workspace/pg/pgsql/bin/psql.exe
echo "grant usage, create on schema public, auth, extensions to authenticated;
      grant all on all tables in schema public to authenticated;
      alter default privileges in schema public grant all on tables to authenticated;" \
  | /c/Workspace/pg/pgsql/bin/psql.exe
```

Copy `.env.example` to `.env`. Migrations run as `MIGRATE_DATABASE_URL` (falling
back to `DATABASE_URL`) — the database OWNER; the tests connect as
`SQL_TEST_DATABASE_URL` — the non-superuser `authenticated` role. They are
deliberately different roles. `scripts/migrate.mjs` reads the owner url first and
**refuses to run** if it connects as `authenticated`: whoever creates a table
owns it, and a table owner bypasses its own RLS, so migrating as the app role
would leave every table owned by `authenticated` and silently defeat row-level
security.

### Running

```bash
npm run db:migrate   # apply every unapplied supabase/migrations/*.sql (as MIGRATE_DATABASE_URL / DATABASE_URL, the owner)
npm run db:reset     # drop schema public and reapply everything (dev only, owner role)
npm run db:check     # server version, schemas, applied migrations
npm test             # node:test via tsx; DB tests are skipped without SQL_TEST_DATABASE_URL
npm run ci           # tsc --noEmit + eslint . + npm test — the gate for every task
```

Migrating twice is a no-op: each migration runs in its own transaction and is
recorded by filename in `public.schema_migrations`.

## Rules that outlive this task

- Migrations are **always new files** (`NNNN_name.sql`), never edits to an applied one.
- The tenant is set with `select set_config('app.tenant_id', $1, true)` **inside a
  transaction**. `SET LOCAL app.tenant_id = $1` does not accept parameters and errors.
- Quantities are `numeric(12,3)`; money is `numeric(12,2)` EGP.
- Arabic is the primary UI language: `dir="rtl"`, Arabic labels, English alongside
  where it fits.
