import type { ItemVariant } from '../db/types.ts';
import { isValidScannedCode, normaliseScannedCode } from './barcode.ts';
import { lineVariance } from './receipt.ts';

/**
 * The warehouse INTAKE DOOR — the rules of the screen where stock is counted in.
 *
 * Pure functions, no database and no Next: this is the part of Task 13 that can
 * be reasoned about on its own, and it exists as a module rather than inline in
 * the screen for the same reason src/domain/receipt.ts does — the screen's job
 * is layout, the rule's job is here.
 *
 * THREE RULES THIS MODULE OWNS
 *
 *   (1) A SCAN NEVER SILENTLY DOES NOTHING, and never creates an item.
 *       {@link resolveScan} normalises the code BEFORE it looks it up (so a
 *       padded, lower-cased scan reaches the same row a clean one does) and
 *       answers an unknown code with `{ kind: 'unknown', code }` — echoing the
 *       code it was given. Nothing here can mint a row; the only writer in the
 *       whole intake path is Task 6's `createReceipt`/`postReceipt`.
 *
 *   (2) INTAKE IS A WAREHOUSE FUNCTION. {@link canReceive} is the ONE place the
 *       role question is answered, and the server-side seams all ask it, so a
 *       `branch_user` is refused at the action rather than merely hidden in the
 *       UI. It takes a plain `string` on purpose: the caller may hold an
 *       invalid role, an empty string or nothing at all, and this must answer.
 *
 *   (3) A SHORTFALL IS REPORTED, NEVER ABSORBED — and goods that have NOT
 *       arrived are not a shortage. {@link previewShortfalls} mirrors the
 *       database's generated `receipt_lines.variance_qty` (through the same
 *       {@link lineVariance} Task 6 uses) for the screen's live warning, and
 *       {@link receivedLines} is what actually gets posted: a line with no
 *       received quantity is LEFT OUT of the post entirely, so a delivery
 *       arriving in PARTS stays expressible and produces no phantom shortage.
 *
 * The number the screen shows BEFORE posting is therefore the same number Task 6
 * stores afterwards; the authoritative figure is always the one that comes back
 * from `postReceipt`.
 */

/**
 * The roles that may count stock in. `owner` and `warehouse_manager` — the
 * warehouse function — and NOT `branch_user`, which may only draw stock for its
 * own branch. Mirrors the `app_users.role` CHECK.
 */
export const RECEIVING_ROLES = ['owner', 'warehouse_manager'] as const;

/** A role that may receive goods. */
export type ReceivingRole = (typeof RECEIVING_ROLES)[number];

/**
 * May `role` post a receipt? The single answer, asked server-side by every
 * intake seam. Anything unrecognised — an empty string, `null`, `undefined`, a
 * role from another deployment — is refused, because the safe default for a
 * ledger writer is "no".
 */
export function canReceive(role: string | null | undefined): role is ReceivingRole {
  return typeof role === 'string' && (RECEIVING_ROLES as readonly string[]).includes(role);
}

/**
 * What a scan resolved to: the variant it named, or the code that matched
 * nothing. `unknown` carries the NORMALISED code — the canonical form of what
 * was scanned, which is what a person can match against the printed barcode.
 */
export type ScanResult =
  | { kind: 'variant'; variant: ItemVariant }
  | { kind: 'unknown'; code: string };

/**
 * Resolves a scanned code to a variant, or echoes it back as unknown.
 *
 * TWO STEPS, IN THIS ORDER, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   1. NORMALISE (trim + upper-case) — a scanner emits the printed code, but a
 *      person typing it (or a scanner with a stray space) does not, and
 *      `findByBarcode` matches the STORED code. The normalised value is what is
 *      handed to `lookup`, so the screen's path cannot bypass the data layer's
 *      rule by accident on the way in.
 *   2. SHAPE-CHECK, THEN LOOK UP — a code that is not a scannable shape
 *      (`PREFIX-SEQ`) can never be a stored barcode, so it is answered as
 *      unknown WITHOUT a database round trip, and no path here can create one.
 *
 * `lookup` is injected — the caller supplies `findByBarcode` over its own
 * tenant-scoped connection — which is what makes this testable without a
 * database and keeps this module free of one.
 */
export async function resolveScan(
  code: string,
  lookup: (normalisedCode: string) => Promise<ItemVariant | null>,
): Promise<ScanResult> {
  const normalised = normaliseScannedCode(typeof code === 'string' ? code : '');
  if (!isValidScannedCode(normalised)) return { kind: 'unknown', code: normalised };

  const variant = await lookup(normalised);
  if (!variant) return { kind: 'unknown', code: normalised };

  return { kind: 'variant', variant };
}

/** One line as the screen holds it, before anything is posted. */
export interface IntakeLine {
  variantId: string;
  /** What the delivery note says to expect. A finite number > 0. */
  expected: number;
  /** What actually arrived, or `null` while the goods have not arrived. */
  received: number | null;
}

/**
 * The form as the screen submits it.
 *
 * `formId` is the SCREEN-GENERATED KEY: one uuid, minted when the form opens,
 * kept stable across every retry, and used as the receipt's own id. A
 * double-tap therefore lands on the same receipt (whose per-line idempotency
 * key is `receipt:<receiptId>:<variantId>` — see src/db/receipts.ts), while a
 * genuinely second delivery gets a NEW form, a new key and its own receipt.
 */
export interface ReceiptForm {
  /** The stable per-form key, generated when the form opens. A uuid. */
  formId: string;
  /** The delivery-note number, typed off the paperwork. Required. */
  refNo: string;
  /** The location the goods came FROM (normally a vendor). Required. */
  sourceLocationId: string;
  lines: IntakeLine[];
}

/** A line whose received quantity differs from what was expected. */
export interface LineVariance {
  variantId: string;
  expected: number;
  received: number;
  /** `received - expected`: negative for a shortfall, positive for a surplus. */
  variance: number;
}

/**
 * The lines whose received quantity differs from what was expected.
 *
 * A line that has NOT been received (`received === null`) is SKIPPED, never
 * treated as zero: a delivery arriving in parts must stay expressible, and
 * goods that have not arrived are not a shortage. This mirrors Task 6's
 * `postReceipt` exactly, so the warning the manager sees before posting and the
 * shortfall the receipt records afterwards can never disagree.
 */
export function previewShortfalls(lines: readonly IntakeLine[]): LineVariance[] {
  const shortfalls: LineVariance[] = [];
  for (const line of lines) {
    if (line.received == null) continue;
    const variance = lineVariance(line.expected, line.received);
    if (variance !== 0) {
      shortfalls.push({
        variantId: line.variantId,
        expected: line.expected,
        received: line.received,
        variance,
      });
    }
  }
  return shortfalls;
}

/**
 * The lines that actually arrived, in the shape {@link postReceipt} takes.
 *
 * An unreceived line is left out entirely — it is not posted as a zero. Task 6
 * then leaves its `received_qty` NULL and the header stays `receiving`, so the
 * remaining goods may be received later against the same form.
 */
export function receivedLines(lines: readonly IntakeLine[]): Array<{ variantId: string; receivedQty: number }> {
  return lines
    .filter((line): line is IntakeLine & { received: number } => line.received != null)
    .map((line) => ({ variantId: line.variantId, receivedQty: line.received }));
}
