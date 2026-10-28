import type { Queryable } from './client.ts';
import type { ItemFamily } from './items.ts';

/**
 * THE READ SIDE OF THE LEDGER — the queries behind the on-hand list and the
 * "where did it go" screen. READ-ONLY: nothing here writes a movement.
 *
 * Three rules shape every query below, and they are the rules the screens exist
 * to honour:
 *
 *   (1) MONEY AND QUANTITY ARITHMETIC HAPPENS IN THE DATABASE. `valueEgp` is
 *       `sum(qty * cost_egp)::numeric(12,2)` computed in SQL, never `qty * cost`
 *       in JavaScript — a float product of a quantity and a price yields
 *       `599.9999999999999`, which a person's accounts will not accept. Postgres
 *       money is `numeric(12,2)` and quantities `numeric(12,3)`, and pg hands
 *       numerics back as STRINGS precisely so they cannot silently become
 *       floats. Every quantity/price field here is therefore a `string`, and the
 *       screens FORMAT that string for display and never do maths on it.
 *
 *   (2) A COLUMN IS ALIASED TO THE NAME THE CALLER READS, in the SQL
 *       (`i.name_ar as "nameAr"`), or the row is mapped explicitly — never cast
 *       behind a `query<T>()` whose type declares a camelCase field the database
 *       never returned. A raw `select i.name_ar` typed as `{ nameAr }` compiles
 *       while `row.nameAr` stays `undefined` and the screen renders a blank
 *       name; the contract tests assert every joined field (name, sku, location,
 *       branch) is NON-EMPTY, not merely that a row came back.
 *
 *   (3) EVERY LIST IS BOUNDED. A real catalogue's on-hand list and a busy
 *       variant's movement history are both unbounded, so each query carries an
 *       explicit `limit` and a deterministic ORDER BY. The history orders by
 *       `seq desc` — Task 5's monotonic insertion counter — NOT by
 *       `occurred_at desc`, whose same-second ties would break arbitrarily. Each
 *       reader takes a `limit` so a caller (and a test) can prove the bound
 *       cheaply, and the screen reports what lies beyond it rather than cutting
 *       silently.
 *
 * ROLE SCOPING IS A CALLER'S JOB, not this module's: these are pure readers on
 * an already tenant-scoped `db`. A `branch_user` is narrowed by the handler
 * passing `locationId` / `branchLocationId`; RLS narrows the tenant.
 */

/** How many on-hand rows the stock list shows before it says it is truncating. */
export const ON_HAND_LIMIT = 500;

/** How many movements a variant's history shows before it says it is truncating. */
export const MOVEMENT_HISTORY_LIMIT = 200;

/** One (variant, location) balance as the stock list shows it. */
export interface OnHandRow {
  variantId: string;
  /** The stock-keeping code, rendered left-to-right (`.ltr-value`). */
  sku: string;
  /** The item's Arabic name — asserted non-empty by the contract test. */
  nameAr: string;
  /** The location's Arabic name — asserted non-empty. */
  location: string;
  /** The balance, an exact `numeric(12,3)` STRING; format it, never do maths on it. */
  qty: string;
}

/** The filters {@link onHandByLocation} accepts. Every one is optional. */
export interface OnHandFilter {
  /** Narrow to one item family (e.g. `kids_wear`). */
  family?: ItemFamily | null;
  /** Narrow to one location — how a `branch_user` is confined to their branch. */
  locationId?: string | null;
  /** Narrow to one variant — the detail screen's own on-hand block. */
  variantId?: string | null;
  /**
   * A free-text needle matched against the item's Arabic name OR the SKU, so the
   * list is searchable by name or code. Case-insensitive (`ilike`).
   */
  search?: string | null;
  /** The row bound. Defaults to {@link ON_HAND_LIMIT}. */
  limit?: number;
}

/**
 * The on-hand balance per (variant, location), from the `security_invoker`
 * `on_hand` view — the signed sum of the ledger — joined to the item's Arabic
 * name and the location's Arabic name.
 *
 * ZERO ROWS ARE OMITTED (`oh.qty <> 0`): the view returns a zero balance for a
 * pair that nets to zero, and a stock list that listed "0 of every item at every
 * location" would be both huge and useless. A pair that never appears in the
 * ledger has no view row at all and is likewise absent — absence means zero, so
 * omitting the zero rows loses no information a list needs.
 *
 * The NAME, SKU, LOCATION and QTY are all aliased to the camelCase keys this
 * returns, so the row the caller reads is the row the database sent — no cast
 * hides a column-name mismatch (see rule (2) above).
 *
 * Call it with the scoped `db` from inside `withTenant`.
 */
