-- 0017_seed_default_roles: Create owner/manager/branch roles for all existing tenants.
-- Each tenant gets 3 seed roles with default permission sets.

-- Function to seed default roles for a tenant
create or replace function seed_default_roles(p_tenant_id uuid) returns void
language plpgsql as $$
declare
  v_owner_id uuid;
  v_manager_id uuid;
  v_branch_id uuid;
begin
  -- Owner role (all permissions)
  insert into roles (tenant_id, name, description)
  values (p_tenant_id, 'Owner', 'Full access to everything')
  on conflict (tenant_id, name) do nothing
  returning id into v_owner_id;

  if v_owner_id is null then
    select id into v_owner_id from roles where tenant_id = p_tenant_id and name = 'Owner';
  end if;

  -- Manager role
  insert into roles (tenant_id, name, description)
  values (p_tenant_id, 'Manager', 'Receive, approve, issue, counts, reports')
  on conflict (tenant_id, name) do nothing
  returning id into v_manager_id;

  if v_manager_id is null then
    select id into v_manager_id from roles where tenant_id = p_tenant_id and name = 'Manager';
  end if;

  -- Branch role
  insert into roles (tenant_id, name, description)
  values (p_tenant_id, 'Branch', 'Requisitions, confirm, usage, own reports')
  on conflict (tenant_id, name) do nothing
  returning id into v_branch_id;

  if v_branch_id is null then
    select id into v_branch_id from roles where tenant_id = p_tenant_id and name = 'Branch';
  end if;

  -- Owner gets all permissions
  insert into role_permissions (role_id, tenant_id, permission_key)
  select v_owner_id, p_tenant_id, key from permissions
  on conflict (role_id, permission_key) do nothing;

  -- Manager permissions
  insert into role_permissions (role_id, tenant_id, permission_key) values
    (v_manager_id, p_tenant_id, 'auth:users:view'),
    (v_manager_id, p_tenant_id, 'catalog:items:view'),
    (v_manager_id, p_tenant_id, 'locations:locations:view'),
    (v_manager_id, p_tenant_id, 'ledger:stock:view'),
    (v_manager_id, p_tenant_id, 'receiving:intake:view'),
    (v_manager_id, p_tenant_id, 'receiving:intake:create'),
    (v_manager_id, p_tenant_id, 'requisitions:requisitions:view'),
    (v_manager_id, p_tenant_id, 'requisitions:requisitions:approve'),
    (v_manager_id, p_tenant_id, 'requisitions:requisitions:issue'),
    (v_manager_id, p_tenant_id, 'requisitions:requisitions:confirm'),
    (v_manager_id, p_tenant_id, 'returns:returns:view'),
    (v_manager_id, p_tenant_id, 'returns:returns:create'),
    (v_manager_id, p_tenant_id, 'returns:returns:process'),
    (v_manager_id, p_tenant_id, 'counts:counts:view'),
    (v_manager_id, p_tenant_id, 'counts:counts:create'),
    (v_manager_id, p_tenant_id, 'counts:counts:post'),
    (v_manager_id, p_tenant_id, 'branch-usage:usage:view'),
    (v_manager_id, p_tenant_id, 'branch-usage:usage:create'),
    (v_manager_id, p_tenant_id, 'reports:reports:basic'),
    (v_manager_id, p_tenant_id, 'reports:reports:cost'),
    (v_manager_id, p_tenant_id, 'reports:reports:audit')
  on conflict (role_id, permission_key) do nothing;

  -- Branch permissions
  insert into role_permissions (role_id, tenant_id, permission_key) values
    (v_branch_id, p_tenant_id, 'catalog:items:view'),
    (v_branch_id, p_tenant_id, 'locations:locations:view'),
    (v_branch_id, p_tenant_id, 'ledger:stock:view'),
    (v_branch_id, p_tenant_id, 'requisitions:requisitions:view'),
    (v_branch_id, p_tenant_id, 'requisitions:requisitions:create'),
    (v_branch_id, p_tenant_id, 'requisitions:requisitions:confirm'),
    (v_branch_id, p_tenant_id, 'requisitions:requisitions:cancel'),
    (v_branch_id, p_tenant_id, 'returns:returns:view'),
    (v_branch_id, p_tenant_id, 'returns:returns:create'),
    (v_branch_id, p_tenant_id, 'branch-usage:usage:view'),
    (v_branch_id, p_tenant_id, 'branch-usage:usage:create'),
    (v_branch_id, p_tenant_id, 'reports:reports:basic')
  on conflict (role_id, permission_key) do nothing;
end;
$$;

-- Seed for all existing tenants
do $$
declare
  t record;
begin
  for t in select id from tenants loop
    perform seed_default_roles(t.id);
  end loop;
end;
$$;
