import type { Queryable } from './client.ts';

/**
 * THE REPLENISHMENT READ SIDE — what is below its minimum, and how fast it goes.
 * READ-ONLY. Rules (each one a bug an earlier task shipped and review caught):
 *
 *   (1) ABSENT ON-HAND ROW MEANS ZERO. `on_hand` only has rows where movements
 *       exist, so an item with a minimum at a location that NEVER held stock has
 *       no row — and is the MOST below-minimum thing there is. The query is driven
 *       FROM `location_levels` and LEFT JOINs the balance, `coalesce(.., 0)`; an
 *       inner join would silently drop exactly the worst cases.
 *   (2) QUANTITIES ARE EXACT numeric STRINGS and every comparison/sum/division is
 *       done in SQL, never in JavaScript. The ONE exception is `consumptionRate`,
 *       whose plan-mandated return type is `number`: it is converted from the
 *       SQL `float8` at the very edge and nothing is ever computed from it in JS.
 *   (3) A UNIT IS COUNTED ONCE. See {@link OUTFLOW_SQL} for the precise definition.
 *   (4) STOCK IN TRANSIT IS NOT THE BRANCH'S YET: on-hand is the balance AT the
 *       location; the `transit` location's balance is never added in.
 *   (5) Aliases, not casts (`as "nameAr"`); bounded + deterministically ordered;
 *       inactive items/variants and levels with a null minimum are ignored.
 *
 * ROLE SCOPING is the CALLER's job (`src/app/reports/handler.ts` passes the
 * session's branch as `locationId`), exactly like `src/db/usage.ts`.
 */

/** How many rows the report shows before it says it is truncating. */
export const REPLENISHMENT_LIMIT = 500;

/** The default look-back for a consumption rate, in days. */
export const DEFAULT_RATE_DAYS = 30;

/** Largest window accepted — keeps `days * interval '1 day'` far from overflow. */
const MAX_DAYS = 3650;

/** The location types a reorder policy is evaluated for (the ones with a defined outflow). */
const POLICY_TYPES = "('warehouse', 'branch')";

function assertDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new Error(`days must be a whole number between 1 and ${MAX_DAYS} (got ${JSON.stringify(days)})`);
  }
}

/**
 * OUTFLOW — the quantity that LEFT a location's hands in the window, as one SQL
 * scalar subquery. `itemExpr` / `locExpr` / `typeExpr` are SQL expressions for the
 * item id, location id and location TYPE; `daysParam` is the `$n` of the window.
 *
 *   * BRANCH: movements with reason `consumption` FROM that branch.
 *   * WAREHOUSE: the ARRIVAL leg of `issue_to_branch` — the transit -> branch
 *     movement, recognised by the DESTINATION location's TYPE being `branch`.
 *     Goods reach a branch in two ledger legs (warehouse -> transit and
 *     transit -> branch), BOTH reason `issue_to_branch`; counting both would show
 *     the same units twice, and a unit still in transit has not left yet. The
 *     filter is on TYPE, never on a name, so renaming transit cannot re-break it.
 *   * Any other location type: nothing (no defined outflow).
 *
 * It sums over ALL of the item's variants (history counts even for a variant
 * since retired). The warehouse figure is network-wide arrivals, since the
 * arrival leg's source is transit, not the warehouse; with one warehouse per
 * tenant that is the warehouse's outflow.
 */
function outflowSql(itemExpr: string, locExpr: string, typeExpr: string, daysParam: string): string {
  return `(
    select coalesce(sum(m.qty), 0)
      from stock_movements m
      join item_variants ov on ov.id = m.variant_id and ov.tenant_id = m.tenant_id
      left join locations d on d.id = m.to_location_id and d.tenant_id = m.tenant_id
     where ov.item_id = ${itemExpr}
       and m.occurred_at >= now() - (${daysParam}::int * interval '1 day')
       and (
         (${typeExpr} = 'branch' and m.reason = 'consumption' and m.from_location_id = ${locExpr})
         or (${typeExpr} = 'warehouse' and m.reason = 'issue_to_branch' and d.type = 'branch')
       )
  )`;
}

/** One (item, location) whose balance is at or below its minimum. */
export interface BelowMinimumRow {
  itemId: string;
  /** The item's Arabic name — asserted non-empty by the contract test. */
  nameAr: string;
  locationId: string;
  /** The location's Arabic name — asserted non-empty. */
  location: string;
  /** Balance AT the location (transit excluded), exact `numeric(12,3)` STRING; '0.000' if never held. */
  onHand: string;
  /** The minimum, exact `numeric(12,3)` STRING. */
  minQty: string;
  /** Average outflow per day over the window, `numeric(12,3)` STRING, or `null` when there is no history. */
  ratePerDay: string | null;
  /**
   * Days of stock = onHand / rate, one decimal, computed IN SQL. `'0.0'` when
   * nothing is on hand (no stock is zero days, whatever the rate); `null` — "no
   * cover figure" — when stock exists but the rate is zero. Never a division
   * error, never Infinity.
   */
  coverDays: string | null;
}

export interface BelowMinimumOptions {
  /** Narrow to one location — how a `branch_user` is confined to their branch. */
  locationId?: string | null;
  /** Look-back for the rate/cover. Default {@link DEFAULT_RATE_DAYS}. */
  days?: number;
  /** Row bound. Default {@link REPLENISHMENT_LIMIT}. */
  limit?: number;
}

