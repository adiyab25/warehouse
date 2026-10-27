-- 0006_receipts: receiving goods against an expected document.
--
-- The warehouse manager receives goods from the factory (or a supplier) against
-- a delivery note. Two numbers matter and they are NOT the same number:
--
--   * what was EXPECTED — the delivery note says 40 shirts;
--   * what actually ARRIVED — 36 came off the van.
--
-- A system that stores only one number absorbs the shortfall silently. So the
-- receipt holds BOTH, and the difference is a GENERATED column the app reports
-- rather than a value anyone can overwrite.
--
--   * `receipts`      — the header: who sent it, where it went, the delivery
--                       note number, and whether it has been posted yet.
--   * `receipt_lines` — one row per variant, carrying `expected_qty` and
--                       `received_qty`. `variance_qty` is
--                       `coalesce(received_qty, 0) - expected_qty`, STORED, so
--                       a short delivery is `-4` for ever and cannot be edited
--                       into an exact match.
--
-- Copies the RLS shape 0002 established and 0003/0004/0005 repeated:
--   * `tenant_id uuid not null references tenants(id)`
--   * a policy `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
--     carrying BOTH `using` and `with check`
--   * `alter table <t> force row level security`
--   * explicit `grant select, insert, update, delete` to `authenticated`, and
--     an explicit revoke of the three privileges RLS cannot govern.
--
-- EVERY foreign key between tenant-scoped tables is COMPOSITE — `(tenant_id,
-- …)` — pointing at a `unique (tenant_id, id)` on the referenced table. A plain
-- single-column FK accepts another tenant's id, so a receipt in tenant A could
-- name tenant B's warehouse or variant. The composite key makes the database
-- refuse that. `receipts` therefore carries its own `unique (tenant_id, id)`
-- for `receipt_lines` to point at; `locations`, `item_variants` and `app_users`
-- already carry theirs (0003 and 0005).

create table receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- Where the goods came FROM — normally the factory, modelled as a `vendor`
  -- location. A receipt is a TRANSFER, so this is not null.
  source_location_id uuid not null,
  -- Where they arrived — normally the warehouse.
  dest_location_id uuid not null,
  -- The delivery-note number a person TYPES off the paperwork. Human-typed,
  -- therefore stored CANONICALISED (trimmed, upper-cased) and enforced by the
  -- CHECK below — exactly the rule 0003/0004/0005 applied to codes and refs.
  -- Without normalising, 'DN-7', 'dn-7' and ' DN-7 ' would be three different
  -- notes for one delivery.
  ref_no text,
  -- A receipt is a two-step document: it is created as a `draft` (the expected
  -- lines are entered, goods may still be arriving) and posted once, which is
  -- when the ledger is written and the header becomes frozen truth.
  status text not null default 'draft' constraint receipts_status_check check (status in ('draft', 'posted')),
  -- Who received the goods, and when. Set on post.
  received_by uuid,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  -- Redundant against the primary key alone, but `receipt_lines`' composite FK
  -- needs a unique constraint on exactly these columns to point at — and
  -- pointing at it is what stops a line in tenant A from hanging off a receipt
  -- in tenant B.
  unique (tenant_id, id),
  constraint receipts_ref_no_normalised_check
    check (ref_no is null or ref_no = upper(btrim(ref_no))),
  -- Tenant-scoped composites. A receipt in tenant A may name only tenant-A
  -- locations and a tenant-A receiver.
  foreign key (tenant_id, source_location_id) references locations (tenant_id, id),
  foreign key (tenant_id, dest_location_id) references locations (tenant_id, id),
  foreign key (tenant_id, received_by) references app_users (tenant_id, id)
);

alter table receipts enable row level security;
alter table receipts force row level security;

create policy receipts_tenant_isolation on receipts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on receipts to authenticated;

-- Belt and braces with the reset runner's default-ACL fix. TRUNCATE is not
-- governed by RLS at all, so one `truncate public.receipts` as the app role
-- would empty EVERY tenant's receipts at once; REFERENCES/TRIGGER would let the
-- app role attach constraints and triggers. A receipt is not append-only (its
-- lines are filled in as goods arrive), so there is no BEFORE TRUNCATE trigger
-- here — the revoke is the whole guard.
revoke truncate, references, trigger on receipts from authenticated;

create table receipt_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  receipt_id uuid not null,
  variant_id uuid not null,
  -- What the delivery note said. Not null: a receipt line always expects
  -- SOMETHING (a line expecting nothing is a mistake, not a zero).
  expected_qty numeric(12, 3) not null,
  -- What actually arrived. Null until the line is received, so \"not yet
  -- counted\" is distinct from \"counted zero\".
  received_qty numeric(12, 3),
  -- The reported difference, DERIVED on write and stored: this is the number a
  -- person sees on the discrepancy report, and being GENERATED it cannot be set
  -- by hand or quietly edited to hide a shortfall. `coalesce(…, 0)` so an
  -- as-yet-unreceived line reads as a full shortfall of `-expected_qty` rather
  -- than NULL.
  variance_qty numeric(12, 3) generated always as (coalesce(received_qty, 0) - expected_qty) stored,
  -- One line per variant per receipt. Also what makes `createReceipt` atomic
  -- in practice: a duplicate variant makes the SECOND insert fail and the whole
  -- transaction roll back, leaving no orphan header.
  unique (tenant_id, receipt_id, variant_id),
  -- Delete the header and its lines go with it.
  foreign key (tenant_id, receipt_id) references receipts (tenant_id, id) on delete cascade,
  -- Every reference is tenant-scoped: a line in tenant A may only name a
  -- tenant-A variant.
  foreign key (tenant_id, variant_id) references item_variants (tenant_id, id)
);

alter table receipt_lines enable row level security;
alter table receipt_lines force row level security;

create policy receipt_lines_tenant_isolation on receipt_lines
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on receipt_lines to authenticated;

revoke truncate, references, trigger on receipt_lines from authenticated;

-- The read that answers \"what is on this delivery note?\" — by receipt.
create index receipt_lines_receipt_id_idx on receipt_lines (receipt_id);

-- The delivery-note number is looked up per tenant (e.g. to spot a re-issued
-- note). Not unique: the same note number could legitimately be recorded more
-- than once, and a partial index on the non-null case keeps the many blank
-- notes out of it.
create index receipts_tenant_ref_no_idx on receipts (tenant_id, ref_no)
  where ref_no is not null;
