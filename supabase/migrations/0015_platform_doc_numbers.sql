-- 0015_platform_doc_numbers: human document numbers.
--
-- Every document (receipt, requisition, count session, ...) gets a
-- human-readable, gap-free number per (tenant, kind, year), e.g.
-- RCV-2026-0001. Numbers are generated under a row lock so concurrent
-- creation cannot collide or leave gaps.

create table doc_sequences (
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null,
  year int not null,
  next int not null default 1,
  primary key (tenant_id, kind, year)
);

alter table doc_sequences enable row level security;
alter table doc_sequences force row level security;

create policy doc_sequences_tenant_isolation on doc_sequences
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on doc_sequences to authenticated;
revoke truncate, references, trigger on doc_sequences from authenticated;

-- Gap-free number generator. Locks the sequence row for the current tenant/kind/year.
create or replace function next_doc_number(p_kind text) returns text
language plpgsql as $$
declare
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_year int := extract(year from current_date)::int;
  v_prefix text := case p_kind
    when 'receipt' then 'RCV'
    when 'requisition' then 'REQ'
    when 'transfer' then 'TRF'
    when 'return' then 'RET'
    when 'count' then 'CNT'
    when 'adjustment' then 'ADJ'
    when 'purchase_order' then 'PO'
    else upper(p_kind)
  end;
  v_next int;
begin
  insert into doc_sequences (tenant_id, kind, year, next)
  values (v_tenant, p_kind, v_year, 1)
  on conflict (tenant_id, kind, year) do nothing;

  select next into v_next
    from doc_sequences
   where tenant_id = v_tenant and kind = p_kind and year = v_year
   for update;

  update doc_sequences
     set next = next + 1
   where tenant_id = v_tenant and kind = p_kind and year = v_year;

  return v_prefix || '-' || v_year::text || '-' || lpad(v_next::text, 4, '0');
end;
$$;

grant execute on function next_doc_number(text) to authenticated;

-- Add number columns.
alter table receipts add column number text;
alter table requisitions add column number text;
alter table count_sessions add column number text;

-- Backfill.
update receipts r
   set number = 'RCV-' || extract(year from r.created_at)::int || '-' || lpad(x.rn::text, 4, '0')
  from (
    select id, tenant_id,
           row_number() over (partition by tenant_id, extract(year from created_at) order by created_at, id) as rn
      from receipts
  ) x
 where r.id = x.id and r.tenant_id = x.tenant_id;

update requisitions r
   set number = 'REQ-' || extract(year from r.requested_at)::int || '-' || lpad(x.rn::text, 4, '0')
  from (
    select id, tenant_id,
           row_number() over (partition by tenant_id, extract(year from requested_at) order by requested_at, id) as rn
      from requisitions
  ) x
 where r.id = x.id and r.tenant_id = x.tenant_id;

update count_sessions c
   set number = 'CNT-' || extract(year from c.started_at)::int || '-' || lpad(x.rn::text, 4, '0')
  from (
    select id, tenant_id,
           row_number() over (partition by tenant_id, extract(year from started_at) order by started_at, id) as rn
      from count_sessions
  ) x
 where c.id = x.id and c.tenant_id = x.tenant_id;

-- Seed sequences to max+1.
insert into doc_sequences (tenant_id, kind, year, next)
select tenant_id, 'receipt', extract(year from created_at)::int,
       coalesce(max(substring(number from '[0-9]+$')::int), 0) + 1
  from receipts
 group by tenant_id, extract(year from created_at)
on conflict (tenant_id, kind, year) do update set next = excluded.next;

insert into doc_sequences (tenant_id, kind, year, next)
select tenant_id, 'requisition', extract(year from requested_at)::int,
       coalesce(max(substring(number from '[0-9]+$')::int), 0) + 1
  from requisitions
 group by tenant_id, extract(year from requested_at)
on conflict (tenant_id, kind, year) do update set next = excluded.next;

insert into doc_sequences (tenant_id, kind, year, next)
select tenant_id, 'count', extract(year from started_at)::int,
       coalesce(max(substring(number from '[0-9]+$')::int), 0) + 1
  from count_sessions
 group by tenant_id, extract(year from started_at)
on conflict (tenant_id, kind, year) do update set next = excluded.next;

-- Enforce not null + unique per tenant.
alter table receipts alter column number set not null;
alter table requisitions alter column number set not null;
alter table count_sessions alter column number set not null;

alter table receipts add constraint receipts_number_unique unique (tenant_id, number);
alter table requisitions add constraint requisitions_number_unique unique (tenant_id, number);
alter table count_sessions add constraint count_sessions_number_unique unique (tenant_id, number);