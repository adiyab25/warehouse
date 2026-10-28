-- 0013: the events OUTBOX (Task 18a).
--
--   * `domain_events`       — facts the API/app announce (a movement posted, a
--                              level crossed). Written by `emit()` in the SAME
--                              transaction as the thing it announces, so there
--                              is never a movement without its event nor an
--                              event for a rolled-back movement. Append-only,
--                              except that `delivered_at` may be stamped.
--   * `event_subscriptions` — where an integration wants events delivered.
--                              Delivery itself is NOT built yet.
--
-- Every house rule: tenant_id not null, enable + FORCE RLS, policy with BOTH
-- using and with check, unique (tenant_id, id), composite tenant-scoped FKs,
-- explicit grants, no truncate/references/trigger privilege for the app role.

create table domain_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- Closed list, kept in lockstep with src/domain/events.ts.
  type text not null constraint domain_events_type_check
    check (type in ('movement.posted', 'requisition.status_changed', 'stock.low')),
  -- Ids, codes and quantities as STRINGS; never tokens, hashes or emails.
  payload jsonb not null constraint domain_events_payload_object_check
    check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (tenant_id, id)
);

-- The delivery worker's read: undelivered events, oldest first, per tenant.
create index domain_events_undelivered_idx
  on domain_events (tenant_id, occurred_at)
  where delivered_at is null;

alter table domain_events enable row level security;
alter table domain_events force row level security;

create policy domain_events_tenant_isolation on domain_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- No DELETE for the app role (an outbox row is history); UPDATE is limited to
-- the one column a delivery worker may stamp.
grant select, insert on domain_events to authenticated;
-- Default privileges hand `authenticated` TABLE-level UPDATE on every new table; a column grant on
-- top of that would be decorative. Take the table-level right away FIRST, then grant the one column.
revoke update on domain_events from authenticated;
grant update (delivered_at) on domain_events to authenticated;
revoke delete, truncate, references, trigger on domain_events from authenticated;

-- Defence in depth behind the grants: only `delivered_at` may ever change,
-- nothing may be deleted or emptied (a later grant mistake stays harmless).
create function domain_events_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'delivered_at') is distinct from (to_jsonb(old) - 'delivered_at') then
      raise exception 'domain_events is append-only: only delivered_at may change'
        using errcode = 'restrict_violation';
    end if;
    -- delivered_at is WRITE-ONCE: NULL -> a value, never cleared or changed (no "un-delivering").
    if old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at then
      raise exception 'domain_events.delivered_at is write-once: it cannot be cleared or changed'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  raise exception 'domain_events is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger domain_events_no_update_except_delivered
  before update on domain_events
  for each row execute function domain_events_guard();

create trigger domain_events_no_delete
  before delete on domain_events
  for each row execute function domain_events_guard();

create trigger domain_events_no_truncate
  before truncate on domain_events
  for each statement execute function domain_events_guard();

-- Webhook URL screen. DEFENCE IN DEPTH ONLY: a DNS name can still point at a private address and can
-- change after this check (DNS rebinding), so the future delivery worker MUST STILL resolve the host
-- and check the resulting IP at connect time. Here we refuse what is visible in the text:
-- userinfo, backslashes, any bracketed IPv6 literal, localhost/*.localhost/*.internal/*.local, and
-- IPv4 literals in 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16. Any other
-- numeric-looking host (decimal, hex, octal, short forms like 127.1) is refused as an obfuscated IP.
create function event_url_is_allowed(url text) returns boolean
language plpgsql immutable as $$
declare
  authority text;
  host text;
  a int;
  b int;
begin
  if url !~ '^https://[^[:space:]]+$' or position(chr(92) in url) > 0 then return false; end if;
  authority := substring(url from '^https://([^/?#]*)');
  if authority is null or authority = '' or position('@' in authority) > 0 or left(authority, 1) = '[' then
    return false;
  end if;
  host := regexp_replace(regexp_replace(lower(authority), ':[0-9]*$', ''), '[.]+$', '');
  if host = '' or host ~ '(^|[.])(localhost|internal|local)$' then return false; end if;
  if host ~ '^(0x[0-9a-f]+|[0-9]+)([.](0x[0-9a-f]+|[0-9]+))*$' then
    -- numeric-looking: only a plain dotted quad of decimal octets (no leading zeros) may pass, and
    -- only if it is outside the private/loopback/link-local ranges.
    if host !~ '^(0|[1-9][0-9]{0,2})([.](0|[1-9][0-9]{0,2})){3}$' then return false; end if;
    a := split_part(host, '.', 1)::int;
    b := split_part(host, '.', 2)::int;
    if a > 255 or b > 255 or split_part(host, '.', 3)::int > 255 or split_part(host, '.', 4)::int > 255 then
      return false;
    end if;
    if a in (0, 10, 127)
       or (a = 100 and b between 64 and 127)
       or (a = 169 and b = 254)
       or (a = 172 and b between 16 and 31)
       or (a = 192 and b = 168) then
      return false;
    end if;
  end if;
  return true;
end;
$$;

create table event_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  client_id uuid not null,
  event_type text not null constraint event_subscriptions_event_type_check
    check (event_type in ('movement.posted', 'requisition.status_changed', 'stock.low')),
  url text not null constraint event_subscriptions_url_https_check
    check (length(url) <= 2048 and event_url_is_allowed(url)),
  active boolean not null default true,
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references api_clients (tenant_id, id)
);

comment on column event_subscriptions.url is
  'Outbound webhook target. https only; no userinfo, no literal loopback/private/link-local/IPv6 host (event_url_is_allowed) - DEFENCE IN DEPTH, not SSRF protection. A delivery worker MUST add SSRF protection (resolve and refuse private/loopback/link-local addresses, no redirects to them, short timeouts) before it ever calls this URL; none is built yet.';

create index event_subscriptions_lookup_idx
  on event_subscriptions (tenant_id, event_type) where active;

alter table event_subscriptions enable row level security;
alter table event_subscriptions force row level security;

create policy event_subscriptions_tenant_isolation on event_subscriptions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on event_subscriptions to authenticated;
revoke truncate, references, trigger on event_subscriptions from authenticated;
