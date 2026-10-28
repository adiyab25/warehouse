import { allowedTransitions, canConfirm, type RequisitionStatus } from '../domain/requisition.ts';
import type { Queryable } from './client.ts';
import { transitLocation, warehouseLocation } from './locations.ts';
import { postMovement } from './movements.ts';
import type { Requisition, RequisitionLine } from './types.ts';

// Re-export the GENERATED row types rather than hand-declaring copies. The
// migration is the source of truth, `src/db/types.ts` is generated from it, and
// a hand copy here would drift. Import + re-export makes drift impossible.
export type { Requisition, RequisitionLine };

/** The status union the domain module owns, re-exported for callers. */
export type { RequisitionStatus };

/** A requisition line as stored, re-exported for callers that read one back. */
export type RequisitionRow = Requisition;
export type RequisitionLineRow = RequisitionLine;

/** The input {@link createRequisition} accepts; `db` supplies the tenant. */
export interface CreateRequisitionInput {
  /** The branch the stock is FOR. */
  branchLocationId: string;
  /** Who is asking — the user id of the branch user. REQUIRED, never omitted. */
  requestedBy: string;
  /** What the branch asks for, one line per variant. */
  lines: Array<{ variantId: string; requestedQty: number }>;
  /** Free-text note; not an identifier, so stored verbatim. */
  notes?: string;
}

/** One line the warehouse agrees to release, handed to {@link approve}. */
export interface ApproveLine {
  variantId: string;
  /** How much the warehouse agreed to release. Less than requested is allowed. */
  approvedQty: number;
}

/** One line being released, handed to {@link issue}. */
export interface IssueLine {
  variantId: string;
  /** The quantity in base units to move warehouse -> transit. */
  qty: number;
}

/** One line being acknowledged, handed to {@link confirmReceipt}. */
export interface ConfirmLine {
  variantId: string;
  /** The quantity in base units that actually arrived at the branch. */
  qty: number;
}

/** The one place `app.tenant_id` is read for a write, so it is written once. */
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/**
 * Throws unless `qty` is a finite number greater than zero.
 *
 * `numeric(12, 3)` ROUNDS a bad quantity on store rather than rejecting it
 * (1.2345 -> 1.235), so validation is the gate: the same discipline
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
 * Rounds a quantity to the 3 decimals `numeric(12, 3)` stores.
 *
 * Quantities are read back from Postgres as JS numbers, and cumulative legs are
 * summed in JS; without this a decimal chain (0.1 + 0.2) would drift to
 * 0.30000000000000004 and, worse, a per-leg idempotency key built from it would
 * never match on retry. Every cumulative quantity and derived remainder passes
 * through here, so a key is byte-identical between the first post and a retry.
 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Creates a requisition header AND its requested lines for the tenant the
 * connection is scoped to, and returns the header.
 *
 * The header and every line are written through the SAME `db`, so when this is
 * called inside the caller's tenant-scoped transaction (`withTenant`) they are
 * one unit of work: a line that fails — a duplicate variant breaking the
 * per-requisition unique index, or a variant belonging to another tenant
 * breaking the composite FK — rolls the whole requisition back, and NO orphan
 * header survives. This writes the header AND its lines (two or more rows) and
 * is therefore NOT atomic on its own: it does not open a transaction itself, it
 * REQUIRES the caller's tenant-scoped transaction. Call it with the scoped `db`
 * from inside `withTenant`, never nesting `withTenant`.
 *
 * `requestedBy` is REQUIRED — a user id — so a caller cannot forget to record
 * who asked; it is written to `requested_by` (and the header starts `requested`).
 * Each `requestedQty` is validated as a finite number > 0 before anything is
 * written, matching the database's `requested_qty > 0` CHECK.
 *
 * The tenant is NOT a parameter: it is read from `app.tenant_id`, which
 * `withTenant` pinned, so a caller cannot create a requisition for a tenant it
 * is not scoped to.
 */
