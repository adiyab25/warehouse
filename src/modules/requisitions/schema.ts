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
/**
 * THE ledgers' per-leg key FORMAT for the requisition flow — the ONE place the
 * strings `requisition:<id>:issue:<variant>:<qty-after>` and
 * `requisition:<id>:recv:<variant>:<qty-after>` are built.
 *
 * WHY THIS MODULE EXISTS. The key is written by Task 7's writers
 * (`src/db/requisitions.ts`) and INDEPENDENTLY re-derived by the screens
 * (`src/domain/requisition-ui.ts` → `src/app/requisitions/handler.ts`) to answer
 * "has this exact leg already posted?". When those two lived as separate string
 * literals, a change to one silently stopped matching the other and a
 * double-tap posted a SECOND movement. There is now exactly one implementation,
 * so the two can never drift.
 *
 * WHY IT IS DEPENDENCY-FREE. `src/domain/requisition-ui.ts` is imported by two
 * `'use client'` components. If the key builders lived in `src/db/requisitions.ts`
 * they would drag `pg` (and the whole database layer) into the client bundle.
 * This module imports NOTHING — no `pg`, no `next`, no other module — so a
 * component can reach it without pulling a driver across the client boundary.
 * (A test asserts the file has no import at all.)
 */

/**
 * Rounds to the 3 decimals `numeric(12, 3)` stores — the same rounding the
 * ledger applies before it builds a per-leg key, so a key is byte-identical
 * between the first post and a retry. Kept here, beside the builders, because a
 * key built from an unrounded sum would never match on retry.
 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The stable per-leg idempotency key the ISSUE leg posts its movement under:
 * `requisition:<id>:issue:<variantId>:<issuedQtyAfter>`, where `issuedQtyAfter`
 * is the CUMULATIVE issued quantity the leg produces.
 */
export function issueKey(requisitionId: string, variantId: string, issuedQtyAfter: number): string {
  return `requisition:${requisitionId}:issue:${variantId}:${round3(issuedQtyAfter)}`;
}

/**
 * The stable per-leg idempotency key the CONFIRM (receipt) leg posts its
 * movement under: `requisition:<id>:recv:<variantId>:<receivedQtyAfter>`, where
 * `receivedQtyAfter` is the CUMULATIVE received quantity the leg produces.
 */
export function receiveKey(requisitionId: string, variantId: string, receivedQtyAfter: number): string {
  return `requisition:${requisitionId}:recv:${variantId}:${round3(receivedQtyAfter)}`;
}

// Re-export the ONE rounding rule so the screen and the ledger round identically.

/**
 * The requisition SCREENS' rules — pure functions, no database and no Next.
 *
 * Three questions the branch and warehouse screens must answer the same way
 * every time, kept here rather than inline in a component for the same reason
 * `src/domain/intake.ts` exists: the screen's job is layout, the rule's job is
 * here, and a rule written once in a component is a rule a reviewer has to hunt
 * for across four files.
 *
 *   (1) WHICH AFFORDANCES THE CURRENT STATE AND THE VIEWER'S ROLE PERMIT.
 *       {@link availableActions} is the SINGLE answer, and the detail screen
 *       renders its buttons from it — so a button can never be present in a
 *       state where the write behind it would be refused, and never absent in a
 *       state where it is the only way forward.
 *
 *   (2) WHY A FLOW WAS REFUSED — a NAMED condition, not a bare `Error`.
 *       {@link RequisitionRefusal} is the closed set of codes and
 *       {@link REFUSAL_MESSAGE_KEYS} is the ONE place a code becomes a message
 *       key. Every code maps to a DISTINCT key, so a `forbidden` is never
 *       dressed up as "you are not signed in" — the failure Task 13's review
 *       found in a blanket catch.
 *
 *   (3) HOW MUCH MAY BE MOVED, AND WHAT NAMES THE STATE WHEN IT MAY NOT.
 *       {@link issueProblem} and {@link confirmProblem} mirror the guards inside
 *       Task 7's `issue`/`confirmReceipt` EXACTLY, so the screen can refuse
 *       before a round trip with the same precision, and a refusal identifies
 *       the state (`wrong_state`) rather than collapsing to `invalid`.
 *
 * The asymmetry that matters: ISSUING is the warehouse's act and CONFIRMING is
 * the branch's, and neither role may do the other's. Nothing here trusts the
 * caller — these rules are asserted again server-side in
 * `src/app/requisitions/handler.ts`, because a hidden button is not a
 * permission.
 */

/**
 * Why a requisition request was refused — a machine-readable code the UI
 * switches on. `wrong_state` is the one that matters most: it is what an
 * over-issue, an over-confirm or a move from the wrong state reports, and its
 * message names the state rather than blurring into a generic failure.
 */
export type RequisitionRefusal = 'unauthenticated' | 'forbidden' | 'invalid' | 'wrong_state';

/** The i18n key for each refusal CODE — the ONE place a code becomes a sentence. */
export const REFUSAL_MESSAGE_KEYS: Record<RequisitionRefusal, string> = {
  unauthenticated: 'requisitions.error.unauthenticated',
  forbidden: 'requisitions.error.forbidden',
  invalid: 'requisitions.error.invalid',
  wrong_state: 'requisitions.error.wrong_state',
};

/**
 * May `role` REQUEST stock for a branch, and CONFIRM what arrives for it?
 *
 * A requisition is the branch's own ask, and the branch is the only party that
 * knows what actually turned up at its door — so requesting and confirming are
 * the same role, and it is not the warehouse's. Anything unrecognised is
 * refused: the safe default for a document that moves stock is "no".
 */
