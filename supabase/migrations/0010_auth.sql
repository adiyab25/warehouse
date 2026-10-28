-- 0010_auth: WHO is acting — people (sessions) and outside systems (keys).
--
-- This is the last foundation table. Two new tables and one deferred foreign
-- key:
--
--   * `sessions`     — a signed-in person. A row is one ISSUED session token:
--                      the raw token is shown to the client ONCE (in a cookie)
--                      and only its HASH is ever stored, so a database read
--                      cannot resurrect a live credential.
--   * `api_clients`  — an outside system (a branch terminal, an integration)
--                      that authenticates with an ISSUED key. Same rule: the
--                      token is stored as a hash, returned once at issue time,
--                      and never retrievable afterwards.
--
-- Copies the RLS shape 0002 established and every later migration repeated:
--   * `tenant_id uuid not null references tenants(id)` + `unique (tenant_id, id)`
--   * a policy `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
--     carrying BOTH `using` and `with check`
--   * `alter table <t> force row level security`
--   * explicit `grant select, insert, update, delete` to `authenticated`, and an
--     explicit revoke of TRUNCATE / REFERENCES / TRIGGER (RLS cannot govern
--     them, and `public`'s default ACL is additive).
--
-- ---- WHY THERE IS A SECURITY DEFINER FUNCTION -------------------------------
-- The whole point of a token is that it is presented BEFORE anyone knows which
-- tenant is speaking. Resolving the token means reading `api_clients`, but the
-- table is guarded by a tenant policy — and the tenant is exactly the value the
-- token is meant to reveal. A plain tenant-scoped read would hide the very row
-- needed to find the tenant, and nothing would ever authenticate.
--
-- `authenticate_api_token(text)` below is the ONE sanctioned exception to tenant
-- scoping: it is SECURITY DEFINER, so it runs with the definer's rights and
-- bypasses the RLS policy on `api_clients`, returning ONLY the three columns a
-- caller needs to bootstrap (the row id, its tenant and its scopes). It is
-- granted `execute` to `authenticated` and revoked from PUBLIC. Everything
-- AFTER resolution — the `last_used_at` write, and every subsequent read and
-- write — runs inside an ordinary `withTenant` transaction scoped to the tenant
-- the function returned (src/db/api-clients.ts::authenticateClient).
--
-- Sessions deliberately do NOT get a second such function. A sign-in names the
-- tenant (the login form / host does), so the app opens a tenant scope first and
-- then reads `sessions` — the token never has to reveal a tenant, because one is
-- already in hand. See src/auth/session.ts::readSession.
--
-- ---- NORMALISATION ----------------------------------------------------------
-- `api_clients.name` is human-typed, so it is stored TRIMMED and the CHECK below
-- refuses a raw insert that bypasses src/db/api-clients.ts (the same discipline
-- 0003/0004/0005 applied to codes, skus and refs). `sessions.user_id` is a uuid
-- (not text) so there is nothing to canonicalise; the app trims and validates it
-- and the composite FK below is what makes a session point at a real user of the
-- SAME tenant.

create table sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- The person the session was opened for. Composite FK below keeps it a user
  -- of THIS tenant: a plain `references app_users(id)` would accept another
  -- tenant's id.
  user_id uuid not null,
  -- The token, stored ONLY as a hash (sha256 hex). Never the raw token: a
  -- database read must not be able to reconstruct a live credential.
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  -- REQUIRED: every session expires. readSession refuses an expired row, so a
  -- token leaked to a log is not a permanent key.
  expires_at timestamptz not null,
  -- Set when a session is signed out or invalidated; NULL while live.
  revoked_at timestamptz,
  -- Redundant against the primary key alone, but composite FKs elsewhere need a
  -- unique constraint on exactly these columns to point at.
  unique (tenant_id, id),
  -- Tenant-scoped composite. A session in tenant A may name only a tenant-A
  -- user; app_users carries `unique (tenant_id, id)` from 0005.
  foreign key (tenant_id, user_id) references app_users (tenant_id, id)
);

alter table sessions enable row level security;
alter table sessions force row level security;

create policy sessions_tenant_isolation on sessions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on sessions to authenticated;

-- TRUNCATE is not governed by RLS at all, so one `truncate public.sessions` as
-- the app role would sign EVERY tenant out at once; REFERENCES/TRIGGER would let
-- the app role bolt constraints and triggers onto the table.
revoke truncate, references, trigger on sessions from authenticated;

-- The read that answers "is this token live?" — by hash, within the tenant.
create index sessions_user_id_idx on sessions (user_id);

create table api_clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- A human label for the integrator. Human-typed, so stored TRIMMED; the CHECK
  -- makes it impossible even for a raw insert to store an un-trimmed or empty
  -- name (mirroring 0003/0005).
  name text not null constraint api_clients_name_normalised_check
    check (name = btrim(name) and name <> ''),
  -- The key, stored ONLY as a hash (sha256 hex). Returned once at issue time and
  -- never retrievable afterwards.
  token_hash text not null unique,
  -- What the key may do. Closed to the two the API understands today; the
  -- default is the least privilege — read.
  scopes text[] not null default '{read}',
  -- Revoking an integrator is `active = false`: the resolver filters on it, so a
  -- revoked key cannot authenticate.
  active boolean not null default true,
  -- Written on every successful authentication (src/db/api-clients.ts); NULL
  -- until the key is first used.
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  -- Redundant against the primary key alone, but the composite FK this task adds
  -- to `stock_movements` (below) needs a unique constraint on exactly these
  -- columns to point at — and pointing at it is what keeps a movement in tenant
  -- A from naming an api client in tenant B.
  unique (tenant_id, id)
);

alter table api_clients enable row level security;
alter table api_clients force row level security;

create policy api_clients_tenant_isolation on api_clients
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on api_clients to authenticated;

revoke truncate, references, trigger on api_clients from authenticated;

-- ---- THE DEFERRED FOREIGN KEY (Task 5) --------------------------------------
-- 0005 left `stock_movements.actor_api_client_id` a bare uuid because
-- `api_clients` did not exist yet, so the column was there but nothing stopped a
-- movement recording an api client from ANOTHER tenant. Now that the table
-- exists, add the COMPOSITE key — `(tenant_id, actor_api_client_id)` pointing at
-- `api_clients (tenant_id, id)` — exactly as the actor_user_id link is keyed.
-- A NULL column means a movement written by a person, not a key; a composite FK
-- with a NULL column is simply not enforced, so those movements stay valid.
alter table stock_movements
  add constraint stock_movements_actor_api_client_id_fkey
  foreign key (tenant_id, actor_api_client_id) references api_clients (tenant_id, id);

-- ---- THE ONE SANCTIONED EXCEPTION TO TENANT SCOPING -------------------------
-- Resolving an api token requires reading `api_clients` before any tenant is
-- known; a tenant-scoped read would hide the row needed to learn the tenant.
-- This SECURITY DEFINER function runs with the definer's rights (the table's
-- owner, who is not bound by FORCE RLS as a superuser is not), and returns ONLY
-- the columns needed to bootstrap. It is the only path that reads a tenant's
-- data without `app.tenant_id` pinned, and it is restricted to one lookup:
-- a single hash, an active client, three columns. `execute` is granted to
-- `authenticated` alone and revoked from PUBLIC.
create or replace function authenticate_api_token(p_token_hash text)
returns table (client_id uuid, tenant_id uuid, scopes text[])
language sql security definer set search_path = public as $$
  select c.id, c.tenant_id, c.scopes from api_clients c
  where c.token_hash = p_token_hash and c.active;
$$;

revoke all on function authenticate_api_token(text) from public;
grant execute on function authenticate_api_token(text) to authenticated;
