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
      grant select, insert, update, delete on all tables in schema public to authenticated;
      alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;" \
  | /c/Workspace/pg/pgsql/bin/psql.exe
```

Copy `.env.example` to `.env`. There are **three** database urls, each with a
distinct job, and they are deliberately different roles:

- `MIGRATE_DATABASE_URL` (falling back to `DATABASE_URL`) — the database **OWNER**
  the migration runner connects as.
- `APP_DATABASE_URL` — the non-superuser `authenticated` role the **running app**
  serves as. The app reads **only** this variable (there is no fallback to the
  owner variable, which is exactly how a deployment would end up silently served
  with RLS off) and **refuses to serve** if the connected role is a superuser or
  has `rolbypassrls` — see `src/db/app-pool.ts`.
- `SQL_TEST_DATABASE_URL` — the non-superuser `authenticated` role every **test**
  connects as.

`scripts/migrate.mjs` reads the owner url first and **refuses to run** if it
connects as `authenticated`: whoever creates a table owns it, and a table owner
bypasses its own RLS, so migrating as the app role would leave every table owned
by `authenticated` and silently defeat row-level security. The app-side check is
the inverse: it refuses to *serve* as the owner (or any superuser / `BYPASSRLS`
role), because serving as a bypassing role would silently switch off every tenant
protection while every test still passed.

### Running

```bash
npm run db:migrate   # apply every unapplied supabase/migrations/*.sql (as MIGRATE_DATABASE_URL / DATABASE_URL, the owner)
npm run db:reset     # drop schema public and reapply everything (dev only, owner role)
npm run db:check     # server version, schemas, applied migrations
npm test             # node:test via tsx; DB tests are skipped without SQL_TEST_DATABASE_URL (and the run still exits 0)
npm run ci           # the gate for every task: tsc --noEmit + eslint . + the full suite.
                     # Unlike `npm test`, `ci` REQUIRES SQL_TEST_DATABASE_URL and
                     # MIGRATE_DATABASE_URL (it refuses to run without them) AND fails if
                     # any test was skipped — a suite that skips itself green is not a gate.
```

Migrating twice is a no-op: each migration runs in its own transaction and is
recorded by filename in `public.schema_migrations`.

## Seed and end-to-end gate

A ready-to-use demo tenant and a proof that the whole system hangs together.

```bash
npm run db:reset       # apply every migration cleanly (owner role)
npm run seed           # one tenant: warehouse, 14 branches, pseudo locations,
                       # users, items of each family with real opening balances
npm run e2e            # receive -> request -> issue -> confirm -> return -> count,
                       # asserted step by step, then an HTTP smoke on a next build
npm run ci             # tsc + eslint + the full test suite (the task gate)
```

### Seed a demo tenant

`npm run seed` creates a tenant with **one warehouse (`WH-01`), 14 branches
(`BR-01`…`BR-14`), the transit / scrap / quarantine locations, a vendor, the
users `owner`, `manager` and `branch01`…`branch14`, and a few items of each
family** (sellable, consumable, asset) with opening balances posted through the
real importer — so every balance is a ledger row with an actor. Re-running it
reports "already seeded" and changes nothing. It **prints the tenant id** — copy
it into `TENANT_ID` in `.env` so the app knows which tenant to serve.

Passwords come from the environment, all three **at least 12 characters**, and
are never printed or stored in the repo (there is no default):

```powershell
# PowerShell
$env:SEED_OWNER_PASSWORD="<a 12+ char owner password>"
$env:SEED_MANAGER_PASSWORD="<a 12+ char manager password>"
$env:SEED_BRANCH_PASSWORD="<a 12+ char branch password>"
npm run seed -- --name "Demo Kindergarten"
```
```cmd
REM cmd
set "SEED_OWNER_PASSWORD=<a 12+ char owner password>"
set "SEED_MANAGER_PASSWORD=<a 12+ char manager password>"
set "SEED_BRANCH_PASSWORD=<a 12+ char branch password>"
npm run seed -- --name "Demo Kindergarten"
```

### Open an opening-balance file

```bash
npm run import:opening -- --tenant <tenant-id> --user owner --file "path\to\file.csv" [--apply]
```

Dry-run by default (prints what it would change and saves nothing); add
`--apply` to commit. Columns, rules and every error are in
`docs/import-format.md`.

### The end-to-end gate

`npm run e2e` seeds a **fresh** tenant and drives the full life of a delivery
through the real writers as the matching roles — receive 40 against an expected
40, request 10 at `BR-04`, approve + issue, confirm, return 2, count with a −1
variance — asserting on-hand per location after every step, then reconciles the
`on_hand` view against an independent ledger sum for every variant. It then runs
an HTTP smoke against a `next build`: sign in, open every screen, render a label,
and call the read API and the movement write API (idempotency, and the refusals
for a sale from transit and a sale over on-hand). `npm run e2e -- --no-http`
skips the build + server half for speed.

### Run the app

```bash
npx next build
npx next start     # serves as APP_DATABASE_URL (the non-owner role); refuses a superuser
```

Open `http://localhost:3000`, sign in as `manager` (or `owner`) with the
password you set when seeding.

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
