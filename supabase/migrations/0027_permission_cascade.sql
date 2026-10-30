-- 0027_permission_cascade: a tenant's roles die with the tenant.
--
-- 0016/0018 created three foreign keys between tenants, roles, role_permissions
-- and app_users with no delete rule, so `delete from tenants` — what every test
-- fixture and any tenant offboarding does — failed the moment 0026 started
-- giving every tenant its seed roles. Postgres refused the parent delete rather
-- than orphaning rows, which is right; the missing piece was the rule.
--
-- The rule, in dependency order:
--   tenants        -> roles             ON DELETE CASCADE
--   roles          -> role_permissions  ON DELETE CASCADE
--   roles          -> app_users.role_id RESTRICT (deliberately)
--
-- A USER IS NOT DELETED BY DELETING THEIR ROLE. Removing a role someone still
-- holds is a mistake an owner must see (reassign first), not a silent deletion
-- of the person's account and thereby of the history they signed.

-- Rows left behind by earlier resets/failed cleanups: a role whose tenant no
-- longer exists cannot be reached, cannot be assigned (the composite FK on
-- app_users needs a live tenant), and would block the FK below.
delete from role_permissions rp
 where not exists (
   select 1 from roles r join tenants t on t.id = r.tenant_id where r.id = rp.role_id
 );
delete from roles r
 where not exists (select 1 from tenants t where t.id = r.tenant_id);

alter table roles
  drop constraint roles_tenant_id_fkey;
alter table roles
  add constraint roles_tenant_id_fkey
  foreign key (tenant_id) references tenants(id) on delete cascade;

alter table role_permissions
  drop constraint role_permissions_tenant_id_role_id_fkey;
alter table role_permissions
  add constraint role_permissions_tenant_id_role_id_fkey
  foreign key (tenant_id, role_id) references roles (tenant_id, id) on delete cascade;
