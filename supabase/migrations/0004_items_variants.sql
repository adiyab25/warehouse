-- 0004_items_variants: what the backbone holds — sellable kids-wear, the
-- kindergarten's consumables, and the durable assets — plus the scannable
-- variants a branch actually scans, and the min/max levels kept per place.
--
-- Two tables carry the product master:
--
--   * `items` is the *concept* — "girls' summer dress", "A4 copy paper". One
--     row per thing, owned by a family (`sellable`, `consumable`, `asset`) and
--     a category. It has no code of its own: the thing a person scans is a
--     variant.
--
--   * `item_variants` is the *scan target* — the concrete size/colour/SKU/
--     barcode a branch actually handles. An item with no size or colour still
--     gets exactly one variant, with an empty `attrs` object, so every scan
--     resolves to a variant and nothing downstream has to special-case the
--     "simple" products.
--
-- `location_levels` hangs a min/max off one (item, location) pair — the
-- reorder policy for a branch or the warehouse.
--
-- Every table here copies the shape 0002 established and 0003 repeated:
--   * `tenant_id uuid not null references tenants(id)`
--   * a policy
--       `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
--     carrying BOTH `using` and `with check`
--   * `alter table <t> force row level security`
--
-- The `nullif(…, '')` is load-bearing, not decoration. Once a placeholder GUC
-- like `app.tenant_id` has been assigned inside a transaction, Postgres keeps
-- the placeholder after the transaction ends and reverts it to the empty string
-- — so on a *warm* pooled connection (one that has already served a withTenant)
-- a bare query sees `current_setting('app.tenant_id', true) = ''` and a plain
-- `::uuid` cast raises `invalid input syntax for type uuid: ""`, while a cold
-- connection returns NULL and simply matches no rows. `nullif(…, '')` turns the
-- reverted `''` back into NULL so the policy behaves identically warm or cold:
-- zero rows, never an error.
--
-- `force row level security` matters because a table's OWNER bypasses its own
-- RLS policies. Migrations are applied by the owner (scripts/migrate.mjs), so
-- without FORCE the policies would not bind the owner at all; FORCE closes that
-- gap so even an owner connection is subject to the policy.

create table items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name_ar text not null,
  name_en text,
  family text not null check (family in ('sellable', 'consumable', 'asset')),
  category text,
  uom text not null default 'unit',
  -- How many base units are in one purchasing pack (e.g. 500 sheets to a ream).
  -- Null for items bought and held one-for-one.
  pack_factor numeric(12, 3),
  -- A discrete item is counted in whole units; a non-discrete one (bulk) is
  -- measured. Defaults on, which is right for kids-wear and paper alike.
  discrete boolean not null default true,
  cost_egp numeric(12, 2) not null default 0,
  supplier text,
  lead_time_days int,
  -- A serialised item (an asset with a unique tag) is tracked one-by-one.
  serialised boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table items enable row level security;
alter table items force row level security;

create policy items_tenant_isolation on items
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on items to authenticated;

create table item_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  item_id uuid not null references items(id) on delete restrict,
  -- `sku` and `barcode` are the identifiers a person TYPES or SCANS, so they
  -- are stored CANONICALISED: upper-cased and trimmed. `unique (tenant_id,
  -- sku)` and `unique (tenant_id, barcode)` are only case- and
  -- whitespace-sensitive by default, so without normalising, 'AB-0012',
  -- 'ab-0012' and 'AB-0012 ' would be three distinct barcodes — silently
  -- splitting one product's stock across three rows (exactly the bug 0003
  -- fixed for location codes). The CHECKs make that impossible even for a raw
  -- SQL insert that bypasses src/db/items.ts.
  sku text not null constraint item_variants_sku_normalised_check check (sku = upper(btrim(sku))),
  barcode text not null constraint item_variants_barcode_normalised_check check (barcode = upper(btrim(barcode))),
  -- Size, colour, and any other distinguishing attribute. An item with none of
  -- those still gets a variant whose attrs is the empty object, so a scan always
  -- resolves to a variant and callers never special-case "simple" products.
  attrs jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  unique (tenant_id, sku),
  unique (tenant_id, barcode)
);

alter table item_variants enable row level security;
alter table item_variants force row level security;

create policy item_variants_tenant_isolation on item_variants
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on item_variants to authenticated;

create table location_levels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  item_id uuid not null references items(id),
  location_id uuid not null references locations(id),
  min_qty numeric(12, 3),
  max_qty numeric(12, 3),
  -- Exactly one level per (item, location) in a tenant: the unique index is what
  -- lets `setLocationLevel` upsert with `on conflict (tenant_id, item_id,
  -- location_id) do update` instead of racing a second row into existence.
  unique (tenant_id, item_id, location_id)
);

alter table location_levels enable row level security;
alter table location_levels force row level security;

create policy location_levels_tenant_isolation on location_levels
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on location_levels to authenticated;
