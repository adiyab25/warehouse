-- 0007_requisitions: a branch ASKS the warehouse for stock; the warehouse
-- approves, ISSUES (warehouse -> transit), and the branch CONFIRMS RECEIPT
-- (transit -> branch). Fourteen branches draw from one warehouse, and none of
-- them simply takes what it wants.
--
-- Two numbers matter and they are NOT the same number:
--
--   * what the branch REQUESTED — it asks for 40 shirts;
--   * what the warehouse actually RELEASED — 36 went on the van.
--
-- A system that stores only one number absorbs the difference silently. So a
-- requisition holds BOTH, per line, and the flow keeps three quantities that
-- must not be conflated:
--
--   * `requested_qty` — the branch's ask;
--   * `approved_qty`  — what the warehouse agreed to (may be less), NULL if it
--                       simply approved the ask;
--   * `issued_qty`    — what actually left the warehouse;
--   * `received_qty`  — what actually arrived at the branch.
--
--   * `requisitions`      — the header: which branch, who asked, who approved,
--                           where in the flow, and the timestamps of each step.
--   * `requisition_lines` — one row per variant carrying the four quantities and
--                           a per-line status.
--
-- THE POINT OF `transit`: stock a branch has asked for but not yet confirmed is
-- NOT the branch's. The issue leg moves it warehouse -> transit and the confirm
-- leg moves it transit -> branch. While it sits in transit it is a number the
-- app can see (and, more importantly, one the app CANNOT see as the branch's):
-- a loss on the road is a visible shortfall, not an invisible disappearance.
--
-- Copies the RLS shape 0002 established and 0003-0006 repeated:
--   * `tenant_id uuid not null references tenants(id)`
--   * a policy `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
--     carrying BOTH `using` and `with check`
--   * `alter table <t> force row level security`
--   * explicit `grant select, insert, update, delete` to `authenticated`, and
--     an explicit revoke of the three privileges RLS cannot govern.
--
-- EVERY foreign key between tenant-scoped tables is COMPOSITE — `(tenant_id,
-- …)` — pointing at a `unique (tenant_id, id)` on the referenced table. A plain
-- single-column FK accepts another tenant's id, so a requisition in tenant A
-- could name tenant B's branch, variant or approver. `requisitions` therefore
-- carries its own `unique (tenant_id, id)` for `requisition_lines` to point at;
-- `locations`, `item_variants` and `app_users` already carry theirs (0003/0005).

create table requisitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- The branch the stock is FOR. Tenant-scoped composite FK below.
  branch_location_id uuid not null,
  -- The flow. The state machine lives in src/domain/requisition.ts and is
  -- enforced AGAIN here by the trigger at the foot of this file, so no raw
  -- UPDATE can drive a requisition backwards or reopen a terminal one:
  --   requested -> approved | rejected
  --   approved  -> issued | partially_issued
  --   partially_issued -> issued | partially_issued
  --   issued    -> received
  --   received  -> closed | returned
  --   closed, rejected, returned are TERMINAL.
  -- `partially_issued` is NATIVE: issuing some lines but not others leaves the
  -- requisition open rather than silently complete.
  status text not null default 'requested' constraint requisitions_status_check check (
    status in (
      'requested',
      'approved',
      'partially_issued',
      'issued',
      'received',
      'closed',
      'rejected',
      'returned'
    )
  ),
  -- Who asked, and when. `requested_by` is NOT NULL: a requisition always has an
  -- author, so a caller cannot forget to record one. Written on create.
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  -- Who approved it, and when. Set on approve. NULL while still `requested`.
  approved_by uuid,
  approved_at timestamptz,
  -- The timestamp of each later step, stamped as the flow advances so the
  -- history is readable without a join to the ledger.
  issued_at timestamptz,
  received_at timestamptz,
  closed_at timestamptz,
  notes text,
  -- Redundant against the primary key alone, but `requisition_lines`' composite
  -- FK needs a unique constraint on exactly these columns to point at — and
  -- pointing at it is what stops a line in tenant A from hanging off a
  -- requisition in tenant B.
  unique (tenant_id, id),
  -- Tenant-scoped composites. A requisition in tenant A may name only tenant-A
  -- locations and tenant-A users.
  foreign key (tenant_id, branch_location_id) references locations (tenant_id, id),
  foreign key (tenant_id, requested_by) references app_users (tenant_id, id),
  -- The approver is nullable (NULL until approved); a composite FK with a NULL
  -- column is simply not enforced.
  foreign key (tenant_id, approved_by) references app_users (tenant_id, id)
);

alter table requisitions enable row level security;
alter table requisitions force row level security;

create policy requisitions_tenant_isolation on requisitions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on requisitions to authenticated;

-- Belt and braces with the reset runner's default-ACL fix. TRUNCATE is not
-- governed by RLS at all, so one `truncate public.requisitions` as the app role
-- would empty EVERY tenant's requisitions at once; REFERENCES/TRIGGER would let
-- the app role attach constraints and triggers.
revoke truncate, references, trigger on requisitions from authenticated;

create table requisition_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  requisition_id uuid not null,
  variant_id uuid not null,
  -- What the branch asked for. Not null AND POSITIVE: a line that requests
  -- nothing is a mistake, not a zero — the CHECK enforces the floor, matching
  -- createRequisition's validation.
  requested_qty numeric(12, 3) not null constraint requisition_lines_requested_qty_positive_check check (requested_qty > 0),
  -- What the warehouse agreed to release. NULL until approved (or forever, if
  -- the warehouse simply approved the ask); when set it becomes the target a
  -- line is measured against.
  approved_qty numeric(12, 3),
  -- What actually left the warehouse, and what actually arrived at the branch.
  -- Both default to 0 so an untouched line reads as nothing-issued rather than
  -- NULL: "not issued yet" is zero here, not unknown.
  issued_qty numeric(12, 3) not null default 0,
  received_qty numeric(12, 3) not null default 0,
  -- Per-line state. `fulfilled` only once the line has been issued (and, after
  -- receipt, received) IN FULL — `issued_qty = requested_qty` or `approved_qty`
  -- when set. `short` is a line that came up short; `open` is a line the
  -- warehouse has not finished; `rejected` a line the warehouse refused.
  status text not null default 'open' constraint requisition_lines_status_check check (
    status in ('open', 'rejected', 'fulfilled', 'short')
  ),
  -- One line per variant per requisition. Also what makes `createRequisition`
  -- atomic in practice: a duplicate variant makes the SECOND insert fail and the
  -- whole transaction roll back, leaving no orphan header.
  unique (tenant_id, requisition_id, variant_id),
  -- Delete the header and its lines go with it.
  foreign key (tenant_id, requisition_id) references requisitions (tenant_id, id) on delete cascade,
  -- Every reference is tenant-scoped: a line in tenant A may only name a
  -- tenant-A variant.
  foreign key (tenant_id, variant_id) references item_variants (tenant_id, id)
);

alter table requisition_lines enable row level security;
alter table requisition_lines force row level security;

create policy requisition_lines_tenant_isolation on requisition_lines
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on requisition_lines to authenticated;

revoke truncate, references, trigger on requisition_lines from authenticated;

-- The read that answers "what is on this requisition?" — by requisition.
create index requisition_lines_requisition_id_idx on requisition_lines (requisition_id);

-- The read a branch makes most often: "what have I asked for, and where is it?"
create index requisitions_tenant_branch_id_idx on requisitions (tenant_id, branch_location_id);

-- A DOCUMENT THAT HAS WRITTEN MOVEMENTS IS FROZEN AND UNDELETABLE. TWO triggers
-- enforce the two holes proven against the live schema in Task 6:
--
--   * a requisition could be DELETED once it had issued or received stock — its
--     lines cascaded away while the ledger rows it wrote (`ref_type =
--     'REQUISITION', ref_id = <requisition>`) survived as orphans the `on_hand`
--     view still counted. `ref_id` is POLYMORPHIC (one column pointing at
--     receipts, requisitions, counts and more), so no foreign key can ever catch
--     it. The delete guard refuses the deletion itself, for any status that has
--     written movements — i.e. anything past `approved`.
--   * the status could be moved BACKWARDS with a raw UPDATE (`issued ->
--     approved`), reopening a document whose stock has left the building. The
--     status guard allows ONLY the state-machine transitions above: closed,
--     rejected and returned are terminal, and the flow never runs in reverse.
--
-- Both raise `restrict_violation`, matching the ledger's append-only guard, and
-- both are named so a caller sees WHY rather than a bare error. Deleting a
-- `requested`, `approved` or `rejected` requisition (no movements written yet)
-- is still allowed — only one past approval is frozen; undoing it is a
-- correcting document, never an edit or a delete.

create function requisitions_no_delete_issued() returns trigger
language plpgsql as $$
begin
  if old.status not in ('requested', 'approved', 'rejected') then
    raise exception
      'requisitions: requisition % has written stock movements (status ''%'') and cannot be deleted — the document is frozen; ref_id is polymorphic so nothing else can catch the orphan',
      old.id, old.status
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

create trigger requisitions_no_delete_issued
  before delete on requisitions
  for each row execute function requisitions_no_delete_issued();

create function requisitions_status_is_forward_only() returns trigger
language plpgsql as $$
begin
  -- A non-status update (setting a timestamp, editing notes) is always fine.
  if new.status = old.status then
    return new;
  end if;

  if not (
       (old.status = 'requested'        and new.status in ('approved', 'rejected'))
    or (old.status = 'approved'         and new.status in ('issued', 'partially_issued'))
    or (old.status = 'partially_issued' and new.status in ('issued', 'partially_issued'))
    or (old.status = 'issued'           and new.status = 'received')
    or (old.status = 'received'         and new.status in ('closed', 'returned'))
  ) then
    raise exception
      'requisitions: requisition % cannot move from ''%'' to ''%'' — that transition is not allowed by the state machine; the flow never runs backwards and closed/rejected/returned are terminal',
      new.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger requisitions_status_is_forward_only
  before update on requisitions
  for each row execute function requisitions_status_is_forward_only();
