import { validateMovement } from '../domain/movement.ts';
import type { Queryable } from './client.ts';
import type { StockMovement } from './types.ts';

// Re-export the GENERATED row types rather than hand-declaring copies. The
// migration is the source of truth, `src/db/types.ts` is generated from it, and
// a hand copy here would drift. Import + re-export makes drift impossible.
export type { StockMovement };

/** A ledger row, as returned newest-first by {@link movementHistory}. */
export type MovementRow = StockMovement;

/** The one place `app.tenant_id` is read for a write, so it is written once. */
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/** The input {@link postMovement} accepts; `db` supplies the tenant. */
export interface PostMovementInput {
  variantId: string;
  /** Positive magnitude; direction is carried by from/to below. */
  qty: number;
  /** One of `MOVEMENT_REASONS`; validated before the insert. */
  reason: string;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  actorUserId?: string | null;
  actorApiClientId?: string | null;
  /** Defaults to `now()` in the database when omitted. */
  occurredAt?: Date | string | null;
  /** Human-typed origin of the movement (a PO, a count sheet); canonicalised. */
  refType?: string | null;
  refId?: string | null;
  /**
   * A client-supplied key that makes a retried post land once. Machine-issued
   * (never human-typed), so it is stored verbatim — not upper-cased.
   */
  idempotencyKey?: string | null;
  notes?: string | null;
  /**
   * NOT authoritative. Discreteness is read from the item itself
   * (`items.discrete`) inside the same transaction; this field, when supplied,
   * is only an ASSERTION — it throws if it disagrees with the item, so a
   * caller that thinks a measured item is discrete (or vice versa) is told
   * loudly instead of silently posting a fractional quantity for half a
   * jacket. Omit it; the item wins.
   */
  discrete?: boolean;
}

/**
 * Appends one movement to the ledger for the tenant the connection is scoped
 * to, and returns its id.
 *
 * Validated first ({@link validateMovement}), so a bad reason, a non-positive
 * quantity or a from-equals-to pair is refused with a named field before any
 * SQL is sent. The tenant is NOT a parameter — it is read from `app.tenant_id`,
 * which {@link withTenant} pinned — so a caller cannot post for a tenant it is
 * not scoped to.
 *
 * DISCRETENESS comes from the ITEM: the variant's item is read inside this same
 * transaction and its `items.discrete` drives the whole-number rule. A
 * caller-supplied `input.discrete` is NOT authoritative — it is only checked
 * and throws when it contradicts the item — so a caller cannot post 0.5 of a
 * half-jacket by claiming `discrete: false`.
 *
 * ROUNDING: `qty` lands in a `numeric(12, 3)` column, and Postgres ROUNDS on
 * store rather than rejecting (1.2345 -> 1.235). Validation is the gate: this
 * function only ever sends a quantity {@link validateMovement} accepted, and it
 * must be the ONLY writer — a raw insert that bypasses it is silently rounded.
 *
 * IDEMPOTENT when `idempotencyKey` is supplied: the insert is
 * `on conflict (tenant_id, idempotency_key) do nothing returning id`, and when
 * no row comes back the existing row is re-selected by key and returned with
 * `deduped: true`. A re-sent movement therefore lands once. With NO key the
 * insert has nothing to conflict on, so it always appends (two identical rows
 * are two real movements — e.g. two separate receipts of the same size).
 *
 * Call it with the scoped `db` from inside `withTenant`; never nest `withTenant`.
 */
export async function postMovement(
  db: Queryable,
  input: PostMovementInput,
): Promise<{ id: string; deduped: boolean }> {
  // Discreteness is a property of the ITEM, so read it from the item — inside
  // the caller's transaction, through the same composite tenant-scoped join the
  // schema uses everywhere. A variant the caller cannot see (or that does not
  // exist) has no row here and is refused.
  const { rows: itemRows } = await db.query<{ discrete: boolean }>(
    `select i.discrete
       from item_variants v
       join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
      where v.id = $1
        and v.tenant_id = ${TENANT}`,
    [input.variantId],
  );
  const item = itemRows[0];
  if (!item) {
    throw new Error(`postMovement: variant ${input.variantId} was not found for this tenant`);
  }

  // `input.discrete`, if supplied, is only an assertion: the item is the source
  // of truth, and a caller that disagrees is told rather than silently obeyed.
  if (input.discrete !== undefined && input.discrete !== item.discrete) {
    throw new Error(
      `postMovement: discrete — caller asserted discrete=${input.discrete} but the item is discrete=${item.discrete}; the item wins`,
    );
  }

  const check = validateMovement({
    reason: input.reason,
    qty: input.qty,
    discrete: item.discrete,
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
  });
  if (!check.ok) {
    throw new Error(`postMovement: ${check.field} — ${check.message}`);
  }

  // `ref_type` is human-typed, so canonicalise it here; the database carries the
  // matching CHECK and would refuse an un-normalised value anyway.
  const refType =
    input.refType == null || input.refType.trim() === ''
      ? null
      : input.refType.trim().toUpperCase();

  const { rows } = await db.query<{ id: string }>(
    `insert into stock_movements
       (tenant_id, variant_id, qty, from_location_id, to_location_id, reason,
        actor_user_id, actor_api_client_id, occurred_at, ref_type, ref_id,
        idempotency_key, notes)
     values
       (${TENANT}, $1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9, $10, $11, $12)
     on conflict (tenant_id, idempotency_key) where idempotency_key is not null
     do nothing
     returning id`,
    [
      input.variantId,
      input.qty,
      input.fromLocationId ?? null,
      input.toLocationId ?? null,
      input.reason,
      input.actorUserId ?? null,
      input.actorApiClientId ?? null,
      input.occurredAt ?? null,
      refType,
      input.refId ?? null,
      input.idempotencyKey ?? null,
      input.notes ?? null,
    ],
  );

  const inserted = rows[0];
  if (inserted) return { id: inserted.id, deduped: false };

  // No row: the insert was swallowed by the idempotency conflict. The key is
  // non-null (a null key cannot conflict), so re-select the row that won the
  // race and report it as the same movement.
  const { rows: existing } = await db.query<{ id: string }>(
    `select id from stock_movements
      where tenant_id = ${TENANT}
        and idempotency_key = $1`,
    [input.idempotencyKey ?? null],
  );
  const found = existing[0];
  if (!found) {
    throw new Error(
      `postMovement: insert returned no row and no existing row was found for idempotency_key ${JSON.stringify(
        input.idempotencyKey,
      )}`,
    );
  }
  return { id: found.id, deduped: true };
}

