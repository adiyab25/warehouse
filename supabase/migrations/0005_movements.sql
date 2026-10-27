-- 0005_movements: the append-only ledger, and the derived on-hand view.
--
-- Every quantity in this backbone is DERIVED from `stock_movements`. Nothing
-- writes a balance column anywhere: stock arrives as a row, and `on_hand` is
-- the signed sum of those rows. A single movement is one of:
--
--   * a RECEIPT      — stock into one location (`to_location_id` set, no from)
--   * an OPENING     — likewise, one side only (an opening balance)
--   * a TRANSFER     — stock moving FROM one location TO another (both set)
--   * an ISSUE       — stock leaving one location (from set, no to)
--
-- `from_location_id is not null or to_location_id is not null` allows the
-- one-sided cases; `from_location_id is distinct from to_location_id` forbids
-- a movement that moves stock from a place to itself.
--
-- The ledger is APPEND-ONLY. A correction is a NEW compensating row, never an
-- edit: a trigger raises on UPDATE and on DELETE, so the history a count is
-- audited against cannot be rewritten after the fact.
--
-- Copies the RLS shape 0002 established and 0003/0004 repeated:
--   * `tenant_id uuid not null references tenants(id)`
--   * a policy `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
--     carrying BOTH `using` and `with check`
--   * `alter table <t> force row level security`
--   * explicit `grant … to authenticated`

-- 0004 gave `item_variants` a primary key but not the `unique (tenant_id, id)`
-- the COMPOSITE foreign keys below need to point at. Add it now (locations
-- already carried one from 0003; app_users gains one for the actor link).
alter table item_variants
  add constraint item_variants_tenant_id_id_key unique (tenant_id, id);

alter table app_users
  add constraint app_users_tenant_id_id_key unique (tenant_id, id);

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- Tenant-scoped composite FK: a movement in tenant A must point at a variant
  -- in tenant A. A plain `references item_variants(id)` would accept another
  -- tenant's id — the same class of hole 0003 and 0004 closed.
  variant_id uuid not null,
  -- The magnitude of the move. Always positive: the DIRECTION is carried by
  -- which side (from/to) is set, not by the sign, so a negative qty cannot be
  -- used to smuggle in a second way of saying the same thing.
  qty numeric(12, 3) not null constraint stock_movements_qty_positive_check check (qty > 0),
  from_location_id uuid,
  to_location_id uuid,
  -- The closed reason list. Anything outside it is a data-entry bug, not a new
  -- kind of movement, so it is refused at the database.
  reason text not null constraint stock_movements_reason_check check (
    reason in (
      'receipt',
      'issue_to_branch',
      'transfer',
      'return_from_branch',
      'consumption',
      'sale',
      'count_correction',
      'write_off',
      'opening_balance'
    )
  ),
  actor_user_id uuid,
  -- No FK yet: `api_clients` does not exist until Task 10. The column is here
  -- now so later tasks do not have to alter the (append-only) ledger's shape.
  actor_api_client_id uuid,
  occurred_at timestamptz not null default now(),
  -- What the movement is *about* — a purchase order, a count sheet. Human-typed,
  -- so stored canonicalised (see the CHECK below).
  ref_type text,
  ref_id uuid,
  -- A client-supplied key that makes a retried POST idempotent. Machine-issued
  -- (never human-typed), so it is stored verbatim and matched case-sensitively.
  idempotency_key text,
  notes text,
  -- A movement must touch at least one location: a receipt / opening balance is
  -- legitimately one-sided (`to` only, or `from` only), and a write-off may be
  -- one-sided too — but a row that names NEITHER location moves nothing.
  constraint stock_movements_has_a_side_check check (
    from_location_id is not null or to_location_id is not null
  ),
  -- Never from a place to the same place. `is distinct from` (not `<>`) so a
  -- NULL on either side is simply not a violation rather than a NULL result the
  -- check would silently accept.
  constraint stock_movements_sides_differ_check check (
    from_location_id is distinct from to_location_id
  ),
  -- `ref_type` is human-typed, so it is stored trimmed and upper-cased — exactly
  -- the rule 0003/0004 applied to location codes and skus. The CHECK makes it
  -- impossible even for a raw SQL insert that bypasses src/db/movements.ts.
  constraint stock_movements_ref_type_normalised_check check (
    ref_type is null or ref_type = upper(btrim(ref_type))
  ),
  foreign key (tenant_id, variant_id) references item_variants (tenant_id, id),
  foreign key (tenant_id, from_location_id) references locations (tenant_id, id),
  foreign key (tenant_id, to_location_id) references locations (tenant_id, id),
  -- The actor is tenant-scoped too: a movement in tenant A must not record an
  -- actor from tenant B. Composite (needs the `unique (tenant_id, id)` on
  -- app_users added above). NULL actor_user_id is not enforced.
  foreign key (tenant_id, actor_user_id) references app_users (tenant_id, id)
);

alter table stock_movements enable row level security;
alter table stock_movements force row level security;

create policy stock_movements_tenant_isolation on stock_movements
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on stock_movements to authenticated;

-- Dedupe: a re-sent movement carrying the same client key lands once. Partial,
-- so the many rows with no key at all never collide with each other.
create unique index stock_movements_tenant_idempotency_key_idx
  on stock_movements (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- The read that answers "what is the story of this variant?" — newest first.
create index stock_movements_variant_occurred_at_idx
  on stock_movements (variant_id, occurred_at desc);

-- The ledger is APPEND-ONLY: a trigger raises on UPDATE and on DELETE.
-- Corrections are new compensating rows, never edits.
create function stock_movements_append_only() returns trigger
language plpgsql as $$
begin
  raise exception
    'stock_movements is append-only: % is not permitted (post a compensating row instead)',
    tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger stock_movements_no_update
  before update on stock_movements
  for each row execute function stock_movements_append_only();

create trigger stock_movements_no_delete
  before delete on stock_movements
  for each row execute function stock_movements_append_only();

-- A movement may only reference an ACTIVE item/variant. A withdrawn product
-- must not receive stock — the same deactivation lesson Task 4 learned for the
-- scan path, enforced here for the write path. A CHECK cannot see another
-- table, so this is a trigger.
create function stock_movements_require_active() returns trigger
language plpgsql as $$
declare
  v_active boolean;
  i_active boolean;
begin
  select v.active, i.active
    into v_active, i_active
    from item_variants v
    join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
   where v.id = new.variant_id
     and v.tenant_id = new.tenant_id;

  if not found then
    -- Either the variant does not exist, or it belongs to another tenant. Both
    -- are refused — but by the composite foreign key below, not here, so the
    -- cross-tenant case reports the FK that actually stops it. Return the row
    -- and let the constraint do its job.
    return new;
  end if;
  if not i_active then
    raise exception 'stock_movements: the item for variant % is inactive and cannot receive a movement',
      new.variant_id
      using errcode = 'restrict_violation';
  end if;
  if not v_active then
    raise exception 'stock_movements: variant % is inactive and cannot receive a movement',
      new.variant_id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger stock_movements_require_active
  before insert on stock_movements
  for each row execute function stock_movements_require_active();

-- `on_hand`: per (variant, location) the signed sum of the ledger — `+qty`
-- where the movement arrives, `-qty` where it leaves. A transfer contributes a
-- negative delta to its `from` and a positive one to its `to`, from the SAME
-- row, so a branch's receipt and the warehouse's issue cannot drift apart.
--
-- `security_invoker = true` is LOAD-BEARING, not decoration. A view with the
-- default (security_invoker = false) executes its body with the VIEW OWNER's
-- privileges — the migration owner here, a superuser — and a superuser bypasses
-- row level security entirely, so `select * from on_hand` would hand every
-- signed-in tenant a view of ALL tenants' stock. Setting security_invoker makes
-- the view run as the CALLER, so the RLS policy on `stock_movements` filters it
-- exactly as it would a direct read. (The RLS convention guard cannot see this:
-- a view is not a base table, so it is not reflected over.)
create view on_hand with (security_invoker = true) as
with deltas as (
  select variant_id, to_location_id as location_id, qty as delta
    from stock_movements
   where to_location_id is not null
  union all
  select variant_id, from_location_id as location_id, -qty as delta
    from stock_movements
   where from_location_id is not null
)
select variant_id,
       location_id,
       sum(delta) as qty
  from deltas
 group by variant_id, location_id;

grant select on on_hand to authenticated;

-- `stock_snapshots`: a frozen as-of quantity for one (variant, location). The
-- ledger stays the truth; a snapshot is a cache the reconciliation task can
-- compare against. Created here so the shape is fixed, but NOT populated in
-- this task.
create table stock_snapshots (
  tenant_id uuid not null references tenants(id),
  variant_id uuid not null,
  item_id uuid not null,
  location_id uuid not null,
  as_of date not null,
  qty numeric(12, 3),
  -- One snapshot per (variant, location) per day. `tenant_id` is not part of
  -- the key because variant_id already carries the tenant (composite FK below),
  -- so two tenants' variants can never share an id.
  primary key (variant_id, location_id, as_of),
  -- Every reference is tenant-scoped: a snapshot in tenant A may point only at
  -- tenant-A rows.
  foreign key (tenant_id, variant_id) references item_variants (tenant_id, id),
  foreign key (tenant_id, item_id) references items (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);

alter table stock_snapshots enable row level security;
alter table stock_snapshots force row level security;

create policy stock_snapshots_tenant_isolation on stock_snapshots
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on stock_snapshots to authenticated;
