-- 0008_returns: the REVERSE direction — goods coming BACK and goods written off.
--
-- Nothing here needs a new table. Every return, restock, quarantine or write-off
-- is an ORDINARY LEDGER MOVEMENT: a row in `stock_movements`, posted through
-- `postMovement`, so nothing vanishes from the records. A branch returning stock
-- is a two-sided transfer row (`from_location_id` = branch, `to_location_id` =
-- warehouse/quarantine/scrap) and a write-off is the same, with `reason =
-- 'write_off'`. The disposition that decides the destination lives in
-- src/db/returns.ts; the destination LOCATIONS (quarantine, scrap) are per-tenant
-- singletons created on demand exactly like the transit location (0003/…/0007) —
-- NOT rows this migration seeds, because a tenant does not exist at migration
-- time.
--
-- The `reason` list already carries `return_from_branch` and `write_off` (0005)
-- and the location `type` list already carries `quarantine` and `scrap` (0003),
-- so this file adds no column, no table and no CHECK. See rule 5 of the task:
-- the one genuine change is the index below.

-- RETURN-BY-REFERENCE LOOKUPS. Every return carries a polymorphic
-- (`ref_type`, `ref_id`) back to the document it came from — a requisition, a
-- customer return, a count — and the read that answers "what came back against
-- this document?" filters on exactly those two columns. Before this, the only
-- index on the ledger was `(variant_id, occurred_at desc)` (0005), so that read
-- was a full scan of an append-only table that only ever grows. (Checked first:
-- no `(ref_type, ref_id)` index existed in 0005-0007.) Plain, not partial: a
-- lookup may name just `ref_type` (all returns of a kind) as well as the pair,
-- and a partial index on `ref_id is not null` would not serve the former.
create index stock_movements_ref_type_ref_id_idx
  on stock_movements (ref_type, ref_id);

-- A return is normalised the same way every other human-typed identifier in the
-- backbone is (0003 codes, 0004 skus, 0005/0006 refs): `ref_type` is trimmed and
-- upper-cased by `postMovement`, and the `stock_movements_ref_type_normalised_
-- check` from 0005 already refuses an un-normalised value even for a raw insert.
-- There is no new text column in this task, so no new CHECK is added here — the
-- existing one covers the return reference too.