export async function createRequisition(
  db: Queryable,
  input: CreateRequisitionInput,
): Promise<Requisition> {
  if (typeof input.requestedBy !== 'string' || input.requestedBy.trim() === '') {
    throw new Error(
      `createRequisition: requestedBy must be a non-empty user id (got ${JSON.stringify(input.requestedBy)})`,
    );
  }
  for (const line of input.lines) {
    requirePositiveQty(line.requestedQty, 'requestedQty', `createRequisition (variant ${line.variantId})`);
  }

  const { rows } = await db.query<Requisition>(
    `insert into requisitions (tenant_id, branch_location_id, requested_by, notes)
     values (${TENANT}, $1, $2, $3)
     returning *`,
    [input.branchLocationId, input.requestedBy, input.notes ?? null],
  );

  const requisition = rows[0];
  if (!requisition) throw new Error('createRequisition: no requisition row returned');

  for (const line of input.lines) {
    await db.query(
      `insert into requisition_lines (tenant_id, requisition_id, variant_id, requested_qty)
       values (${TENANT}, $1, $2, $3)`,
      [requisition.id, line.variantId, line.requestedQty],
    );
  }

  return requisition;
}

/**
 * Approves a requisition: records who approved it and when, optionally setting
 * an `approved_qty` per line (the warehouse may agree to release LESS than was
 * asked for), and advances the header to `approved`.
 *
 * Only a `requested` requisition can be approved — the state machine allows
 * `requested -> approved` and no other move INTO `approved`, and the status
 * trigger refuses anything else. A refusal names the requisition's current
 * state so a caller is told why.
 *
 * `approverUserId` is REQUIRED — a user id — so `approved_by` can never stay
 * NULL; it is written with `approved_at` on every call.
 *
 * A named line that is not on the requisition is refused, and because the
 * header update and the line updates share the caller's transaction, a refused
 * line rolls the whole approval back.
 *
 * Call it with the scoped `db` from inside `withTenant`; never nest `withTenant`.
 */
export async function approve(
  db: Queryable,
  id: string,
  approverUserId: string,
  lines?: ApproveLine[],
): Promise<Requisition> {
  if (typeof approverUserId !== 'string' || approverUserId.trim() === '') {
    throw new Error(
      `approve: approverUserId must be a non-empty user id (got ${JSON.stringify(approverUserId)})`,
    );
  }

  // Lock the header for the life of the transaction, so two concurrent
  // approvals serialise on it and the second sees the first's `approved`.
  const { rows: headerRows } = await db.query<Requisition>(
    `select * from requisitions where id = $1 for update`,
    [id],
  );
  const requisition = headerRows[0];
  if (!requisition) {
    throw new Error(`approve: requisition ${id} was not found for this tenant`);
  }
  if (!allowedTransitions(requisition.status as RequisitionStatus).includes('approved')) {
    throw new Error(
      `approve: requisition ${id} cannot be approved — its status is '${requisition.status}' (only a 'requested' requisition can be approved)`,
    );
  }

  if (lines) {
    for (const line of lines) {
      if (typeof line.approvedQty !== 'number' || !Number.isFinite(line.approvedQty) || line.approvedQty < 0) {
        throw new Error(
          `approve: approvedQty ${JSON.stringify(line.approvedQty)} for variant ${line.variantId} must be a finite number >= 0`,
        );
      }
      const { rows: touched } = await db.query<{ variant_id: string }>(
        `update requisition_lines set approved_qty = $3
          where tenant_id = ${TENANT} and requisition_id = $1 and variant_id = $2
          returning variant_id`,
        [id, line.variantId, line.approvedQty],
      );
      if (!touched[0]) {
        throw new Error(
          `approve: variant ${line.variantId} is not a line on requisition ${id}`,
        );
      }
    }
  }

  const { rows: updated } = await db.query<Requisition>(
    `update requisitions set status = 'approved', approved_by = $2, approved_at = now()
      where id = $1 and tenant_id = ${TENANT}
      returning *`,
    [id, approverUserId],
  );
  const approved = updated[0];
  if (!approved) throw new Error(`approve: requisition ${id} disappeared while being approved`);
  return approved;
}

