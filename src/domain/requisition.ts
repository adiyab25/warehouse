/**
 * Requisition rules — pure functions, no database.
 *
 * A branch does not take stock from the warehouse; it ASKS for it. The document
 * that records that ask is a requisition, and it moves through a fixed set of
 * states:
 *
 *   requested -> approved | rejected
 *   approved  -> issued | partially_issued
 *   partially_issued -> issued | partially_issued
 *   issued    -> received
 *   received  -> closed | returned
 *
 * `rejected`, `closed` and `returned` are TERMINAL: a rejected requisition
 * stays rejected, a closed one stays closed, and goods that went back to the
 * warehouse stay back. The flow NEVER runs backwards — a requisition that has
 * had stock issued cannot be quietly moved back to `approved`.
 *
 * This module is the SINGLE source of truth for that machine. The migration
 * (0007_requisitions.sql) enforces the same transitions in a `before update`
 * trigger, so neither the app nor a raw UPDATE can drive a document backwards;
 * these functions are what the app judges a move against FIRST, so it fails
 * with a readable reason before a round trip.
 */

/**
 * Every state a requisition can be in.
 *
 * Kept in lockstep with the `requisitions_status_check` CHECK in 0007 — the
 * database is the last line, this union is the first. Nothing mutates it.
 */
export type RequisitionStatus =
  | 'requested'
  | 'approved'
  | 'partially_issued'
  | 'issued'
  | 'received'
  | 'closed'
  | 'rejected'
  | 'returned';

/**
 * The states `status` may move TO next — exactly the state machine above, and
 * nothing else.
 *
 * A terminal state (`closed`, `rejected`, `returned`) has NO onward
 * transitions: the empty array is what makes a document in one of them final.
 * `partially_issued` lists itself because issuing a SUBSET of the lines leaves
 * the requisition in the same open state — a partial issue is not a move to a
 * new state, it is the same state one more line fuller.
 *
 * The return value is a fresh array per call, so a caller cannot mutate the
 * machine by pushing onto it.
 */
export function allowedTransitions(status: RequisitionStatus): RequisitionStatus[] {
  switch (status) {
    case 'requested':
      return ['approved', 'rejected'];
    case 'approved':
      return ['issued', 'partially_issued'];
    case 'partially_issued':
      return ['issued', 'partially_issued'];
    case 'issued':
      return ['received'];
    case 'received':
      return ['closed', 'returned'];
    case 'closed':
    case 'rejected':
    case 'returned':
      return [];
  }
}

/**
 * Whether a branch may confirm receipt of a requisition that is in this state.
 *
 * Only an `issued` requisition has stock IN TRANSIT to confirm: the warehouse
 * has released it, the branch has not yet acknowledged it. Confirming while
 * still `requested` (or `approved`, or `partially_issued`) would move stock that
 * never left the warehouse — so it is refused. Once `received` it cannot be
 * confirmed again (it is no longer issued).
 */
export function canConfirm(status: RequisitionStatus): boolean {
  return status === 'issued';
}
