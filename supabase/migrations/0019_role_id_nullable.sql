-- 0019: Make role_id nullable (tests and legacy code may not set it yet).
alter table app_users alter column role_id drop not null;
