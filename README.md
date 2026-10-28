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

## Which tenant this deployment serves

**v1 is one deployment per client**, so the tenant is deployment *configuration*,
not a runtime lookup. The app reads the tenant id from the `TENANT_ID`
environment variable at boot (`src/auth/tenant.ts::configuredTenantId`) and pins
`app.tenant_id` with it before any session exists — which is what lets Task 11's
auth shell read `app_users` to check a password and read a session cookie back.
A missing or malformed `TENANT_ID` **throws at boot**: a deployment that does not
know its tenant must fail loudly, never silently scope to nothing.

There is deliberately **no host/subdomain → tenant resolver** and no second
`security definer` function. The database cannot supply one today: `tenants` has
only `(id, name, created_at)` — no host or slug column — and its policy is
`id = current_setting('app.tenant_id')`, so a connection with no tenant pinned
cannot look a tenant up, and a scoped one can only see the tenant it is already
scoped to. A host/subdomain mapping is a **later, deliberate addition** for the
SaaS end state (many tenants behind one host, resolved per request); making that
choice should be an explicit design step, not a side effect of the auth shell.

### The auth shell (Task 11)

Implemented in `src/auth/login.ts` (sign-in), `src/app/sign-in` (the form and
the cookie it sets), `src/proxy.ts` + `src/app/page.tsx` (the session gate) and
`src/app/sign-out/route.ts` (the way out):

- **Identity is an ASSIGNED USERNAME, not a name.** `app_users.username` is
  unique per tenant (`unique (tenant_id, username)`, migration 0012) and sign-in
  matches on it exactly. A person's `name` is display data — two employees may
  share one, and a lookup by name made them one account.
- **Rate limit: a per-account LOCKOUT.** `LOCKOUT_THRESHOLD` failures inside
  `LOCKOUT_WINDOW_MS` (env-configurable; defaults 5 / 15 minutes) refuse sign-in
  *before the password is checked*, and while locked the attempt is **not
  recorded** — so the lock cannot be extended by an attacker who keeps knocking
  and it expires on its own. There is **no per-IP and no global limit**: an
  attacker who knows a username can deny that one account sign-in for up to the
  window. Accepted for v1 (recorded in `src/auth/login.ts`), with per-IP/global
  limiting and lockout alerting left to a later task.
- The **unknown-user path is constant-time**: on a username that does not exist,
  sign-in still runs the password KDF (`src/auth/password.ts`) against a fixed
  dummy hash, so response time cannot enumerate users — and an attempt is
  recorded for an unknown username too, so it locks exactly like a real one.
- **A success does not erase the evidence.** Failures are kept (the success is
  its own marked row), and `login_attempts` is bounded by
  `purge_login_attempts(interval)` (migration 0012) — tenant-scoped by
  construction, and **not scheduled yet**: wiring it to a job is a later task.
- **Names are normalised by one shared rule.** `src/domain/text.ts::normaliseName`
  and SQL `public.normalise_name` are the same function (NFKC, tatweel stripped,
  `أإآٱ→ا`, `ى→ي`, `ة→ه`, whitespace collapsed), and
  `app_users.name_normalised` carries a CHECK against the SQL — so `أحمد علي`
  and the ordinary `احمد علي` are one name, in the app and in the database.
- The **session cookie** is `httpOnly`, `SameSite=Lax`, `path=/`, `Secure` in
  production, expired with the session, and named `__Host-session` in production
  (`src/auth/cookie.ts` explains why the name and the attributes must agree).
- A **password change does not invalidate live sessions**. `readSession` looks at
  the session and the user's `active` flag, not the password hash, so existing
  sessions survive until they expire. If the shell wants them gone, it must
  explicitly set `revoked_at` on that user's sessions.
- **Numerals are Latin everywhere** (`src/i18n`), in both languages, through
  `formatNumber`/`formatCurrency`/`formatDate` — Arabic-Indic digits
  (`١٬٢٣٤٫٥`) never match a printed barcode, an SKU or a receipt.

## Rules that outlive this task

- Migrations are **always new files** (`NNNN_name.sql`), never edits to an applied one.
- The tenant is set with `select set_config('app.tenant_id', $1, true)` **inside a
  transaction**. `SET LOCAL app.tenant_id = $1` does not accept parameters and errors.
- Quantities are `numeric(12,3)`; money is `numeric(12,2)` EGP.
- Arabic is the primary UI language: `dir="rtl"`, Arabic labels, English alongside
  where it fits.