/**
 * Issues stock against an approved requisition: for each line, writes ONE ledger
 * movement `warehouse -> transit` through {@link postMovement}, records what left
 * (`issued_qty`), and advances the header.
 *
 * It is a TRANSFER, not a from-nowhere arrival: `from_location_id` is the
 * tenant's warehouse and `to_location_id` is the transit location, so the same
 * row debits the warehouse and credits transit. Stock in transit is NOT yet the
 * branch's — that is the whole point — and the confirm leg is what later moves
 * it on. The ledger is written ONLY through `postMovement` (the one gate that
 * derives discreteness from the item and validates quantity, reason and
 * locations), never a raw insert.
 *
 * PARTIAL IS NATIVE, AND A LINE TAKES SEVERAL LEGS. `lines` may name a SUBSET of
 * the requisition's lines; a line NOT supplied is left untouched. A line that is
 * already partly issued may be TOPPED UP: each call issues up to its REMAINING
 * target (`approved_qty` when the warehouse set one, else `requested_qty`), until
 * `issued_qty` reaches it. A leg is refused only when it would EXCEED the
 * remaining target (you cannot release more than was agreed) or when the line is
 * already fulfilled (nothing left to issue) — so 6-of-10 followed by 4-of-10 is
 * legal and completes the line. After issuing, the header is `issued` only when
 * EVERY line is issued in full; otherwise it stays `partially_issued` and the
 * requisition remains open for the remaining lines.
 *
 * IDEMPOTENT PER LEG: each leg posts under a STABLE key derived from the
 * CUMULATIVE issued quantity it produces —
 * `requisition:<id>:issue:<variantId>:<issuedQtyAfter>`. A retry of the SAME leg
 * therefore lands on the SAME movement (a leg is a no-op the second time), while
 * a genuine SECOND leg — one that grows `issued_qty` to a new value — gets a new
 * key and moves stock. A timestamp would break this: a retry would carry a new
 * timestamp, miss the conflict and post twice.
 *
 * `qty` values are validated as finite numbers > 0 before anything is written
 * (numeric(12,3) would round a bad one silently, so the validator is the gate).
 *
 * Call it with the scoped `db` from inside `withTenant`; never nest `withTenant`.
 */
