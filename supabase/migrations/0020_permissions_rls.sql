-- 0020: Add RLS to permissions table (global, readable by all authenticated).
alter table permissions enable row level security;
alter table permissions force row level security;

create policy permissions_read_all on permissions
  for select
  using (true);

grant select on permissions to authenticated;
revoke insert, update, delete, truncate, references, trigger on permissions from authenticated;
