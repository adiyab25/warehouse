-- 0026_permission_gate: make the permission tables the SOURCE OF TRUTH.
--
-- Before this migration the roles/permissions tables existed but nothing read
-- them: routes still authorised off the hard-coded `app_users.role` enum, and
-- `role_id` was optional, so a user created without one had NO permissions and
-- no check could ever have resolved. Three defects are fixed here:
--
--   1. `app_users.role_id` was backfilled by 0018 with the WRONG names — the
--      enum values are `warehouse_manager` / `branch_user`, but 0018 compared
--      against `manager` / `branch`, so every warehouse manager silently fell
--      into the `else 'Branch'` arm and was given the BRANCH role. That is a
--      privilege DOWNGRADE for managers and an UPGRADE for anyone the `else`
--      happened to favour. Corrected below, and mapped by the same CASE the
--      trigger uses, so there is one mapping and not two.
--
--   2. Nothing guaranteed a new tenant had the three seed roles, so any tenant
--      created after 0017 (every test tenant) had zero roles and could never
--      grant a permission.
--
--   3. Nothing filled `role_id` for a new user, so `role_permissions` lookups
--      found nothing and every permission check failed closed — which is why
--      the app could not switch to permissions without breaking every account
--      that was created by a plain insert.
--
-- Both triggers are SECURITY DEFINER owned by the migration role (a superuser
-- in local and managed setups alike), because `roles` has FORCE ROW LEVEL
-- SECURITY: an invoker-rights trigger inserting seed roles during a tenant
-- insert would be refused by the policy, since there is no `app.tenant_id`
-- pinned at the moment a tenant is being created.

-- ---------------------------------------------------------------------------
-- 1. Every new tenant is born with its three seed roles.
-- ---------------------------------------------------------------------------

create or replace function public.tenants_seed_roles()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform seed_default_roles(new.id);
  return new;
end;
$$;

drop trigger if exists tenants_seed_roles on tenants;
create trigger tenants_seed_roles
  after insert on tenants
  for each row execute function public.tenants_seed_roles();

-- Tenants that already exist and somehow missed seeding (0017 ran before they
-- were created, or seeding was interrupted).
do $$
declare
  t record;
begin
  for t in
    select ten.id
      from tenants ten
     where not exists (select 1 from roles r where r.tenant_id = ten.id)
  loop
    perform seed_default_roles(t.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Every user resolves to a role. The enum is an INPUT, never the authority.
-- ---------------------------------------------------------------------------

create or replace function public.app_users_fill_role_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  if new.role_id is null then
    v_name := case new.role
      when 'owner' then 'Owner'
      when 'warehouse_manager' then 'Manager'
      when 'branch_user' then 'Branch'
      else null
    end;

    if v_name is not null then
      select r.id into new.role_id
        from roles r
       where r.tenant_id = new.tenant_id
         and r.name = v_name;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists app_users_fill_role_id on app_users;
create trigger app_users_fill_role_id
  before insert or update of role, role_id on app_users
  for each row execute function public.app_users_fill_role_id();

-- Correct the rows 0018 mis-mapped. This is the SAME mapping the trigger uses.
update app_users u
   set role_id = r.id
  from roles r
 where r.tenant_id = u.tenant_id
   and r.name = case u.role
     when 'owner' then 'Owner'
     when 'warehouse_manager' then 'Manager'
     else 'Branch'
   end;

-- ---------------------------------------------------------------------------
-- 3. The seed matrix, corrected to match the business rule it documents.
--    A branch raises a request and confirms what arrived; the warehouse
--    approves and issues. Confirming is not the warehouse's act — 0017 gave
--    the Manager role `requisitions:requisitions:confirm`, which would have let
--    a manager acknowledge their own issue and close a document the branch
--    never saw.
-- ---------------------------------------------------------------------------

delete from role_permissions rp
 using roles r
 where rp.role_id = r.id
   and r.name = 'Manager'
   and rp.permission_key = 'requisitions:requisitions:confirm';

-- Index the checks the gate will now make on every request.
create index if not exists app_users_role_id_idx on app_users (role_id);
create index if not exists role_permissions_key_idx on role_permissions (permission_key);
