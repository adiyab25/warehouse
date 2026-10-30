-- 0025_audit_log: Audit trail for all mutations.
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  actor_user_id uuid,
  actor_api_client_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  old_values jsonb,
  new_values jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table audit_log enable row level security;
alter table audit_log force row level security;

create policy audit_log_tenant_isolation on audit_log
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert on audit_log to authenticated;
revoke update, delete, truncate, references, trigger on audit_log from authenticated;

create index audit_log_tenant_created_idx on audit_log (tenant_id, created_at desc);
create index audit_log_entity_idx on audit_log (tenant_id, entity_type, entity_id);