export async function onHandByLocation(
  db: Queryable,
  filter: OnHandFilter = {},
): Promise<OnHandRow[]> {
  const { rows } = await db.query<OnHandRow>(
    `select oh.variant_id as "variantId",
            v.sku as "sku",
            i.name_ar as "nameAr",
            l.name_ar as "location",
            oh.qty as "qty"
       from on_hand oh
       join item_variants v on v.id = oh.variant_id
       join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
       join locations l on l.id = oh.location_id and l.tenant_id = v.tenant_id
      where oh.qty <> 0
        and ($1::text is null or i.family = $1)
        and ($2::uuid is null or oh.location_id = $2)
        and ($3::uuid is null or oh.variant_id = $3)
        and (
          $4::text is null
          or i.name_ar ilike '%' || $4 || '%'
          or v.sku ilike '%' || $4 || '%'
        )
      order by i.name_ar, l.name_ar, v.sku, oh.variant_id, oh.location_id
      limit $5`,
    [
      filter.family ?? null,
      filter.locationId ?? null,
      filter.variantId ?? null,
      filter.search ?? null,
      filter.limit ?? ON_HAND_LIMIT,
    ],
  );
  return rows;
}

/** One branch's usage of one variant in a window, as the usage reader returns it. */
export interface UsageRow {
  /** The branch's Arabic name (the `issue_to_branch` destination) — non-empty. */
  branch: string;
  variantId: string;
  sku: string;
  /** The item's Arabic name — so the accounts view names WHAT was used. */
  nameAr: string;
  /** The issued quantity, an exact `numeric` STRING. */
  issuedQty: string;
  /** `issuedQty × item cost`, computed IN SQL as `numeric(12,2)` — e.g. '600.00'. */
  valueEgp: string;
}

/** The window and filters {@link usageByBranch} accepts. */
export interface UsageFilter {
  /** Window start, INCLUSIVE (ISO-8601 or a Date). */
  from: string | Date;
  /** Window end, EXCLUSIVE (ISO-8601 or a Date) — a half-open window, so two
   * adjacent windows never double-count a movement on the boundary instant. */
  to: string | Date;
  /** Narrow to one branch — how a `branch_user` sees only their own usage. */
  branchLocationId?: string | null;
  /** The row bound. Defaults to {@link ON_HAND_LIMIT}. */
  limit?: number;
}

/**
 * THE VALUE THAT ARRIVED AT EACH BRANCH IN THE WINDOW, per variant.
 *
 * SEMANTICS — COUNT EACH UNIT EXACTLY ONCE, AND ONLY WHEN IT HAS ARRIVED.
 * Goods reach a branch in TWO ledger legs, BOTH carrying reason
 * `issue_to_branch`: the issue leg moves warehouse -> TRANSIT, and the branch's
 * confirm moves TRANSIT -> branch. A reader that grouped `issue_to_branch` by
 * DESTINATION therefore attributed the SAME goods to a `transit` row AND to the
 * branch row — the same units on the report twice, inflating the money total by
 * everything currently in flight.
 *
 * The fix counts a movement ONLY when its destination is a location of type
 * `branch` — i.e. the transit -> branch (confirm) leg. So the figure is "the
 * value that ARRIVED at a branch in the window": goods still in transit
 * contribute NOTHING until they land, and a `transit` row never appears. The
 * filter is on the destination location's TYPE, never on the literal word
 * `transit`, so renaming or retyping the staging location cannot silently
 * re-introduce the double count.
 *
 * An "issue to a branch" is a movement with reason `issue_to_branch` whose
 * DESTINATION is the branch; the branch is therefore `to_location_id`, and its
 * Arabic name is the row's `branch`. `issuedQty` is `sum(qty)` and `valueEgp` is
 * `sum(qty * items.cost_egp)::numeric(12,2)` — the multiplication is done by
 * Postgres so the value is exact (`5` issued at a cost of `120` is `'600.00'`,
 * never `599.9999999999999`).
 *
 * The window is HALF-OPEN (`occurred_at >= from and occurred_at < to`). Call it
 * with the scoped `db` from inside `withTenant`.
 */
export async function usageByBranch(db: Queryable, filter: UsageFilter): Promise<UsageRow[]> {
  const { rows } = await db.query<UsageRow>(
    `select l.name_ar as "branch",
            m.variant_id as "variantId",
            v.sku as "sku",
            i.name_ar as "nameAr",
            sum(m.qty)::numeric(12,3) as "issuedQty",
            sum(m.qty * i.cost_egp)::numeric(12,2) as "valueEgp"
       from stock_movements m
       join locations l on l.id = m.to_location_id and l.tenant_id = m.tenant_id
       join item_variants v on v.id = m.variant_id and v.tenant_id = m.tenant_id
       join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
      where m.reason = 'issue_to_branch'
        and l.type = 'branch'
        and m.occurred_at >= $1
        and m.occurred_at < $2
        and ($3::uuid is null or m.to_location_id = $3)
      group by l.name_ar, m.variant_id, v.sku, i.name_ar
      order by l.name_ar, v.sku, m.variant_id
      limit $4`,
    [filter.from, filter.to, filter.branchLocationId ?? null, filter.limit ?? ON_HAND_LIMIT],
  );
  return rows;
}