export function canRequest(role: string | null | undefined): boolean {
  return role === 'branch_user';
}

/**
 * May `role` APPROVE a requisition and ISSUE stock against it?
 *
 * The warehouse function: `owner` and `warehouse_manager`, mirroring
 * `app_users.role`. Deliberately disjoint from {@link canRequest} — approving
 * your own request is not a permission anyone holds.
 */
export function canApproveOrIssue(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'warehouse_manager';
}

/** The acts the detail view may offer for one viewer, in one state. */
export interface RequisitionActionSet {
  /** Approve a `requested` requisition (warehouse only). */
  canApprove: boolean;
  /** Release stock against an `approved`/`partially_issued` requisition (warehouse only). */
  canIssue: boolean;
  /**
   * Acknowledge what arrived (branch only), for the states where stock is
   * really IN TRANSIT — see {@link canConfirmState}. Present for BOTH `issued`
   * and `partially_issued`: requiring a full issue before any confirm would
   * leave goods on the road with no way to close the document.
   */
  canConfirm: boolean;
}

/**
 * Whether confirming is possible in this state at all — re-exported from
 * `src/domain/requisition.ts` so this module owns the whole answer the screen
 * asks for, while the state machine keeps owning the rule.
 */
export const canConfirmState = canConfirm;

/**
 * The acts the detail view may render: the CURRENT state crossed with the
 * VIEWER'S role, and nothing else.
 *
 * This is the function the screen's buttons are built from, so removing the
 * role half, or the state half, changes what a person can do — which is exactly
 * what the named test ('the confirm button is absent unless status is issued')
 * fails on when the guard is dropped.
 */
export function availableActions(
  status: RequisitionStatus,
  role: string | null | undefined,
): RequisitionActionSet {
  const warehouse = canApproveOrIssue(role);
  const branch = canRequest(role);
  return {
    canApprove: warehouse && status === 'requested',
    canIssue: warehouse && (status === 'approved' || status === 'partially_issued'),
    canConfirm: branch && canConfirm(status),
  };
}

/**
 * The ledger key Task 7's ISSUE leg posts its movement under.
 *
 * `requisition:<id>:issue:<variantId>:<issuedQtyAfter>` — now built by the ONE
 * implementation in `src/domain/requisition-keys.ts`, imported by BOTH this
 * module and `src/db/requisitions.ts`, so the anchor the screen derives can
 * never drift from the `idempotency_key` the write actually stores (which is
 * what makes a double tap land on ONE movement). A thin wrapper so the
 * screen-side name and its existing callers/tests stay stable.
 */
export function issueAnchor(requisitionId: string, variantId: string, issuedQtyAfter: number): string {
  return issueKey(requisitionId, variantId, issuedQtyAfter);
}

/**
 * The ledger key Task 7's CONFIRM leg posts its movement under —
 * `requisition:<id>:recv:<variantId>:<receivedQtyAfter>`, built by the SAME ONE
 * implementation as {@link issueAnchor}, for the same reason.
 */
export function confirmAnchor(requisitionId: string, variantId: string, receivedQtyAfter: number): string {
  return receiveKey(requisitionId, variantId, receivedQtyAfter);
}

/** What a line holds for the issue guard: how much was agreed, and how much left. */
export interface IssueLineState {
  /** `approved_qty` when the warehouse set one, else `requested_qty`. */
  target: number;
  /** What has already left the warehouse. */
  issued: number;
}

/** What a line holds for the confirm guard: what left, and what has landed. */
export interface ConfirmLineState {
  issued: number;
  received: number;
}

/**
 * May `qty` be ISSUED from this line — and if not, which refusal?
 *
 *   * the requisition must be `approved` or `partially_issued` (only stock the
 *     warehouse agreed to release leaves the building);
 *   * the quantity must be a finite number > 0 (a `numeric(12,3)` column would
 *     round a bad one silently, so this is the gate);
 *   * it may not EXCEED what remains to the line's target, and a line already
 *     at its target has nothing left — both are `wrong_state`.
 *
 * A partial issue is NATIVE: a line may take several legs, so a qty at or below
 * the remainder is fine. `null` means "allowed".
 */
export function issueProblem(
  status: RequisitionStatus,
  line: IssueLineState,
  qty: number,
): RequisitionRefusal | null {
  if (status !== 'approved' && status !== 'partially_issued') return 'wrong_state';
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) return 'invalid';
  const remaining = round3(line.target - line.issued);
  if (remaining <= 0) return 'wrong_state';
  if (qty > remaining) return 'wrong_state';
  return null;
}

/**
 * May `qty` be CONFIRMED for this line — and if not, which refusal?
 *
 * Mirrors Task 7's `confirmReceipt` guard exactly:
 *
 *   * the requisition must be `issued` or `partially_issued` — stock must have
 *     actually left the warehouse before any of it can arrive;
 *   * the quantity must be a finite number > 0;
 *   * it may not EXCEED what is still in transit (`issued - received`) — you
 *     cannot receive stock that never left — and a line with nothing left on
 *     the road has nothing to confirm. Both are `wrong_state`, which is the
 *     refusal the named test asserts BY NAME.
 *
 * `null` means "allowed".
 */
export function confirmProblem(
  status: RequisitionStatus,
  line: ConfirmLineState,
  qty: number,
): RequisitionRefusal | null {
  if (!canConfirm(status)) return 'wrong_state';
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) return 'invalid';
  const inTransit = round3(line.issued - line.received);
  if (inTransit <= 0) return 'wrong_state';
  if (qty > inTransit) return 'wrong_state';
  return null;
}
