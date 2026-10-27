-- 0003_locations: every physical place in the backbone, in one table.
--
-- The warehouse, its bins, each of the 14 branches, the in-transit bucket,
-- vendors, scrap and the people who hold stock are all *locations* — the same
-- row shape, discriminated by `type`. One table rather than seven keeps every
-- foreign key that points at "a place" pointed at one target.
--
-- This copies the shape 0002 established, and every later table copies it too:
--   * `tenant_id uuid not null references tenants(id)` + a unique per-tenant code
--   * a policy
--       `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
--     carrying BOTH `using` and `with check`
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

create table locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- A code identifies a place within one tenant, and is stored CANONICALISED:
  -- upper-cased and trimmed. `unique (tenant_id, code)` is only case- and
  -- whitespace-sensitive by default, so without normalising, 'BR-04', 'br-04'
  -- and 'BR-04 ' would be three distinct codes — silently splitting one
  -- branch's ledger across three rows. The CHECK makes that impossible even for
  -- a raw SQL insert that bypasses src/db/locations.ts.
  code text not null constraint locations_code_normalised_check check (code = upper(btrim(code))),
  name_ar text not null,
  name_en text,
  type text not null check (type in ('warehouse', 'bin', 'branch', 'transit', 'vendor', 'scrap', 'quarantine', 'holder')),
  parent_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  -- A code identifies a place within one tenant. The per-tenant unique index is
  -- also what lets `transitLocation` upsert its singleton with
  -- `on conflict (tenant_id, code) do nothing`: without it two concurrent
  -- callers could each insert a transit row.
  unique (tenant_id, code),
  -- `(tenant_id, id)` is redundant against the primary key alone, but the
  -- COMPOSITE parent foreign key below needs a unique constraint on exactly
  -- these columns to point at — and pointing at it is what stops a bin in
  -- tenant A from parenting off a location in tenant B.
  unique (tenant_id, id),
  -- Tenant-scoped self-reference: a parent must live in the SAME tenant. A
  -- plain `references locations(id)` would accept any tenant's id; the
  -- composite key makes the database refuse a cross-tenant parent. Kept
  -- nullable — top-level locations (the warehouse, branches, transit) have no
  -- parent, and a composite FK with a NULL column is simply not enforced.
  foreign key (tenant_id, parent_id) references locations (tenant_id, id)
);

alter table locations enable row level security;
alter table locations force row level security;

-- One policy, explicit `using` and `with check`: reads/updates/deletes are
-- limited to the current tenant, and inserts/updates may not write a row that
-- belongs to any other tenant.
create policy locations_tenant_isolation on locations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The running app connects as `authenticated`; be explicit so the grants survive
-- a cluster whose default privileges were never set.
grant select, insert, update, delete on locations to authenticated;

-- 0002 left `app_users.branch_location_id` as a bare uuid because `locations`
-- did not exist yet. Now that it does, add the foreign key it deferred: a user
-- assigned to a branch must point at a real location.
alter table app_users
  add constraint app_users_branch_location_id_fkey
  foreign key (branch_location_id) references locations(id);