/**
 * The TOTAL value of stock that ARRIVED at branches in the window, per the SAME
 * rule {@link usageByBranch} rows carry —
 * `sum(qty * items.cost_egp)::numeric(12,2)` over movements whose DESTINATION is
 * a `branch`-type location (the transit -> branch leg).
 *
 * ONE RULE, ONE NUMBER. The total and the rows must agree, so this filter is the
 * SAME as {@link usageByBranch}'s: only branch destinations are counted, so the
 * warehouse -> transit leg contributes NOTHING and goods in transit are never
 * added to the figure (they are not yet the branch's value). Filtering on the
 * location's TYPE (not the literal word `transit`) means a renamed or retyped
 * staging location cannot double the total.
 *
 * This is a COST figure, not a selling price: it is what the network PAID for
 * the stock that reached a branch. It is computed in SQL, never summed in
 * JavaScript — a JS float sum of the rows' `valueEgp` strings (`0.1 + 0.2`)
 * yields `0.30000000000000004`, which an owner's accounts will not accept. An
 * empty window sums to `'0.00'` (coalesced), so the screen shows a real zero
 * rather than a blank.
 *
 * Call it with the scoped `db` from inside `withTenant`.
 */
export async function usageTotalEgp(
  db: Queryable,
  filter: { from: string | Date; to: string | Date },
): Promise<string> {
  const { rows } = await db.query<{ total: string }>(
    `select coalesce(sum(m.qty * i.cost_egp), 0)::numeric(12,2) as "total"
       from stock_movements m
       join locations l on l.id = m.to_location_id and l.tenant_id = m.tenant_id
       join item_variants v on v.id = m.variant_id and v.tenant_id = m.tenant_id
       join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
      where m.reason = 'issue_to_branch'
        and l.type = 'branch'
        and m.occurred_at >= $1
        and m.occurred_at < $2`,
    [filter.from, filter.to],
  );
  return rows[0]?.total ?? '0.00';
}

/** One movement of a variant, as the "where did it go" screen shows it. */
export interface MovementDetail {
  /** The monotonic insertion counter, as a STRING (bigint). */
  seq: string;
  /** One of `MOVEMENT_REASONS`; the screen translates it, never shows it raw. */
  reason: string;
  /** The magnitude, an exact `numeric(12,3)` STRING. */
  qty: string;
  /** The source location's Arabic name, or `null` (a one-sided receipt). */
  fromLocation: string | null;
  /** The destination location's Arabic name, or `null` (a one-sided write-off). */
  toLocation: string | null;
  /**
   * The name of the PERSON (or API client) who posted the movement, or `null`
   * for a system correction with no human actor — the screen says "system" rather
   * than showing a blank or a raw uuid.
   */
  actorName: string | null;
  /** When it was posted, ISO-8601 (the screen formats it). */
  occurredAt: string;
  notes: string | null;
}

/**
 * A variant's full movement history, NEWEST FIRST and bounded.
 *
 * Ordered by `seq desc` — the monotonic insertion counter — so two movements
 * posted in the same second come back in the order they were posted, never in a
 * uuid tie-break order. `occurred_at` is still carried on every row for display.
 *
 * "COMPLETE" means every row is WHOLE: the reason, both location NAMES, the ACTOR'S
 * NAME and the time are joined here, so a screen can answer "who took it, from
 * where, to where and when" without a second read — and a raw uuid is never what
 * it shows. A movement with no human actor carries `actorName: null`.
 *
 * Call it with the scoped `db` from inside `withTenant`.
 */
export async function movementHistoryDetailed(
  db: Queryable,
  variantId: string,
  limit: number = MOVEMENT_HISTORY_LIMIT,
): Promise<MovementDetail[]> {
  const { rows } = await db.query<{
    seq: string;
    reason: string;
    qty: string;
    fromLocation: string | null;
    toLocation: string | null;
    actorName: string | null;
    occurredAt: Date;
    notes: string | null;
  }>(
    `select m.seq::text as "seq",
            m.reason as "reason",
            m.qty as "qty",
            fl.name_ar as "fromLocation",
            tl.name_ar as "toLocation",
            coalesce(u.name, c.name) as "actorName",
            m.occurred_at as "occurredAt",
            m.notes as "notes"
       from stock_movements m
       left join locations fl on fl.id = m.from_location_id and fl.tenant_id = m.tenant_id
       left join locations tl on tl.id = m.to_location_id and tl.tenant_id = m.tenant_id
       left join app_users u on u.id = m.actor_user_id and u.tenant_id = m.tenant_id
       left join api_clients c on c.id = m.actor_api_client_id and c.tenant_id = m.tenant_id
      where m.variant_id = $1
      order by m.seq desc
      limit $2`,
    [variantId, limit],
  );
  return rows.map((row) => ({
    seq: row.seq,
    reason: row.reason,
    qty: row.qty,
    fromLocation: row.fromLocation,
    toLocation: row.toLocation,
    actorName: row.actorName,
    occurredAt: new Date(row.occurredAt).toISOString(),
    notes: row.notes,
  }));
}
