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
