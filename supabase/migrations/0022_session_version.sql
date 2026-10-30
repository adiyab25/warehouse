-- 0022: Add session_version to roles for permission-change invalidation.
alter table roles add column if not exists session_version int not null default 1;

-- Add session_version to sessions table for invalidation check.
alter table sessions add column if not exists role_session_version int;