/**
 * Serialises every writer that guards the availability of ONE (variant,
 * location) pair, so a read of `on_hand` and the movement that changes it
 * cannot interleave.
 *
 * A plain `select … from on_hand` takes NO lock (a view cannot), and reading the
 * balance and then posting against it is a lost-update race: two returns of the
 * same stock each read the same balance, each decide it fits, and both post —
 * driving the location negative. The fix is a transaction-scoped advisory lock
 * on a key derived from the pair, taken BEFORE the availability read. It must be
 * the SAME key at every call site so writers on the same pair actually block
 * each other.
 *
 * The key is `hashtextextended(variantId || ':' || locationId, 0)` — the
 * transaction-scoped form, so the lock is released automatically at COMMIT or
 * ROLLBACK and a crashed connection cannot wedge a pair. The UUID ids make a
 * cross-tenant collision impossible in practice: two tenants never share a
 * variant or location id. Deliberately NOT `SELECT … FOR UPDATE` on `on_hand`
 * (proven to acquire no row lock, so it serialises nothing) and NOT an app-side
 * mutex (which a second process ignores).
 *
 * Call it with the scoped `db` from inside `withTenant`, before reading the
 * pair's availability.
 */
export async function lockStockPair(
  db: Queryable,
  variantId: string,
  locationId: string,
): Promise<void> {
  await db.query(
    `select pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
    [variantId, locationId],
  );
}

/**
 * The derived on-hand quantity per (variant, location), straight from the
 * `on_hand` view — the signed sum of the ledger. Optional `variantId` /
 * `locationId` narrow it.
 *
 * The view is `security_invoker`, so it is filtered by the caller's RLS exactly
 * like a direct read: a call scoped to one tenant never sees another's stock.
 * `qty` is a `numeric`, which node-postgres returns as a STRING — so this
 * returns BOTH forms: the raw `qty` string (exact, for re-serialising) and a
 * parsed `qtyNum: number` for arithmetic. Never do `+row.qty` or `qty * 2` on
 * the string; use `qtyNum`.
 *
 * NO ZERO ROWS: a (variant, location) that never appears in the ledger has NO
 * row here at all — absence means zero, not that stock is unknown. A consumer
 * asking "how much of this item is at this location?" must LEFT JOIN to
 * `on_hand` (or this list) and coalesce a miss to 0.
 *
 * Call it with the scoped `db` from inside `withTenant`.
 */
export async function onHand(
  db: Queryable,
  filter: { variantId?: string; locationId?: string } = {},
): Promise<Array<{ variantId: string; locationId: string; qty: string; qtyNum: number }>> {
  const { rows } = await db.query<{ variant_id: string; location_id: string; qty: string }>(
    `select variant_id, location_id, qty
       from on_hand
      where ($1::uuid is null or variant_id = $1)
        and ($2::uuid is null or location_id = $2)
      order by variant_id, location_id`,
    [filter.variantId ?? null, filter.locationId ?? null],
  );
  return rows.map((r) => ({
    variantId: r.variant_id,
    locationId: r.location_id,
    qty: r.qty,
    qtyNum: Number(r.qty),
  }));
}

/**
 * The full story of one variant's ledger, newest first — every movement its
 * stock is derived from, so an on-hand figure can always be traced back to the
 * rows that produced it.
 *
 * Ordered by `seq desc` — the monotonic insertion counter — NOT by
 * `occurred_at desc, id desc`. `occurred_at` is a business timestamp a caller
 * supplies and can repeat, and `id` is a random uuid, so ordering by those
 * broke ties arbitrarily. `seq` is assigned in commit order, so two
 * same-instant movements always come back in the order they were posted.
 * `occurred_at` is still on every row for display.
 *
 * Call it with the scoped `db` from inside `withTenant`.
 */
export async function movementHistory(db: Queryable, variantId: string): Promise<MovementRow[]> {
  const { rows } = await db.query<MovementRow>(
    `select *
       from stock_movements
      where variant_id = $1
      order by seq desc`,
    [variantId],
  );
  return rows;
}
