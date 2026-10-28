import type { MovementReason } from '../domain/movement.ts';
import { allowedTransitions, type RequisitionStatus } from '../domain/requisition.ts';
import type { Queryable } from './client.ts';
import { quarantineLocation, scrapLocation, warehouseLocation } from './locations.ts';
import { postMovement } from './movements.ts';
import type { Requisition } from './types.ts';

// Re-export the GENERATED row type rather than hand-declaring a copy; the
// migration is the source of truth and `src/db/types.ts` is regenerated from it.
export type { Requisition };
/** The status union the domain module owns, re-exported for callers. */
export type { RequisitionStatus };

/**
 * Where a returned item GOES. The disposition decides the destination location
 * and the ledger `reason`, and nothing else:
 *
 *   * `restock`    — back into SELLABLE stock: the tenant's WAREHOUSE, reason
 *                    `return_from_branch`.
 *   * `quarantine` — held back, NOT yet sellable: the tenant's QUARANTINE
 *                    location, reason `return_from_branch`.
 *   * `write_off`  — damaged and gone: the tenant's SCRAP location, reason
 *                    `write_off`.
 *
 * The mapping lives in {@link resolveDisposition} and is exhaustive: a value
 * outside these three is refused before anything is written.
 */
export type ReturnDisposition = 'restock' | 'quarantine' | 'write_off';

/** The input {@link postReturn} accepts; `db` supplies the tenant. */
export interface ReturnInput {
  /** The variant coming back. */
  variantId: string;
  /** The positive magnitude coming back. */
  qty: number;
  /**
   * Where it comes FROM — normally a branch, but could be a holder or a
   * customer-return staging location. The source's on-hand is checked: a return
   * bigger than the source actually holds is refused, so a source never goes
   * negative for stock it never had.
   */
  fromLocationId: string;
  disposition: ReturnDisposition;
  /** Human-typed origin of the return (a customer return, a document type). */
  refType?: string;
  refId?: string;
  notes?: string;
  /**
   * A stable key that makes a retried return land once. Machine-issued, so
   * stored verbatim. When omitted, a DETERMINISTIC key is derived from the
   * disposition, variant, source and reference — never a timestamp — so a
   * retried call still posts exactly one movement. A genuine SECOND return of
   * the same variant from the same place must supply a DISTINCT key.
   */
  idempotencyKey?: string;
  /**
   * Who recorded the return. Optional, but written to the ledger's actor when
   * supplied. Omit it and the movement simply has no actor.
   */
  actorUserId?: string;
}

/** One line of a requisition being sent back, handed to {@link returnRequisition}. */
export interface ReturnLine {
  variantId: string;
  /** The positive quantity in base units going back to the warehouse. */
  qty: number;
}

/** The one place `app.tenant_id` is read for a write, so it is written once. */
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/**
 * Throws unless `qty` is a finite number greater than zero.
 *
 * `numeric(12, 3)` ROUNDS a bad quantity on store rather than rejecting it
 * (1.2345 -> 1.235), so validation is the gate — the same discipline
 * `postMovement` applies to the ledger is applied HERE, before anything is
 * written, so a quantity can never change silently.
 */
