import { canConfirm, type RequisitionStatus } from './requisition.ts';
import { issueKey, receiveKey, round3 } from './requisition-keys.ts';

// Re-export the ONE rounding rule so the screen and the ledger round identically.
export { round3 };

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