export async function issue(
  db: Queryable,
  id: string,
  lines: IssueLine[],
): Promise<{ status: RequisitionStatus }> {
  const requisition = await lockForFlow(db, id, 'issue');
  if (requisition.status !== 'approved' && requisition.status !== 'partially_issued') {
    throw new Error(
      `issue: requisition ${id} cannot be issued — its status is '${requisition.status}' (only an 'approved' or 'partially_issued' requisition can be issued)`,
    );
  }

  const transit = await transitLocation(db);
  const warehouse = await warehouseLocation(db);

  for (const line of lines) {
    const qty = requirePositiveQty(line.qty, 'qty', `issue (variant ${line.variantId})`);
    const stored = await readLine(db, id, line.variantId);
    const target = stored.approvedQty ?? stored.requestedQty;
    const remaining = round3(target - stored.issuedQty);

    if (remaining <= 0) {
      throw new Error(
        `issue: line for variant ${line.variantId} on requisition ${id} is already fulfilled (issued ${stored.issuedQty} of ${target}) — nothing left to issue`,
      );
    }
    if (qty > remaining) {
      throw new Error(
        `issue: line for variant ${line.variantId} on requisition ${id} — cannot issue ${qty}, only ${remaining} remains of ${target} ${stored.approvedQty == null ? 'requested' : 'approved'}`,
      );
    }

    // The key is built from the CUMULATIVE issued quantity this leg produces, so
    // it is deterministic and collision-free across legs (see the docstring).
    const issuedAfter = round3(stored.issuedQty + qty);

    await postMovement(db, {
      variantId: line.variantId,
      qty,
      reason: 'issue_to_branch',
      fromLocationId: warehouse.id,
      toLocationId: transit.id,
      refType: 'REQUISITION',
      refId: id,
      idempotencyKey: issueKey(id, line.variantId, issuedAfter),
    });

    const lineStatus = issuedAfter >= target ? 'fulfilled' : 'open';
    await db.query(
      `update requisition_lines set issued_qty = $3, status = $4
        where tenant_id = ${TENANT} and requisition_id = $1 and variant_id = $2`,
      [id, line.variantId, issuedAfter, lineStatus],
    );
  }

  // Advance the header. `issued` only once EVERY line is issued in full;
  // otherwise `partially_issued` and it may be issued again. Done last, so a
  // failure above rolls the whole issue back and leaves the previous status.
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from requisition_lines
      where tenant_id = ${TENANT}
        and requisition_id = $1
        and issued_qty < coalesce(approved_qty, requested_qty)`,
    [id],
  );
  const status: RequisitionStatus = rows[0]!.n === 0 ? 'issued' : 'partially_issued';

  await db.query(
    `update requisitions set status = $2, issued_at = coalesce(issued_at, now())
      where id = $1 and tenant_id = ${TENANT}`,
    [id, status],
  );

  return { status };
}

/**
 * Confirms receipt of an issued (or partly-issued) requisition: for each line,
 * writes ONE ledger movement `transit -> branch` through {@link postMovement},
 * records what arrived (`received_qty`), and advances the header.
 *
 * THIS IS WHERE STOCK BECOMES THE BRANCH'S. The issue leg credited transit; this
 * leg debits transit and credits the branch, from the SAME row, so the branch's
 * gain and transit's loss cannot drift apart. Stock in transit before this call
 * is NOT yet the branch's, and a line that arrives SHORT of what was issued is a
 * visible `short` line, not an invisible disappearance.
 *
 * A PARTLY-ISSUED REQUISITION CAN BE CONFIRMED TOO ({@link canConfirm}): stock
 * is on the road as soon as ANY line has been released, so the branch must be
 * able to acknowledge what has actually arrived while the rest is still coming.
 * Confirming is PER LINE and limited to what is still in transit —
 * `issued_qty - received_qty`; receiving MORE than that is refused, naming the
 * numbers, because you cannot receive stock that never left the warehouse.
 *
 * AFTER A CONFIRM THE HEADER IS `received` ONLY WHEN NOTHING IS OUTSTANDING:
 * every line is fulfilled (`issued_qty` has reached its target) AND every line's
 * issued stock has fully arrived (`received_qty = issued_qty`). Otherwise it is
 * `partially_issued` — more is still to come (a line still to be released, or
 * released stock still on the road).
 *
 * A line received in full is `fulfilled`; one whose arrivals have fallen behind
 * what was issued is `short`; one whose released stock has all arrived but whose
 * target is not yet met is `open` (the warehouse has not finished).
 *
 * IDEMPOTENT PER LEG: each leg posts under a STABLE key derived from the
 * CUMULATIVE received quantity it produces —
 * `requisition:<id>:recv:<variantId>:<receivedQtyAfter>`. A retry of the same leg
 * lands on the SAME movement (even one that raced past the state guard), while a
 * genuine second leg gets a new key. A timestamp would defeat this.
 *
 * `qty` values are validated as finite numbers > 0 before anything is written.
 *
 * Call it with the scoped `db` from inside `withTenant`; never nest `withTenant`.
 */
export async function confirmReceipt(
  db: Queryable,
  id: string,
  lines: ConfirmLine[],
): Promise<{ status: RequisitionStatus }> {
  const requisition = await lockForFlow(db, id, 'confirmReceipt');
  if (!canConfirm(requisition.status as RequisitionStatus)) {
    throw new Error(
      `confirmReceipt: requisition ${id} cannot be confirmed — its status is '${requisition.status}' (only an 'issued' or 'partially_issued' requisition has stock in transit to confirm)`,
    );
  }

  const transit = await transitLocation(db);

  for (const line of lines) {
    const qty = requirePositiveQty(line.qty, 'qty', `confirmReceipt (variant ${line.variantId})`);
    const stored = await readLine(db, id, line.variantId);
    const inTransit = round3(stored.issuedQty - stored.receivedQty);

    if (inTransit <= 0) {
      throw new Error(
        `confirmReceipt: line for variant ${line.variantId} on requisition ${id} has nothing left in transit — it was issued ${stored.issuedQty} and ${stored.receivedQty} has already been received, so ${qty} cannot be confirmed`,
      );
    }
    if (qty > inTransit) {
      throw new Error(
        `confirmReceipt: line for variant ${line.variantId} on requisition ${id} — cannot receive ${qty}; only ${inTransit} is still in transit (issued ${stored.issuedQty}, already received ${stored.receivedQty}), so you cannot receive stock that never left the warehouse`,
      );
    }

    // The key is built from the CUMULATIVE received quantity this leg produces,
    // so it is deterministic and collision-free across legs.
    const receivedAfter = round3(stored.receivedQty + qty);

    await postMovement(db, {
      variantId: line.variantId,
      qty,
      reason: 'issue_to_branch',
      fromLocationId: transit.id,
      toLocationId: requisition.branch_location_id,
      refType: 'REQUISITION',
      refId: id,
      idempotencyKey: receiveKey(id, line.variantId, receivedAfter),
    });

    const target = stored.approvedQty ?? stored.requestedQty;
    const lineStatus =
      receivedAfter >= target ? 'fulfilled' : receivedAfter >= stored.issuedQty ? 'open' : 'short';
    await db.query(
      `update requisition_lines set received_qty = $3, status = $4
        where tenant_id = ${TENANT} and requisition_id = $1 and variant_id = $2`,
      [id, line.variantId, receivedAfter, lineStatus],
    );
  }

  // The header is `received` only when NOTHING is outstanding: every line is
  // fulfilled AND every line's issued stock has fully arrived. Otherwise more is
  // still to come, so it is `partially_issued`.
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from requisition_lines
      where tenant_id = ${TENANT}
        and requisition_id = $1
        and (issued_qty < coalesce(approved_qty, requested_qty) or received_qty < issued_qty)`,
    [id],
  );
  const status: RequisitionStatus = rows[0]!.n === 0 ? 'received' : 'partially_issued';

  await db.query(
    `update requisitions
        set status = $2,
            received_at = case when $2 = 'received' then coalesce(received_at, now()) else received_at end
      where id = $1 and tenant_id = ${TENANT}`,
    [id, status],
  );

  return { status };
}

