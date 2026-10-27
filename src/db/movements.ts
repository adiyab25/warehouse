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
  /** Whether the item is discrete; drives the whole-number rule. Default true. */
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
  const check = validateMovement({
    reason: input.reason,
    qty: input.qty,
    discrete: input.discrete,
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
 * The derived on-hand quantity per (variant, location), straight from the
 * `on_hand` view — the signed sum of the ledger. Optional `variantId` /
 * `locationId` narrow it.
 *
 * The view is `security_invoker`, so it is filtered by the caller's RLS exactly
 * like a direct read: a call scoped to one tenant never sees another's stock.
 * `qty` is a `numeric`, which node-postgres returns as a string.
 *
 * Call it with the scoped `db` from inside `withTenant`.
 */
export async function onHand(
  db: Queryable,
  filter: { variantId?: string; locationId?: string } = {},
): Promise<Array<{ variantId: string; locationId: string; qty: string }>> {
  const { rows } = await db.query<{ variant_id: string; location_id: string; qty: string }>(
    `select variant_id, location_id, qty
       from on_hand
      where ($1::uuid is null or variant_id = $1)
        and ($2::uuid is null or location_id = $2)
      order by variant_id, location_id`,
    [filter.variantId ?? null, filter.locationId ?? null],
  );
  return rows.map((r) => ({ variantId: r.variant_id, locationId: r.location_id, qty: r.qty }));
}

/**
 * The full story of one variant's ledger, newest first — every movement its
 * stock is derived from, so an on-hand figure can always be traced back to the
 * rows that produced it.
 *
 * Call it with the scoped `db` from inside `withTenant`.
 */
export async function movementHistory(db: Queryable, variantId: string): Promise<MovementRow[]> {
  const { rows } = await db.query<MovementRow>(
    `select *
       from stock_movements
      where variant_id = $1
      order by occurred_at desc, id desc`,
    [variantId],
  );
  return rows;
}
