/**
 * Requisition rules — pure functions, no database.
 *
 * A branch does not take stock from the warehouse; it ASKS for it. The document
 * that records that ask is a requisition, and it moves through a fixed set of
 * states:
 *
 *   requested -> approved | rejected
 *   approved  -> issued | partially_issued
 *   partially_issued -> issued | partially_issued | received
 *   issued    -> received | partially_issued
 *   received  -> closed | returned
 *
 * `rejected`, `closed` and `returned` are TERMINAL: a rejected requisition
 * stays rejected, a closed one stays closed, and goods that went back to the
 * warehouse stay back. The flow NEVER runs backwards — a requisition that has
 * had stock issued cannot be quietly moved back to `approved`.
 *
 * PARTIAL IS A FIRST-CLASS STATE, not a detour. A line may be issued over
 * SEVERAL legs until it reaches its target, so a requisition sits in
 * `partially_issued` while lines are still being released; a branch may also
 * CONFIRM what has actually arrived while the rest is still on the road, so a
 * confirm can leave the requisition in `partially_issued` (more is to come) as
 * well as complete it to `received`. `issued` records "every line is released
 * in full"; `received` records "every released unit has arrived AND every line
 * is fulfilled"; anything else is `partially_issued`.
 *
 * `returned` is NOT driven by this module yet: Task 8 owns the returns flow
 * (goods going back to the warehouse) and will export the function that writes
 * it. Until then `returned` is reachable only by the state machine's rules, not
 * by an exported API here.
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
 * `partially_issued` lists itself because issuing a SUBSET of the lines — or
 * confirming only PART of what was issued — leaves the requisition in the same
 * open state, one line (or one leg) fuller. It also moves to `received` when
 * the last outstanding unit arrives, and `issued` when every line has finally
 * been released in full.
 *
 * `issued` lists `partially_issued` because CONFIRMING a requisition whose lines
 * were all released can still leave stock on the road (a short delivery): the
 * released-but-not-yet-arrived remainder means more is still to come, so the
 * document is `partially_issued` until the rest lands — it does not run
 * backwards, it reflects that receipt has begun.
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
      return ['issued', 'partially_issued', 'received'];
    case 'issued':
      return ['received', 'partially_issued'];
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
 * An `issued` requisition has stock IN TRANSIT to confirm — every line has been
 * released and none has yet been acknowledged. A `partially_issued` one does
 * too: some lines (or some legs of them) have been released and their stock is
 * on the road, so the branch must be able to confirm what has actually arrived
 * while the rest is still coming. Confirming while still `requested` or
 * `approved` would move stock that never left the warehouse — so it is refused.
 * Once `received` it cannot be confirmed again (nothing is left in transit).
 */
export function canConfirm(status: RequisitionStatus): boolean {
  return status === 'issued' || status === 'partially_issued';
}