/**
 * Rejects a requisition: records who refused it, when, and why, and moves the
 * header `requested -> rejected`.
 *
 * Only a `requested` requisition can be rejected — the state machine allows
 * `requested -> rejected` and no other move INTO `rejected`, and the status
 * trigger refuses anything else. An already-`approved` requisition was ACCEPTED;
 * refusing it now would be a different act (a returned/correcting document, not
 * a rejection), so this refuses and names the current state. `rejected` is
 * TERMINAL: once rejected, the requisition never moves again.
 *
 * `actorUserId` is REQUIRED — a user id — so `rejected_by` can never stay NULL;
 * it is written with `rejected_at` (and `rejected_reason`, when a `reason` is
 * given) on the call.
 *
 * Call it with the scoped `db` from inside `withTenant`; never nest `withTenant`.
 */
export async function reject(
  db: Queryable,
  id: string,
  actorUserId: string,
  reason?: string,
): Promise<Requisition> {
  if (typeof actorUserId !== 'string' || actorUserId.trim() === '') {
    throw new Error(
      `reject: actorUserId must be a non-empty user id (got ${JSON.stringify(actorUserId)})`,
    );
  }

  const requisition = await lockForFlow(db, id, 'reject');
  if (!allowedTransitions(requisition.status as RequisitionStatus).includes('rejected')) {
    throw new Error(
      `reject: requisition ${id} cannot be rejected — its status is '${requisition.status}' (only a 'requested' requisition can be rejected)`,
    );
  }

  const { rows } = await db.query<Requisition>(
    `update requisitions
        set status = 'rejected', rejected_by = $2, rejected_at = now(), rejected_reason = $3
      where id = $1 and tenant_id = ${TENANT}
      returning *`,
    [id, actorUserId, reason ?? null],
  );
  const rejected = rows[0];
  if (!rejected) throw new Error(`reject: requisition ${id} disappeared while being rejected`);
  return rejected;
}