function requirePositiveQty(value: unknown, field: string, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${context}: ${field} ${JSON.stringify(value)} must be a finite number > 0`,
    );
  }
  return value;
}

/**
 * Posts a return as ONE ledger movement — the REVERSE direction, recorded the
 * same way as everything else.
 *
 * The disposition decides where the stock goes and why (see
 * {@link ReturnDisposition}): `restock` credits the tenant's warehouse,
 * `quarantine` credits the tenant's quarantine location, and `write_off` credits
 * the tenant's scrap location with reason `write_off`. Each branch posts through
 * {@link postMovement} as a SINGLE two-sided row — `from_location_id` is the
 * caller's source, `to_location_id` the resolved destination — so the source's
 * loss and the destination's gain come from the SAME row and cannot drift apart.
 * The ledger is written ONLY through `postMovement` (the one gate that derives
 * discreteness from the item and validates quantity, reason and locations),
 * never a raw insert.
 *
 * AVAILABILITY IS GUARDED. `on_hand` (an ABSENT row meaning zero) is read for
 * the (variant, source) pair inside this same transaction, and a return larger
 * than the source actually holds is REFUSED with a message naming the location
 * and the available quantity — a source never goes negative for stock it never
 * had. This is the check that stops a branch "returning" goods it never
 * received.
 *
 * IDEMPOTENT. When `idempotencyKey` is supplied it is used; otherwise a
 * DETERMINISTIC key is derived from the disposition, variant, source and
 * reference (`return:<disposition>:<variantId>:<fromLocationId>:<refType>:<refId>`).
 * A timestamp is never used, so a retried call posts EXACTLY one movement. A
 * genuine SECOND return of the same variant from the same place is still
 * possible: the caller supplies a DISTINCT key.
 *
 * ATOMICITY: this writes exactly one ledger row and no header, so it is atomic
 * by itself — but it is meant to run inside the caller's tenant-scoped
 * transaction all the same (it reads `on_hand` and posts through the same `db`),
 * matching createReceipt / createItem / issue / returnRequisition. Call it with
 * the scoped `db` from inside `withTenant`; never nest `withTenant`.
 *
 * The tenant is NOT a parameter: it is read from `app.tenant_id`, which
 * `withTenant` pinned, so a caller cannot post a return for a tenant it is not
 * scoped to.
 */
export async function postReturn(
  db: Queryable,
  input: ReturnInput,
): Promise<{ id: string; reason: MovementReason }> {
  const qty = requirePositiveQty(input.qty, 'qty', `postReturn (variant ${input.variantId})`);

  // The disposition decides destination + reason, and it is exhaustive: an
  // unknown value is refused BEFORE any destination is resolved, so a typo
  // cannot quietly restock damaged goods.
  const { toLocationId, reason } = await resolveDisposition(db, input.disposition);

  // Never let the source go negative for stock it never had. `on_hand` has NO
  // row for a (variant, location) that never appears in the ledger, so absence
  // is zero — read through the coalescing helper, not a bare join.
  const available = await onHandQty(db, input.variantId, input.fromLocationId);
  if (qty > available) {
    const code = await locationCode(db, input.fromLocationId);
    throw new Error(
      `postReturn: cannot return ${qty} of variant ${input.variantId} from location ${code} (${input.fromLocationId}) — only ${available.toFixed(3)} is on hand there, and a source cannot go negative for stock it never had`,
    );
  }

  // Human-typed ref, canonicalised for the derived key AND for storage (the
  // database carries the matching CHECK and would refuse a raw un-normalised
  // value anyway).
  const refType =
    input.refType == null || input.refType.trim() === '' ? null : input.refType.trim().toUpperCase();
  const refId = input.refId == null || input.refId.trim() === '' ? null : input.refId;

  const key =
    input.idempotencyKey ??
    derivedReturnKey(input.disposition, input.variantId, input.fromLocationId, refType, refId);

  const { id } = await postMovement(db, {
    variantId: input.variantId,
    qty,
    reason,
    fromLocationId: input.fromLocationId,
    toLocationId,
    actorUserId: input.actorUserId ?? null,
    refType,
    refId,
    idempotencyKey: key,
    notes: input.notes ?? null,
  });

  return { id, reason };
}

/**
 * Sends stock BACK to the warehouse against a RECEIVED requisition, moving the
 * requisition `received -> returned`.
 *
 * A branch that has been issued stock and confirmed receipt can send it back.
 * For each line this posts ONE ledger movement `branch -> warehouse` through
 * {@link postMovement} with reason `return_from_branch` — the exact reverse of
 * the issue and confirm legs, recorded as an ordinary movement so the round trip
 * is visible end to end. The branch is the requisition's OWN `branch_location_id`
 * (never a caller-supplied id), and the warehouse is the tenant's singleton
 * warehouse, so the return can only undo what the flow actually delivered.
 *
 * ONLY A `received` REQUISITION CAN BE RETURNED. `allowedTransitions` permits
 * `received -> returned` and nothing else INTO `returned`, and the status
 * trigger in 0007 refuses any other move — so a refusal names the requisition's
 * current state. `returned` is TERMINAL: goods that went back stay back.
 *
 * AVAILABILITY IS GUARDED, exactly as in {@link postReturn}: each line's
 * quantity is checked against the branch's on-hand inside this same transaction,
 * so a branch cannot "return" more than it actually holds — naming the location
 * and the available quantity.
 *
 * `actorUserId` is REQUIRED — a user id — so the ledger records WHO sent the
 * goods back; it is written to every movement's actor.
 *
 * IDEMPOTENT PER LINE: each line posts under the stable key
 * `requisition:<id>:return:<variantId>`, so a retried line lands on the SAME
 * movement rather than doubling the return.
 *
 * ATOMICITY: this writes the ledger movements AND the header's status, so it is
 * NOT atomic on its own — it REQUIRES the caller's tenant-scoped transaction
 * (`withTenant`). A line that fails (an over-quantity return, an unknown
 * variant) rolls the whole return back, leaving the requisition `received` and
 * every movement unposted. Call it with the scoped `db` from inside
 * `withTenant`; never nest `withTenant`.
 */
export async function returnRequisition(
  db: Queryable,
  requisitionId: string,
  actorUserId: string,
  lines: ReturnLine[],
): Promise<{ status: RequisitionStatus }> {
  if (typeof actorUserId !== 'string' || actorUserId.trim() === '') {
    throw new Error(
      `returnRequisition: actorUserId must be a non-empty user id (got ${JSON.stringify(actorUserId)})`,
    );
  }

  // Lock the header for the life of the transaction, so two concurrent returns
  // serialise on it and the second sees the first's `returned`. Same
  // lock-then-check shape as issue / confirmReceipt / reject / close.
  const { rows: headerRows } = await db.query<Requisition>(
    `select * from requisitions where id = $1 for update`,
    [requisitionId],
  );
  const requisition = headerRows[0];
  if (!requisition) {
    throw new Error(`returnRequisition: requisition ${requisitionId} was not found for this tenant`);
  }
  if (!allowedTransitions(requisition.status as RequisitionStatus).includes('returned')) {
    throw new Error(
      `returnRequisition: requisition ${requisitionId} cannot be returned — its status is '${requisition.status}' (only a 'received' requisition can be returned)`,
    );
  }

  const warehouse = await warehouseLocation(db);
  const branchId = requisition.branch_location_id;

  for (const line of lines) {
    const qty = requirePositiveQty(line.qty, 'qty', `returnRequisition (variant ${line.variantId})`);

    // The variant must actually be a line on THIS requisition — you cannot send
    // back goods the document never covered.
    const { rows: lineRows } = await db.query<{ variant_id: string }>(
      `select variant_id from requisition_lines
        where tenant_id = ${TENANT} and requisition_id = $1 and variant_id = $2`,
      [requisitionId, line.variantId],
    );
    if (!lineRows[0]) {
      throw new Error(
        `returnRequisition: variant ${line.variantId} is not a line on requisition ${requisitionId}`,
      );
    }

    // The branch can only send back what it actually holds.
    const available = await onHandQty(db, line.variantId, branchId);
    if (qty > available) {
      const code = await locationCode(db, branchId);
      throw new Error(
        `returnRequisition: cannot return ${qty} of variant ${line.variantId} from location ${code} (${branchId}) — only ${available.toFixed(3)} is on hand there, and the branch cannot return stock it never held`,
      );
    }

    await postMovement(db, {
      variantId: line.variantId,
      qty,
      reason: 'return_from_branch',
      fromLocationId: branchId,
      toLocationId: warehouse.id,
      actorUserId,
      refType: 'REQUISITION',
      refId: requisitionId,
      idempotencyKey: returnRequisitionKey(requisitionId, line.variantId),
    });
  }

  // Advance the header LAST, so a failure above rolls the whole return back and
  // leaves the requisition `received`. `received -> returned` is the only legal
  // move into `returned`, enforced again by the status trigger.
  await db.query(
    `update requisitions set status = 'returned'
      where id = $1 and tenant_id = ${TENANT}`,
    [requisitionId],
  );

  return { status: 'returned' };
}

/**
 * The disposition mapping, written once and exhaustively: which destination a
 * returned item goes to, and which `reason` the movement carries. An unknown
 * disposition is refused here, before any location is resolved.
 */
async function resolveDisposition(
  db: Queryable,
  disposition: ReturnDisposition,
): Promise<{ toLocationId: string; reason: MovementReason }> {
  switch (disposition) {
    case 'restock': {
      const warehouse = await warehouseLocation(db);
      return { toLocationId: warehouse.id, reason: 'return_from_branch' };
    }
    case 'quarantine': {
      const quarantine = await quarantineLocation(db);
      return { toLocationId: quarantine.id, reason: 'return_from_branch' };
    }
    case 'write_off': {
      const scrap = await scrapLocation(db);
      return { toLocationId: scrap.id, reason: 'write_off' };
    }
    default: {
      throw new Error(
        `postReturn: disposition ${JSON.stringify(disposition)} is not one of: restock, quarantine, write_off`,
      );
    }
  }
}

/**
 * The on-hand quantity of a (variant, location), read from the `on_hand` view.
 *
 * `on_hand` has NO row for a pair that never appears in the ledger, so absence
 * means ZERO — a miss is coalesced to 0 rather than treated as unknown. `qty` is
 * a `numeric` the driver returns as a STRING, so it is parsed here.
 */
async function onHandQty(db: Queryable, variantId: string, locationId: string): Promise<number> {
  const { rows } = await db.query<{ qty: string }>(
    `select qty from on_hand where variant_id = $1 and location_id = $2`,
    [variantId, locationId],
  );
  const row = rows[0];
  return row ? Number(row.qty) : 0;
}

/** The human-readable code of a location, for error messages that name it. */
async function locationCode(db: Queryable, locationId: string): Promise<string> {
  const { rows } = await db.query<{ code: string }>(
    `select code from locations where id = $1 and tenant_id = ${TENANT}`,
    [locationId],
  );
  return rows[0]?.code ?? locationId;
}

/**
 * The DETERMINISTIC idempotency key a return falls back to when the caller
 * supplies none. Built from the disposition, variant, source and reference — NOT
 * a timestamp — so a retried call derives byte-identical key material and lands
 * on the same movement. A genuine second return supplies its own distinct key.
 */
function derivedReturnKey(
  disposition: ReturnDisposition,
  variantId: string,
  fromLocationId: string,
  refType: string | null,
  refId: string | null,
): string {
  return `return:${disposition}:${variantId}:${fromLocationId}:${refType ?? ''}:${refId ?? ''}`;
}

/** The stable per-line idempotency key a requisition return posts under. */
function returnRequisitionKey(requisitionId: string, variantId: string): string {
  return `requisition:${requisitionId}:return:${variantId}`;
}
