-- 0021: Fix permissions RLS policy to have both USING and WITH CHECK.
drop policy if exists permissions_read_all on permissions;
create policy permissions_all on permissions
  using (true)
  with check (true);
