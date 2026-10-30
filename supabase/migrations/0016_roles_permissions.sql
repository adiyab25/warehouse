-- 0016_roles_permissions: Role-based permission system (P1 1A).
--
-- Replaces hard-coded role enum with owner-created named roles.
-- 3 seed roles: owner (all), manager (receive/approve/issue/counts/reports), branch (requisitions/confirm/usage/own reports).

-- permissions table (global, not tenant-scoped)
create table permissions (
  key text primary key,
  description text not null,
  created_at timestamptz not null default now()
);

-- roles table (tenant-scoped)
create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

alter table roles enable row level security;
alter table roles force row level security;

create policy roles_tenant_isolation on roles
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on roles to authenticated;
revoke truncate, references, trigger on roles from authenticated;

-- role_permissions junction
create table role_permissions (
  role_id uuid not null,
  tenant_id uuid not null,
  permission_key text not null references permissions(key),
  primary key (role_id, permission_key),
  foreign key (tenant_id, role_id) references roles (tenant_id, id)
);

alter table role_permissions enable row level security;
alter table role_permissions force row level security;

create policy role_permissions_tenant_isolation on role_permissions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on role_permissions to authenticated;
revoke truncate, references, trigger on role_permissions from authenticated;

-- Add role_id to app_users (nullable first)
alter table app_users add column role_id uuid;

-- Populate role_id from existing role enum
-- (will be done by seed migration; for now just add the column)

-- Seed permissions
insert into permissions (key, description) values
  ('auth:users:view', 'View users'),
  ('auth:users:manage', 'Manage users'),
  ('auth:roles:manage', 'Manage roles'),
  ('catalog:items:view', 'View items'),
  ('catalog:items:manage', 'Manage items'),
  ('locations:locations:view', 'View locations'),
  ('locations:locations:manage', 'Manage locations'),
  ('ledger:stock:view', 'View stock'),
  ('receiving:intake:view', 'View intake'),
  ('receiving:intake:create', 'Create intake'),
  ('requisitions:requisitions:view', 'View requisitions'),
  ('requisitions:requisitions:create', 'Create requisitions'),
  ('requisitions:requisitions:approve', 'Approve requisitions'),
  ('requisitions:requisitions:issue', 'Issue requisitions'),
  ('requisitions:requisitions:confirm', 'Confirm requisitions'),
  ('requisitions:requisitions:cancel', 'Cancel requisitions'),
  ('returns:returns:view', 'View returns'),
  ('returns:returns:create', 'Create returns'),
  ('returns:returns:process', 'Process returns'),
  ('counts:counts:view', 'View counts'),
  ('counts:counts:create', 'Create counts'),
  ('counts:counts:post', 'Post counts'),
  ('branch-usage:usage:view', 'View usage'),
  ('branch-usage:usage:create', 'Create usage'),
  ('reports:reports:basic', 'Basic reports'),
  ('reports:reports:cost', 'Cost reports'),
  ('reports:reports:audit', 'Audit reports'),
  ('api:api:manage', 'Manage API keys'),
  ('settings:settings:manage', 'Manage settings'),
  ('transfers:transfers:create', 'Create transfers'),
  ('transfers:transfers:approve', 'Approve transfers')
on conflict (key) do nothing;
