import type { MovementReason } from '../domain/movement.ts';
import { allowedTransitions, type RequisitionStatus } from '../domain/requisition.ts';
import type { Queryable } from './client.ts';
import { quarantineLocation, scrapLocation, warehouseLocation } from './locations.ts';
import { postMovement, lockStockPair } from './movements.ts';
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
   * A stable key that makes a retried return land once. Machine-issued and
   * REQUIRED: the caller supplies one per return INTENT — a screen generates it
   * when the form opens — so a retry of that intent collapses onto one movement,
   * while a genuinely DIFFERENT return of the same variant from the same place
   * carries a different key and still moves stock. There is deliberately NO
   * derived fallback: a key guessed from the disposition, variant and source
   * cannot tell two real returns apart, so it would silently swallow the second
   * (see the review finding this fixes). Stored verbatim.
   */
  idempotencyKey: string;
  /**
   * Who recorded the return — REQUIRED, a user id. A return IS a human act
   * (someone decides to restock, quarantine or write off), so the ledger must
   * name WHO did it. There is no optional/omit path: a caller that forgets the
   * actor must be a TYPE ERROR, and at run time an empty one is refused before
   * anything is written, so an anonymous return cannot be posted.
   */
  actorUserId: string;
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
 * AVAILABILITY IS GUARDED AND SERIALISED. `on_hand` (an ABSENT row meaning
 * zero) is read for the (variant, source) pair inside this same transaction, and
 * a return larger than the source actually holds is REFUSED with a message
 * naming the location and the available quantity — a source never goes negative
 * for stock it never had. This is the check that stops a branch "returning"
 * goods it never received. The read and the post are serialised by
 * {@link lockStockPair} on the (variant, source) pair, taken FIRST: without it
 * two concurrent returns each read the same balance, each decide it fits, and
 * both post, driving the source NEGATIVE.
 *
 * `actorUserId` is REQUIRED — a user id — because a return is a HUMAN act
 * (someone decides to restock, quarantine or write off). It is written to the
 * movement's `actor_user_id` through `postMovement`, mirroring the sibling
 * writers (issue, confirmReceipt, postReceipt, returnRequisition, closeCount),
 * and an empty or omitted actor is refused before any SQL runs. An optional
 * actor would be the same defect one step later: a forgetful caller would post
 * an anonymous movement and "who took what" would fail again for returns.
 *
 * IDEMPOTENT BY AN EXPLICIT KEY. `idempotencyKey` is REQUIRED — the caller
 * supplies one per return intent (a screen generates it when the form opens), so
 * a retried call lands on ONE movement while a genuine SECOND return of the same
 * variant from the same place, carrying a DIFFERENT key, still moves stock. No
 * key is derived here: a key guessed from the disposition, variant and source
 * would be identical for two real returns and silently swallow the second.
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

  // A key per return INTENT is mandatory — without one there is nothing to make
  // a retry idempotent, and a derived key would collapse two real returns.
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim() === '') {
    throw new Error(
      `postReturn: idempotencyKey must be a non-empty string (variant ${input.variantId}) — one key per return intent, generated by the caller`,
    );
  }

  // A return is a HUMAN act, so the actor is mandatory — refused here (before any
  // SQL) as well as at the type level, so a caller that slips past the compiler
  // (JS, a cast, an untyped edge) cannot post an anonymous movement.
  if (typeof input.actorUserId !== 'string' || input.actorUserId.trim() === '') {
    throw new Error(
      `postReturn: actorUserId must be a non-empty user id (got ${JSON.stringify(input.actorUserId)}) — a return is a human action and the ledger must record who did it (variant ${input.variantId})`,
    );
  }

  // Serialise with every other guarded writer on this (variant, source) pair
  // BEFORE reading availability: two concurrent returns must not both read the
  // same balance and both post, driving the source negative.
  await lockStockPair(db, input.variantId, input.fromLocationId);

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

  // Human-typed ref, canonicalised for storage (the database carries the
  // matching CHECK and would refuse a raw un-normalised value anyway).
  const refType =
    input.refType == null || input.refType.trim() === '' ? null : input.refType.trim().toUpperCase();
  const refId = input.refId == null || input.refId.trim() === '' ? null : input.refId;

  const { id } = await postMovement(db, {
    variantId: input.variantId,
    qty,
    reason,
    fromLocationId: input.fromLocationId,
    toLocationId,
    actorUserId: input.actorUserId,
    refType,
    refId,
    idempotencyKey: input.idempotencyKey,
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
 * current state. `returned` is TERMINAL: goods that went back stay back. A
 * RETRY of an already-committed return is not refused, though: if the
 * requisition is already `returned` and the movements for the requested lines
 * already exist, this returns `{ status: 'returned' }` as an idempotent success
 * (see below). Any OTHER non-returnable state still throws.
 *
 * BOUND BY WHAT THIS REQUISITION DELIVERED, AND SERIALISED. Each line's
 * quantity is bounded by `received_qty - already returned for this line`: a
 * branch holding stock from ANOTHER source can never use it to drive THIS
 * document to `returned`, so the document's claim stays true even though the
 * ledger would have stayed consistent. The per-line availability of the branch
 * is still checked too (exactly as in {@link postReturn}), and {@link
 * lockStockPair} serialises the read-and-post with every other guarded writer on
 * the (variant, branch) pair.
 *
 * `actorUserId` is REQUIRED — a user id — so the ledger records WHO sent the
 * goods back; it is written to every movement's actor.
 *
 * IDEMPOTENT PER LINE: each line posts under the stable key
 * `requisition:<id>:return:<variantId>`, so a retried line lands on the SAME
 * movement rather than doubling the return. Because `returned` is terminal and
 * the header is locked `for update` first, a retry is detected at the header (it
 * sees `returned`) and answered from the existing movements before any key is
 * consulted, so a client retrying a committed return gets a success, not an
 * ambiguous "cannot be returned" error.
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

  // A RETRY of a committed return is idempotent. `returned` is terminal, so the
  // ordinary guard below would throw an ambiguous "cannot be returned" at a
  // client that is simply re-sending a return that already landed. If the
  // requisition is ALREADY `returned` AND the movements for every requested line
  // already exist, this is that retry: report success. (A request that names a
  // line with no movement — a genuinely different act on a terminal document —
  // still falls through to the refusal.)
  if (requisition.status === 'returned') {
    if (await linesAlreadyReturned(db, requisitionId, lines)) {
      return { status: 'returned' };
    }
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

    // Serialise with every other guarded writer on this (variant, branch) pair
    // BEFORE reading availability or the delivered bound.
    await lockStockPair(db, line.variantId, branchId);

    // The variant must actually be a line on THIS requisition — you cannot send
    // back goods the document never covered. Its `received_qty` is what THIS
    // document actually delivered, and it is the ceiling for a return.
    const { rows: lineRows } = await db.query<{ variant_id: string; received_qty: string }>(
      `select variant_id, received_qty from requisition_lines
        where tenant_id = ${TENANT} and requisition_id = $1 and variant_id = $2`,
      [requisitionId, line.variantId],
    );
    if (!lineRows[0]) {
      throw new Error(
        `returnRequisition: variant ${line.variantId} is not a line on requisition ${requisitionId}`,
      );
    }

    // Bound by what THIS requisition delivered and has not already returned:
    // stock the branch holds from another source cannot be used to drive this
    // document to `returned`.
    const receivedQty = Number(lineRows[0].received_qty);
    const alreadyReturned = await returnedForLine(db, requisitionId, line.variantId, branchId);
    const returnable = round3(receivedQty - alreadyReturned);
    if (qty > returnable) {
      throw new Error(
        `returnRequisition: cannot return ${qty} of variant ${line.variantId} on requisition ${requisitionId} — this requisition delivered ${receivedQty.toFixed(3)} and ${alreadyReturned.toFixed(3)} has already been returned, so only ${returnable.toFixed(3)} can go back`,
      );
    }

    // ...and the branch can only send back what it actually holds.
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
 * Rounds a quantity to the 3 decimals `numeric(12, 3)` stores, so a cumulative
 * comparison (`received_qty - already returned`) does not drift on a decimal
 * chain and wrongly refuse or wrongly accept a return.
 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * How much of `variantId` THIS requisition has already returned from
 * `locationId` — the sum of its return movements. Used to bound a further
 * return by `received_qty - alreadyReturned`, so a document can never be driven
 * to `returned` for more than it actually delivered.
 */
async function returnedForLine(
  db: Queryable,
  requisitionId: string,
  variantId: string,
  locationId: string,
): Promise<number> {
  const { rows } = await db.query<{ qty: string }>(
    `select coalesce(sum(qty), 0) as qty
       from stock_movements
      where tenant_id = ${TENANT}
        and ref_type = 'REQUISITION'
        and ref_id = $1
        and variant_id = $2
        and from_location_id = $3
        and reason = 'return_from_branch'`,
    [requisitionId, variantId, locationId],
  );
  return Number(rows[0]?.qty ?? 0);
}

/**
 * Whether EVERY requested line of a requisition already has a return movement —
 * i.e. the return the caller is re-sending already landed. Reading the
 * movements is what makes a retry of a `returned` requisition idempotent
 * instead of an ambiguous refusal.
 */
async function linesAlreadyReturned(
  db: Queryable,
  requisitionId: string,
  lines: ReturnLine[],
): Promise<boolean> {
  for (const line of lines) {
    const { rows } = await db.query(
      `select 1
         from stock_movements
        where tenant_id = ${TENANT}
          and ref_type = 'REQUISITION'
          and ref_id = $1
          and variant_id = $2
          and reason = 'return_from_branch'
        limit 1`,
      [requisitionId, line.variantId],
    );
    if (!rows[0]) return false;
  }
  return true;
}

/** The stable per-line idempotency key a requisition return posts under. */
function returnRequisitionKey(requisitionId: string, variantId: string): string {
  return `requisition:${requisitionId}:return:${variantId}`;
}