/**
 * Closes a received requisition: moves the header `received -> closed` and
 * stamps `closed_at` (and, since it takes an actor, `closed_by`).
 *
 * Only a `received` requisition can be closed — the state machine allows
 * `received -> closed` and nothing else INTO `closed`, and the status trigger
 * refuses the rest. Closing is the END of the document: `closed` is TERMINAL, so
 * a closed requisition never moves again. (Goods going BACK to the warehouse are
 * a different ending — `returned` — which Task 8 owns.)
 *
 * `actorUserId` is REQUIRED — a user id — so `closed_by` can never stay NULL; it
 * is written with `closed_at` on the call.
 *
 * Call it with the scoped `db` from inside `withTenant`; never nest `withTenant`.
 */
export async function close(
  db: Queryable,
  id: string,
  actorUserId: string,
): Promise<Requisition> {
  if (typeof actorUserId !== 'string' || actorUserId.trim() === '') {
    throw new Error(
      `close: actorUserId must be a non-empty user id (got ${JSON.stringify(actorUserId)})`,
    );
  }

  const requisition = await lockForFlow(db, id, 'close');
  if (!allowedTransitions(requisition.status as RequisitionStatus).includes('closed')) {
    throw new Error(
      `close: requisition ${id} cannot be closed — its status is '${requisition.status}' (only a 'received' requisition can be closed)`,
    );
  }

  const { rows } = await db.query<Requisition>(
    `update requisitions
        set status = 'closed', closed_by = $2, closed_at = now()
      where id = $1 and tenant_id = ${TENANT}
      returning *`,
    [id, actorUserId],
  );
  const closed = rows[0];
  if (!closed) throw new Error(`close: requisition ${id} disappeared while being closed`);
  return closed;
}

/** The stable per-leg idempotency key the ISSUE leg posts its movement under. */
function issueKey(requisitionId: string, variantId: string, issuedQtyAfter: number): string {
  return `requisition:${requisitionId}:issue:${variantId}:${issuedQtyAfter}`;
}

/** The stable per-leg idempotency key the CONFIRM leg posts its movement under. */
function receiveKey(requisitionId: string, variantId: string, receivedQtyAfter: number): string {
  return `requisition:${requisitionId}:recv:${variantId}:${receivedQtyAfter}`;
}

/**
 * Locks and returns a requisition header for a flow step, or throws when it
 * does not exist for this tenant. Shared by `issue` and `confirmReceipt` so the
 * lock-then-check shape is written once.
 */
async function lockForFlow(db: Queryable, id: string, fn: string): Promise<Requisition> {
  const { rows } = await db.query<Requisition>(
    `select * from requisitions where id = $1 for update`,
    [id],
  );
  const requisition = rows[0];
  if (!requisition) {
    throw new Error(`${fn}: requisition ${id} was not found for this tenant`);
  }
  return requisition;
}

/**
 * Reads one line's quantities as NUMBERS, scoped to the current tenant, or
 * throws when the variant is not a line on the requisition. `numeric` columns
 * come back from node-postgres as strings, so every conversion happens here.
 */
async function readLine(
  db: Queryable,
  requisitionId: string,
  variantId: string,
): Promise<{ requestedQty: number; approvedQty: number | null; issuedQty: number; receivedQty: number }> {
  const { rows } = await db.query<{
    requested_qty: string;
    approved_qty: string | null;
    issued_qty: string;
    received_qty: string;
  }>(
    `select requested_qty, approved_qty, issued_qty, received_qty
       from requisition_lines
      where tenant_id = ${TENANT} and requisition_id = $1 and variant_id = $2`,
    [requisitionId, variantId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      `variant ${variantId} is not a line on requisition ${requisitionId}`,
    );
  }
  return {
    requestedQty: Number(row.requested_qty),
    approvedQty: row.approved_qty == null ? null : Number(row.approved_qty),
    issuedQty: Number(row.issued_qty),
    receivedQty: Number(row.received_qty),
  };
}
