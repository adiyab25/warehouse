-- 0009_counts: STOCKTAKE. Someone counts a shelf.
--
-- A count is not an edit of a number — it is three recorded moments:
--
--   * what the system EXPECTED at the instant the session opened — FROZEN, so a
--     movement posted while the sheets are out can never move the target the
--     counter was measured against (a moving goalpost makes every variance a
--     fiction);
--   * what was actually COUNTED on the shelf;
--   * the DIFFERENCE, posted on close as ONE ledger movement, so the ledger
--     stays the single source of truth and the correction is visible, dated and
--     attributable — never a silent overwrite of `on_hand`.
--
--   * `count_sessions` — the header: which location is being counted, who
--                        started it, when, and who closed it.
--   * `count_lines`    — one row per variant, carrying the frozen
--                        `expected_qty` and the `counted_qty` (NULL until the
--                        shelf is counted). `variance_qty` is
--                        `coalesce(counted_qty, 0) - expected_qty`, GENERATED
--                        and STORED, so a shortfall is fixed the moment it is
--                        recorded and cannot be edited into a match.
--
-- A NULL `counted_qty` means NOT YET COUNTED — deliberately distinct from
-- "counted zero". src/db/counts.ts::closeCount treats an uncounted line as "not
-- counted" and posts NOTHING for it; a phantom write-off of stock nobody looked
-- at is the worst thing a stocktake can do, so the app filters those lines out
-- explicitly (the generated `variance_qty` would otherwise read `-expected_qty`
-- for them and look like a full loss).
--
-- Copies the RLS shape 0002 established and 0003-0008 repeated:
--   * `tenant_id uuid not null references tenants(id)`
--   * a policy `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
--     carrying BOTH `using` and `with check`
--   * `alter table <t> force row level security`
--   * explicit `grant select, insert, update, delete` to `authenticated`, and
--     an explicit revoke of the three privileges RLS cannot govern.
--
-- EVERY foreign key between tenant-scoped tables is COMPOSITE — `(tenant_id,
-- …)` — pointing at a `unique (tenant_id, id)` on the referenced table. A plain
-- single-column FK accepts another tenant's id, so a session in tenant A could
-- name tenant B's location, user or variant. `count_sessions` therefore carries
-- its own `unique (tenant_id, id)` for `count_lines` to point at; `locations`,
-- `item_variants` and `app_users` already carry theirs (0003/0005).

create table count_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- The location whose shelf is being counted. Tenant-scoped composite FK below.
  location_id uuid not null,
  -- `open` while lines are being recorded (a shelf can be counted, and counted
  -- again, before it is closed); `closed` once the variances have been posted.
  -- `closed` is TERMINAL — the trigger at the foot of this file refuses any move
  -- back out of it, so a frozen count cannot be reopened and rewritten.
  status text not null default 'open'
    constraint count_sessions_status_check check (status in ('open', 'closed')),
  -- Who started the count, and when. Written on open (the app REQUIRES an
  -- author); the composite FK keeps the author in THIS tenant.
  started_by uuid,
  started_at timestamptz not null default now(),
  -- Who closed it, and when. Set by close; NULL until then.
  closed_by uuid,
  closed_at timestamptz,
  -- Redundant against the primary key alone, but `count_lines`' composite FK
  -- needs a unique constraint on exactly these columns to point at — and
  -- pointing at it is what stops a line in tenant A from hanging off a session
  -- in tenant B.
  unique (tenant_id, id),
  -- Tenant-scoped composites. A session in tenant A may name only tenant-A
  -- locations and tenant-A users.
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  foreign key (tenant_id, started_by) references app_users (tenant_id, id),
  -- The closer is nullable (NULL until closed); a composite FK with a NULL
  -- column is simply not enforced. When set it must be a user of THIS tenant.
  foreign key (tenant_id, closed_by) references app_users (tenant_id, id)
);

alter table count_sessions enable row level security;
alter table count_sessions force row level security;

create policy count_sessions_tenant_isolation on count_sessions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on count_sessions to authenticated;

-- Belt and braces with the reset runner's default-ACL fix. TRUNCATE is not
-- governed by RLS at all, so one `truncate public.count_sessions` as the app
-- role would empty EVERY tenant's sessions at once; REFERENCES/TRIGGER would let
-- the app role attach constraints and triggers.
revoke truncate, references, trigger on count_sessions from authenticated;

create table count_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  count_session_id uuid not null,
  variant_id uuid not null,
  -- What the system EXPECTED at the moment the line was created — frozen. For a
  -- variant snapshotted when the session opened it is the on-hand at open time;
  -- for a variant COUNTED for the first time mid-session it is the on-hand at
  -- that instant. Either way a movement posted afterwards never moves it.
  --
  -- NOT NULL, but deliberately NOT positive: a variant that is not on the
  -- system's books can still be physically on the shelf (found stock), so a
  -- count of it is a legitimate line with expected 0.
  expected_qty numeric(12, 3) not null,
  -- What was actually counted. NULL until the shelf is counted — distinct from
  -- "counted zero", which is what lets closeCount tell an uncounted line from a
  -- deliberate zero.
  counted_qty numeric(12, 3),
  -- The reported difference, DERIVED on write and stored: the number a person
  -- sees on the variance report, and being GENERATED it cannot be set by hand or
  -- quietly edited to hide a shortfall. Shortage (fewer found than expected) is
  -- negative, surplus (found stock) positive.
  variance_qty numeric(12, 3) generated always as (coalesce(counted_qty, 0) - expected_qty) stored,
  -- One line per variant per session. Also what makes the app's upsert in
  -- recordCount land on ONE line however many times a shelf is counted.
  unique (tenant_id, count_session_id, variant_id),
  -- Delete the session and its lines go with it (only an OPEN session with no
  -- written movements may be deleted — see the delete guard below).
  foreign key (tenant_id, count_session_id) references count_sessions (tenant_id, id) on delete cascade,
  -- Every reference is tenant-scoped: a line in tenant A may only name a
  -- tenant-A variant, so a count can never be recorded against another tenant's
  -- item (the composite FK is what refuses it).
  foreign key (tenant_id, variant_id) references item_variants (tenant_id, id)
);

alter table count_lines enable row level security;
alter table count_lines force row level security;

create policy count_lines_tenant_isolation on count_lines
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on count_lines to authenticated;

revoke truncate, references, trigger on count_lines from authenticated;

-- The read that answers "what is on this count sheet?" — by session.
create index count_lines_count_session_id_idx on count_lines (count_session_id);

-- The read that answers "what have we counted at this location, and when?" —
-- by tenant and location.
create index count_sessions_tenant_location_id_idx on count_sessions (tenant_id, location_id);

-- A CLOSED SESSION IS FROZEN AND UNDELETABLE. TWO triggers close the two holes
-- proven against the live schema in Tasks 6-8:
--
--   * a session could be moved OUT of `closed` with a raw UPDATE, reopening a
--     document whose variances have already been posted to the ledger. The
--     status guard makes `closed` TERMINAL: the flow never runs backwards.
--   * a session with written movements could be DELETED — its lines cascaded
--     away while the ledger rows it posted (`ref_type = 'COUNT', ref_id =
--     <session>`) survived as orphans the `on_hand` view still counted.
--     `ref_id` is POLYMORPHIC (one column pointing at receipts, requisitions,
--     counts and more), so no foreign key can ever catch it. The delete guard
--     refuses the deletion itself. Deleting an OPEN session with no movements
--     (a session opened by mistake) is still allowed — only a CLOSED session, or
--     one whose movement already landed, is frozen; undoing it is a correcting
--     document, never an edit or a delete.
--
-- Both raise `restrict_violation`, matching the ledger's append-only guard, and
-- both are named so a caller sees WHY rather than a bare error.

create function count_sessions_closed_is_terminal() returns trigger
language plpgsql as $$
begin
  if old.status = 'closed' and new.status is distinct from 'closed' then
    raise exception
      'count_sessions: session % is closed and terminal — its status cannot change from ''closed'' to ''%''; post a correcting document instead of reopening a posted count',
      new.id, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger count_sessions_closed_is_terminal
  before update on count_sessions
  for each row execute function count_sessions_closed_is_terminal();

create function count_sessions_no_delete_written() returns trigger
language plpgsql as $$
begin
  if old.status = 'closed' or exists (
    select 1 from stock_movements
     where ref_type = 'COUNT' and ref_id = old.id
  ) then
    raise exception
      'count_sessions: session % is closed (or has written stock movements) and cannot be deleted — the document is frozen; ref_id is polymorphic so nothing else can catch the orphan',
      old.id
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

create trigger count_sessions_no_delete_written
  before delete on count_sessions
  for each row execute function count_sessions_no_delete_written();

-- A CLOSED SESSION'S LINES ARE FROZEN TOO. The status guard above freezes the
-- header, but without this a raw INSERT/UPDATE/DELETE could still edit the
-- numbers a closed count was audited against. This refuses any change to a line
-- whose session is `closed`; while the session is `open` (or already gone, on a
-- cascade from a legitimately deleted open session) the change is allowed.
create function count_lines_frozen_when_closed() returns trigger
language plpgsql as $$
declare
  session_status text;
  session_id uuid;
begin
  -- NEW is not assigned on DELETE and OLD is not assigned on INSERT, so read the
  -- session id from whichever side the operation actually provides.
  if tg_op = 'DELETE' then
    session_id := old.count_session_id;
  else
    session_id := new.count_session_id;
  end if;

  select status into session_status
    from count_sessions
   where id = session_id;
  -- No row (the session is being deleted in a cascade) or an open session:
  -- nothing to freeze.
  if session_status is distinct from 'closed' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  raise exception
    'count_lines: the session for % is closed — its lines are frozen and cannot be changed',
    session_id
    using errcode = 'restrict_violation';
end;
$$;

create trigger count_lines_frozen_when_closed
  before insert or update or delete on count_lines
  for each row execute function count_lines_frozen_when_closed();
