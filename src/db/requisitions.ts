import { allowedTransitions, canConfirm, type RequisitionStatus } from '../domain/requisition.ts';
import type { Queryable } from './client.ts';
import { type Location, transitLocation } from './locations.ts';
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
 * PARTIAL IS NATIVE. `lines` may name a SUBSET of the requisition's lines; a
 * line NOT supplied is left untouched (`issued_qty` stays 0). After issuing, the
 * header is `issued` only when EVERY line has been issued in full
 * (`issued_qty >= requested_qty`, or `approved_qty` when the warehouse set one);
 * otherwise the header stays `partially_issued` and the requisition remains open
 * for the remaining lines. A line that has been issued is marked `fulfilled`.
 *
 * A line may be issued ONCE. Re-issuing a line that already carries an
 * `issued_qty` is refused rather than silently deduped: the per-line ledger key
 * (`requisition:<id>:issue:<variantId>`) makes a RETRY land on the same
 * movement, so a second, genuine issue would move no stock while the line's
 * count went up — exactly the invisible mismatch this backbone refuses. A line
 * is issued for at most its remaining target.
 *
 * IDEMPOTENT: each line posts under a STABLE per-line key
 * (`requisition:<id>:issue:<variantId>`), so a retried post lands on the SAME
 * movement.
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

    if (stored.issuedQty > 0) {
      throw new Error(
        `issue: line for variant ${line.variantId} on requisition ${id} has already been issued (issued_qty ${stored.issuedQty}) — a line is issued once, under a stable ledger key`,
      );
    }
    if (qty > target) {
      throw new Error(
        `issue: line for variant ${line.variantId} on requisition ${id} — cannot issue ${qty}, only ${target} was ${stored.approvedQty == null ? 'requested' : 'approved'}`,
      );
    }

    await postMovement(db, {
      variantId: line.variantId,
      qty,
      reason: 'issue_to_branch',
      fromLocationId: warehouse.id,
      toLocationId: transit.id,
      refType: 'REQUISITION',
      refId: id,
      idempotencyKey: issueKey(id, line.variantId),
    });

    const lineStatus = qty >= target ? 'fulfilled' : 'open';
    await db.query(
      `update requisition_lines set issued_qty = $3, status = $4
        where tenant_id = ${TENANT} and requisition_id = $1 and variant_id = $2`,
      [id, line.variantId, qty, lineStatus],
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
 * Confirms receipt of an issued requisition: for each line, writes ONE ledger
 * movement `transit -> branch` through {@link postMovement}, records what arrived
 * (`received_qty`), and advances the header to `received`.
 *
 * THIS IS WHERE STOCK BECOMES THE BRANCH'S. The issue leg credited transit; this
 * leg debits transit and credits the branch, from the SAME row, so the branch's
 * gain and transit's loss cannot drift apart. Stock in transit before this call
 * is NOT yet the branch's, and a line that arrives SHORT of what was issued is a
 * visible `short` line, not an invisible disappearance.
 *
 * Only an `issued` requisition can be confirmed ({@link canConfirm}); the state
 * machine allows `issued -> received` and nothing else, and the status trigger
 * refuses the rest. Confirming MORE than a line's `issued_qty` is refused,
 * naming the state — you cannot receive stock that never left the warehouse. A
 * line received in full is `fulfilled`; one received short is `short`.
 *
 * IDEMPOTENT: each line posts under a STABLE per-line key
 * (`requisition:<id>:recv:<variantId>`), so a retry — even one that raced past
 * the state guard — lands on the SAME movement and cannot double the branch's
 * stock. The state guard is the fast path; the key is the backstop.
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
      `confirmReceipt: requisition ${id} cannot be confirmed — its status is '${requisition.status}' (only an 'issued' requisition has stock in transit to confirm)`,
    );
  }

  const transit = await transitLocation(db);

  for (const line of lines) {
    const qty = requirePositiveQty(line.qty, 'qty', `confirmReceipt (variant ${line.variantId})`);
    const stored = await readLine(db, id, line.variantId);
    if (qty > stored.issuedQty) {
      throw new Error(
        `confirmReceipt: line for variant ${line.variantId} on requisition ${id} — cannot receive ${qty}, only ${stored.issuedQty} was issued (the line's state is 'issued')`,
      );
    }

    await postMovement(db, {
      variantId: line.variantId,
      qty,
      reason: 'issue_to_branch',
      fromLocationId: transit.id,
      toLocationId: requisition.branch_location_id,
      refType: 'REQUISITION',
      refId: id,
      idempotencyKey: receiveKey(id, line.variantId),
    });

    const target = stored.approvedQty ?? stored.requestedQty;
    const lineStatus = qty >= target ? 'fulfilled' : 'short';
    await db.query(
      `update requisition_lines set received_qty = $3, status = $4
        where tenant_id = ${TENANT} and requisition_id = $1 and variant_id = $2`,
      [id, line.variantId, qty, lineStatus],
    );
  }

  await db.query(
    `update requisitions set status = 'received', received_at = now()
      where id = $1 and tenant_id = ${TENANT}`,
    [id],
  );

  return { status: 'received' };
}

/** The stable per-line idempotency key the ISSUE leg posts its movement under. */
function issueKey(requisitionId: string, variantId: string): string {
  return `requisition:${requisitionId}:issue:${variantId}`;
}

/** The stable per-line idempotency key the CONFIRM leg posts its movement under. */
function receiveKey(requisitionId: string, variantId: string): string {
  return `requisition:${requisitionId}:recv:${variantId}`;
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
): Promise<{ requestedQty: number; approvedQty: number | null; issuedQty: number }> {
  const { rows } = await db.query<{
    requested_qty: string;
    approved_qty: string | null;
    issued_qty: string;
  }>(
    `select requested_qty, approved_qty, issued_qty
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
  };
}

/**
 * Returns the tenant's warehouse location — where issued stock leaves FROM.
 *
 * A requisition names the BRANCH it is for, not the warehouse it draws from
 * (there is one warehouse feeding every branch), so the source is resolved on
 * issue. The single active `warehouse` location is the source; if there is none
 * the flow cannot start and this throws rather than posting a movement from
 * nowhere. Call it with the scoped `db` from inside `withTenant`.
 */
async function warehouseLocation(db: Queryable): Promise<Location> {
  const { rows } = await db.query<Location>(
    `select *
       from locations
      where tenant_id = ${TENANT} and type = 'warehouse' and active
      order by code
      limit 1`,
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      'issue: no active warehouse location for this tenant to issue from',
    );
  }
  return row;
}
