import { lineVariance, packToUnits } from '../domain/receipt.ts';
import type { Queryable } from './client.ts';
import { postMovement } from './movements.ts';
import type { Receipt, ReceiptLine } from './types.ts';

// Re-export the GENERATED row types rather than hand-declaring copies. The
// migration is the source of truth, `src/db/types.ts` is generated from it, and
// a hand copy here would drift. Import + re-export makes drift impossible.
export type { Receipt, ReceiptLine };

/** A receipt line as stored, re-exported for callers that read one back. */
export type ReceiptRow = Receipt;
export type ReceiptLineRow = ReceiptLine;

/** The input {@link createReceipt} accepts; `db` supplies the tenant. */
export interface CreateReceiptInput {
  /** The factory/vendor location the goods come FROM. */
  sourceLocationId: string;
  /** The location they arrive at — normally the warehouse. */
  destLocationId: string;
  /** The delivery-note number; human-typed, so normalised before it is stored. */
  refNo?: string;
  /** What the note says to expect, one entry per variant. */
  lines: Array<{ variantId: string; expectedQty: number }>;
}

/** One received line handed to {@link postReceipt}. */
export interface PostReceiptLine {
  variantId: string;
  /** The quantity in base units. Ignored when `packs` is supplied. */
  receivedQty?: number;
  /**
   * The quantity in PURCHASE PACKS. Takes PRECEDENCE over `receivedQty` when
   * both are supplied, and is converted to base units through the item's
   * `pack_factor`.
   */
  packs?: number;
}

/** A line whose received quantity differs from what was expected. */
export interface ReceiptShortfall {
  variantId: string;
  expected: number;
  received: number;
  /** `received - expected`: negative for a shortfall, positive for a surplus. */
  variance: number;
}

/** The one place `app.tenant_id` is read for a write, so it is written once. */
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/**
 * Creates a receipt header AND its expected lines for the tenant the connection
 * is scoped to, and returns the header.
 *
 * The header and every line are written through the SAME `db`, so when this is
 * called inside the caller's tenant-scoped transaction (`withTenant`) they are
 * one unit of work: a line that fails — a duplicate variant breaking the
 * per-receipt unique index, or a variant belonging to another tenant breaking
 * the composite FK — rolls the whole receipt back, and NO orphan header
 * survives. This function does not open a transaction itself; call it with the
 * scoped `db` from inside `withTenant`, never nesting `withTenant`.
 *
 * `refNo` is human-typed, so it is trimmed and upper-cased here; the database
 * carries the matching CHECK and would refuse an un-normalised value anyway. An
 * empty or omitted `refNo` is stored as NULL, not as an empty string.
 *
 * The tenant is NOT a parameter: it is read from `app.tenant_id`, which
 * `withTenant` pinned, so a caller cannot create a receipt for a tenant it is
 * not scoped to.
 */
export async function createReceipt(db: Queryable, input: CreateReceiptInput): Promise<Receipt> {
  const refNo =
    input.refNo == null || input.refNo.trim() === '' ? null : input.refNo.trim().toUpperCase();

  // A quantity must never change silently (numeric(12,3) would ROUND a bad one
  // rather than reject it), so validate the expected quantities before writing
  // anything — the same discipline postMovement applies to the ledger.
  for (const line of input.lines) {
    if (typeof line.expectedQty !== 'number' || !Number.isFinite(line.expectedQty) || line.expectedQty < 0) {
      throw new Error(
        `createReceipt: expectedQty ${JSON.stringify(line.expectedQty)} for variant ${line.variantId} must be a finite number >= 0`,
      );
    }
  }

  const { rows } = await db.query<Receipt>(
    `insert into receipts (tenant_id, source_location_id, dest_location_id, ref_no)
     values (${TENANT}, $1, $2, $3)
     returning *`,
    [input.sourceLocationId, input.destLocationId, refNo],
  );

  const receipt = rows[0];
  if (!receipt) throw new Error('createReceipt: no receipt row returned');

  for (const line of input.lines) {
    await db.query(
      `insert into receipt_lines (tenant_id, receipt_id, variant_id, expected_qty)
       values (${TENANT}, $1, $2, $3)`,
      [receipt.id, line.variantId, line.expectedQty],
    );
  }

  return receipt;
}

