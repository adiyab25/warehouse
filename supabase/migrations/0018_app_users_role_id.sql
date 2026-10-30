-- 0018_app_users_role_id: Add role_id FK to app_users, populate from role enum.

-- Add role_id column (nullable first)
alter table app_users add column if not exists role_id uuid;

-- Populate role_id from existing role enum
update app_users
set role_id = (
  select r.id from roles r
  where r.tenant_id = app_users.tenant_id
    and r.name = case app_users.role
      when 'owner' then 'Owner'
      when 'manager' then 'Manager'
      when 'branch' then 'Branch'
      else 'Branch'
    end
);

-- Make role_id NOT NULL
alter table app_users alter column role_id set not null;

-- Add composite FK
alter table app_users
  add constraint app_users_role_id_fkey
  foreign key (tenant_id, role_id) references roles (tenant_id, id);

-- Create unique constraint for composite FK
-- (roles already has unique (tenant_id, id) from 0016)

-- Drop old role column (keep for now, will remove in later migration)
-- alter table app_users drop column role;