/**
 * One (item, location) pair's standing against its minimum — the SAME
 * definition {@link belowMinimum} reports on: on-hand is summed across the
 * item's ACTIVE variants, the item must be active with an active variant, the
 * location must be a policy location (warehouse/branch) and the level must
 * carry a minimum. Returns `null` when the pair is not tracked under that
 * definition (so it can never alert). `atOrBelow` is decided in SQL on exact
 * numerics. Quantities are strings.
 *
 * Call it with the scoped `db`; callers that compare before/after for an
 * EDGE must hold an item-level advisory lock around both reads.
 */
export async function itemLevelAt(
  db: Queryable,
  itemId: string,
  locationId: string,
): Promise<{ onHand: string; minQty: string; atOrBelow: boolean } | null> {
  const { rows } = await db.query<{ onHand: string; minQty: string; atOrBelow: boolean }>(
    `select round(coalesce(oh.qty, 0), 3)::text as "onHand",
            ll.min_qty::numeric(12,3)::text as "minQty",
            coalesce(oh.qty, 0) <= ll.min_qty as "atOrBelow"
       from location_levels ll
       join items i on i.id = ll.item_id and i.tenant_id = ll.tenant_id and i.active
       join locations l on l.id = ll.location_id and l.tenant_id = ll.tenant_id
       left join lateral (
         select sum(o.qty) as qty
           from on_hand o
           join item_variants v on v.id = o.variant_id
          where v.item_id = ll.item_id and v.active and o.location_id = ll.location_id
       ) oh on true
      where ll.item_id = $1 and ll.location_id = $2
        and ll.min_qty is not null
        and exists (select 1 from item_variants av where av.item_id = ll.item_id and av.active)
        and l.type in ${POLICY_TYPES}`,
    [itemId, locationId],
  );
  return rows[0] ?? null;
}

/**
 * Every (item, location) AT OR BELOW its minimum, lowest cover first.
 *
 * `onHand <= minQty` is inclusive on purpose: an item exactly at its minimum is
 * due for a reorder. Levels with a null minimum, inactive items and locations
 * that are not a warehouse/branch are ignored; only ACTIVE variants' balances
 * count. ORDER: cover ascending (unknown cover last), then on-hand, then item
 * name, location name and both ids as tie-breaks, so paging/truncation is stable.
 *
 * Call with the scoped `db` from inside `withTenant`. To prove truncation the
 * caller asks for `limit + 1`.
 */
export async function belowMinimum(db: Queryable, options: BelowMinimumOptions = {}): Promise<BelowMinimumRow[]> {
  const days = options.days ?? DEFAULT_RATE_DAYS;
  assertDays(days);
  const { rows } = await db.query<BelowMinimumRow>(
    `with base as (
       select i.id as item_id,
              i.name_ar as name_ar,
              l.id as location_id,
              l.name_ar as location_name,
              coalesce(oh.qty, 0) as on_hand,
              ll.min_qty as min_qty,
              ${outflowSql('ll.item_id', 'll.location_id', 'l.type', '$2')} / $2::numeric as rate
         from location_levels ll
         join items i on i.id = ll.item_id and i.tenant_id = ll.tenant_id and i.active
         join locations l on l.id = ll.location_id and l.tenant_id = ll.tenant_id
         left join lateral (
           select sum(o.qty) as qty
             from on_hand o
             join item_variants v on v.id = o.variant_id
            where v.item_id = ll.item_id and v.active and o.location_id = ll.location_id
         ) oh on true
        where ll.min_qty is not null
          and exists (select 1 from item_variants av where av.item_id = ll.item_id and av.active)
          and l.type in ${POLICY_TYPES}
          and ($1::uuid is null or ll.location_id = $1)
          and coalesce(oh.qty, 0) <= ll.min_qty
     )
     select item_id as "itemId",
            name_ar as "nameAr",
            location_id as "locationId",
            location_name as "location",
            on_hand::numeric(12,3) as "onHand",
            min_qty::numeric(12,3) as "minQty",
            case when rate > 0 then round(rate, 3)::text end as "ratePerDay",
            case when on_hand <= 0 then '0.0'
                 when rate > 0 then round(on_hand / rate, 1)::text
            end as "coverDays"
       from base
      order by case when on_hand <= 0 then 0 when rate > 0 then on_hand / rate end asc nulls last,
               on_hand asc, name_ar, location_name, item_id, location_id
      limit $3`,
    [options.locationId ?? null, days, options.limit ?? REPLENISHMENT_LIMIT],
  );
  return rows;
}

/**
 * Average units per day an item leaves a location, over the last `days` days:
 * `sum(outflow) / days`, computed in SQL (see {@link outflowSql} for exactly what
 * counts). No history is `0`, not an error.
 *
 * EDGE CONVERSION: the plan's contract is `Promise<number>`, so the SQL result is
 * cast to `float8` and returned as the JS number pg parses it. That is the only
 * place a quantity becomes a JS number; the screens use the exact strings from
 * {@link belowMinimum}, never this.
 */
export async function consumptionRate(
  db: Queryable,
  input: { itemId: string; locationId: string; days: number },
): Promise<number> {
  assertDays(input.days);
  const { rows } = await db.query<{ rate: number | null }>(
    `select (${outflowSql('$1::uuid', 'l.id', 'l.type', '$3')} / $3::numeric)::float8 as "rate"
       from locations l
      where l.id = $2`,
    [input.itemId, input.locationId, input.days],
  );
  return rows[0]?.rate ?? 0;
}
