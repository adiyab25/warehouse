-- 0002_tenants_users: the tenancy root and the first tenant-scoped table.
--
-- Every later table copies the shape established here:
--   * `tenant_id uuid not null references tenants(id)`
--   * a policy
--       `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
--   * `alter table <t> force row level security`
--
-- The `nullif(…, '')` is load-bearing, not decoration. Once a placeholder GUC
-- like `app.tenant_id` has been assigned inside a transaction, Postgres keeps
-- the placeholder after the transaction ends and reverts it to the empty string
-- — so on a *warm* pooled connection (one that has already served a withTenant)
-- a bare query sees `current_setting('app.tenant_id', true) = ''` and a plain
-- `::uuid` cast raises `invalid input syntax for type uuid: ""`, while a cold
-- connection returns NULL and simply matches no rows. `nullif(…, '')` turns the
-- reverted `''` back into NULL so the policy behaves identically warm or cold:
-- zero rows, never an error.
--
-- The tenant is set with `select set_config('app.tenant_id', $1, true)` inside
-- a transaction (see src/db/client.ts::withTenant). `SET LOCAL app.tenant_id =
-- $1` cannot take a parameter and would error — never write it.
--
-- `force row level security` matters because a table's OWNER bypasses its own
-- RLS policies. Migrations are applied by the owner (scripts/migrate.mjs), so
-- without FORCE the policies would not bind the owner at all; FORCE closes that
-- gap so even an owner connection is subject to the policy.
--
-- Provisioning a tenant is deliberately NOT something the app role can do: the
-- `tenants` policy is keyed on the row's own `id`, so a fresh tenant can never
-- satisfy `id = current_setting('app.tenant_id')`. Tenants are created over the
-- owner connection (a provisioning action), and the app only ever sees the one
-- tenant it has been scoped to.

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- The app reads its own tenant but never creates one (see note above).
alter table tenants enable row level security;
alter table tenants force row level security;

create policy tenants_tenant_isolation on tenants
  using (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create table app_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  role text not null check (role in ('owner', 'warehouse_manager', 'branch_user')),
  -- FK to `locations(id)` is added in Task 3, once that table exists.
  branch_location_id uuid,
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table app_users enable row level security;
alter table app_users force row level security;

-- One policy, explicit `using` and `with check`: reads/updates/deletes are
-- limited to the current tenant, and inserts/updates may not write a row that
-- belongs to any other tenant.
create policy app_users_tenant_isolation on app_users
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The running app connects as `authenticated`; the migration owner (`postgres`)
-- already grants via default privileges, but be explicit so the grants survive
-- a cluster whose default privileges were never set.
grant select, insert, update, delete on tenants to authenticated;
grant select, insert, update, delete on app_users to authenticated;