/**
 * Posts a receipt: records what actually arrived on each line, writes ONE ledger
 * movement per line through {@link postMovement}, marks the receipt `posted`,
 * and RETURNS the lines whose received quantity differed from the expected one.
 *
 * A receipt is a TRANSFER, not an arrival from nowhere: the movement goes
 * `from_location_id = source` (the factory) `to_location_id = dest` (the
 * warehouse), with `ref_type = 'RECEIPT'` and `ref_id = receiptId`, so the stock
 * debits the sender and credits the receiver from the SAME row. The ledger is
 * written ONLY through `postMovement` — the single gate that derives
 * discreteness from the item and validates quantity, reason and locations —
 * never a raw insert.
 *
 * IDEMPOTENT: each line posts under a STABLE per-line key
 * (`receipt:<receiptId>:<variantId>`), so a retry — even one that raced past the
 * state guard below — lands on the SAME movement and cannot double the stock.
 * The state guard is the fast path; the idempotency key is the backstop.
 *
 * A POSTED receipt is terminal: a second post is refused with an error naming
 * its state. `packs`, when supplied on a line, takes precedence over
 * `receivedQty` and is converted to base units via the item's `pack_factor`.
 *
 * Call it with the scoped `db` from inside `withTenant`; never nest `withTenant`.
 */
export async function postReceipt(
  db: Queryable,
  receiptId: string,
  lines: Array<PostReceiptLine>,
): Promise<{ shortfalls: ReceiptShortfall[] }> {
  // Lock the header for the life of the transaction, so two concurrent posts
  // serialise on it and the second sees the first's `posted` status.
  const { rows: headerRows } = await db.query<Receipt>(
    `select * from receipts where id = $1 for update`,
    [receiptId],
  );
  const receipt = headerRows[0];
  if (!receipt) {
    throw new Error(`postReceipt: receipt ${receiptId} was not found for this tenant`);
  }
  if (receipt.status !== 'draft') {
    throw new Error(
      `postReceipt: receipt ${receiptId} cannot be posted — its status is '${receipt.status}' (already posted)`,
    );
  }

  const shortfalls: ReceiptShortfall[] = [];

  for (const line of lines) {
    // The expected quantity comes from the stored line, never the caller: the
    // whole point is that what was EXPECTED is a fact the note fixed.
    const { rows: lineRows } = await db.query<{ expected_qty: string }>(
      `select expected_qty from receipt_lines
        where tenant_id = ${TENANT} and receipt_id = $1 and variant_id = $2`,
      [receiptId, line.variantId],
    );
    const stored = lineRows[0];
    if (!stored) {
      throw new Error(
        `postReceipt: variant ${line.variantId} is not a line on receipt ${receiptId}`,
      );
    }
    const expected = Number(stored.expected_qty);

    // The item's pack factor is read through the variant — the ONE conversion
    // the receiving path is allowed to do.
    const packFactor = await readPackFactor(db, line.variantId);

    // `packs` wins over `receivedQty` when both are supplied.
    const received =
      line.packs != null
        ? packToUnits(line.packs, packFactor)
        : (line.receivedQty ?? 0);

    if (typeof received !== 'number' || !Number.isFinite(received) || received < 0) {
      throw new Error(
        `postReceipt: received quantity ${JSON.stringify(received)} for variant ${line.variantId} must be a finite number >= 0`,
      );
    }

    // Record what arrived. `variance_qty` regenerates from it automatically.
    await db.query(
      `update receipt_lines set received_qty = $3
        where tenant_id = ${TENANT} and receipt_id = $1 and variant_id = $2`,
      [receiptId, line.variantId, received],
    );

    // The ledger only ever receives a POSITIVE movement (validateMovement
    // refuses zero): a line that received nothing moved nothing, but still
    // shows up in the shortfall report below.
    if (received > 0) {
      await postMovement(db, {
        variantId: line.variantId,
        qty: received,
        reason: 'receipt',
        fromLocationId: receipt.source_location_id,
        toLocationId: receipt.dest_location_id,
        refType: 'RECEIPT',
        refId: receiptId,
        idempotencyKey: receiptLineKey(receiptId, line.variantId),
      });
    }

    const variance = lineVariance(expected, received);
    if (variance !== 0) {
      shortfalls.push({ variantId: line.variantId, expected, received, variance });
    }
  }

  // Freeze the header. Done last, so a failure above (a bad variant, a refused
  // line) rolls the whole post back and leaves the receipt still `draft`.
  await db.query(
    `update receipts set status = 'posted', received_at = now() where id = $1 and tenant_id = ${TENANT}`,
    [receiptId],
  );

  return { shortfalls };
}

/** The stable per-line idempotency key a receipt posts its movements under. */
function receiptLineKey(receiptId: string, variantId: string): string {
  return `receipt:${receiptId}:${variantId}`;
}

/**
 * Reads the pack factor of the item behind a variant, scoped to the current
 * tenant. Returns `null` when the item has none (bought one-for-one) — which
 * makes {@link packToUnits} pass the entered number through unchanged.
 */
async function readPackFactor(db: Queryable, variantId: string): Promise<number | null> {
  const { rows } = await db.query<{ pack_factor: string | null }>(
    `select i.pack_factor
       from item_variants v
       join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
      where v.id = $1
        and v.tenant_id = ${TENANT}`,
    [variantId],
  );
  const raw = rows[0]?.pack_factor;
  return raw == null ? null : Number(raw);
}
