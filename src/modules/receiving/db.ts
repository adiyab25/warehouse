import { lineVariance, packToUnits } from './schema.ts';
import type { Queryable } from '@/modules/platform/index';
import { postMovement } from '@/modules/ledger/index';
import type { Receipt, ReceiptLine } from '@/modules/platform/index';

// Re-export the GENERATED row types rather than hand-declaring copies. The
// migration is the source of truth, `src/db/types.ts` is generated from it, and
// a hand copy here would drift. Import + re-export makes drift impossible.
export type { Receipt, ReceiptLine };

/** A receipt line as stored, re-exported for callers that read one back. */
export type ReceiptRow = Receipt;
export type ReceiptLineRow = ReceiptLine;

/** The input {@link createReceipt} accepts; `db` supplies the tenant. */
export interface CreateReceiptInput {
  /**
   * OPTIONAL: the id this receipt must carry.
   *
   * A caller that opens a FORM mints one uuid when the form appears and sends
   * it back on every submit, so the whole create-then-post is idempotent: a
   * double-tap or a lost response re-uses the SAME receipt — whose per-line
   * movements are keyed on the receipt id — instead of racing a second receipt
   * into existence and posting the goods twice. A caller with nothing to key on
   * omits it and the database generates one, exactly as before.
   *
   * A receipt with this id that ALREADY EXISTS is returned UNCHANGED and its
   * lines are NOT rewritten — the retry of a form, not a fresh document. Use a
   * NEW id for a genuinely new delivery; re-using an id with different lines is
   * a bug, and this is not the place to guess what was meant.
   */
  id?: string;
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
   * `pack_factor`. Must be a real `number` (a full-number count of packs), not a
   * numeric string: a string would be coerced silently by the multiplication and
   * a typo would post the wrong quantity.
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

/**
 * Another ALREADY-POSTED receipt in the same tenant carrying the SAME normalised
 * delivery-note number. This is a WARNING, never a refusal: one delivery note
 * can legitimately cover several lorries, so a second receipt under the same
 * number is reported rather than blocked.
 */
export interface ReceiptDuplicate {
  receiptId: string;
  postedAt: string;
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
 * survives. This writes the header AND its lines (two or more rows) and is
 * therefore NOT atomic on its own: it does not open a transaction itself, it
 * REQUIRES the caller's tenant-scoped transaction. Call it with the scoped `db`
 * from inside `withTenant`, never nesting `withTenant`.
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
  // anything — the same discipline postMovement applies to the ledger. A line
  // that expects NOTHING is a mistake, not a zero, so the floor is 1, matching
  // the database's `expected_qty > 0` CHECK.
  for (const line of input.lines) {
    if (typeof line.expectedQty !== 'number' || !Number.isFinite(line.expectedQty) || line.expectedQty <= 0) {
      throw new Error(
        `createReceipt: expectedQty ${JSON.stringify(line.expectedQty)} for variant ${line.variantId} must be a finite number > 0`,
      );
    }
  }

  const { rows } = await db.query<Receipt>(
    `insert into receipts (id, tenant_id, source_location_id, dest_location_id, ref_no, number)
     values (coalesce($4::uuid, gen_random_uuid()), ${TENANT}, $1, $2, $3, next_doc_number('receipt'))
     on conflict (id) do nothing
     returning *`,
    [input.sourceLocationId, input.destLocationId, refNo, input.id ?? null],
  );

  let receipt = rows[0];
  if (!receipt) {
    // No row came back, so the insert was swallowed by the id conflict: this
    // receipt ALREADY EXISTS and this call is the retry of a form. Return it as
    // it stands — its lines are NOT rewritten (they are the ones the first
    // submit wrote), which is what makes a double-tap collapse to ONE receipt.
    const { rows: existing } = await db.query<Receipt>('select * from receipts where id = $1', [
      input.id ?? null,
    ]);
    receipt = existing[0];
    if (!receipt) {
      throw new Error(
        `createReceipt: receipt ${input.id} already exists but is not visible to this tenant`,
      );
    }
    return receipt;
  }

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
 * movement per line through {@link postMovement}, advances the header's status,
 * and returns the lines whose received quantity differed from the expected one
 * plus any duplicate delivery-note warning.
 *
 * A receipt is a TRANSFER, not an arrival from nowhere: the movement goes
 * `from_location_id = source` (the factory) `to_location_id = dest` (the
 * warehouse), with `ref_type = 'RECEIPT'` and `ref_id = receiptId`, so the stock
 * debits the sender and credits the receiver from the SAME row. The ledger is
 * written ONLY through `postMovement` — the single gate that derives
 * discreteness from the item and validates quantity, reason and locations —
 * never a raw insert.
 *
 * PARTIAL DELIVERIES: `lines` may name a SUBSET of the receipt's lines — a
 * delivery arrives in parts. A line NOT supplied is left untouched
 * (`received_qty` stays NULL) and produces NO shortfall: a shortfall is reported
 * ONLY for a line actually received for less than expected, never for goods that
 * have not arrived yet. After posting, the header becomes `posted` when EVERY
 * line now carries a `received_qty`, and `receiving` otherwise, so a
 * part-received document records reality instead of a phantom shortage. A
 * `receiving` receipt may be posted again to receive the remaining lines; a
 * `posted` receipt may NOT (it is terminal).
 *
 * DUPLICATE NOTE: before posting, this looks for another ALREADY-POSTED receipt
 * in the same tenant with the same normalised `ref_no`. If one exists it is
 * returned as `duplicateOf` — a REPORTABLE WARNING, not a refusal: a single
 * delivery note can legitimately cover several lorries, so the second receipt
 * still posts.
 *
 * IDEMPOTENT: each line posts under a STABLE per-line key
 * (`receipt:<receiptId>:<variantId>`), so a retry — even one that raced past the
 * state guard below — lands on the SAME movement and cannot double the stock.
 * The state guard is the fast path; the idempotency key is the backstop.
 *
 * `receivedBy` is REQUIRED — the user id of whoever received the goods — so a
 * caller cannot forget to record it; it is written to `received_by` (with
 * `received_at`) on every post. `packs`, when supplied on a line, takes
 * precedence over `receivedQty` and is converted to base units via the item's
 * `pack_factor`; it must be a real number.
 *
 * Call it with the scoped `db` from inside `withTenant`; never nest `withTenant`.
 */
export async function postReceipt(
  db: Queryable,
  receiptId: string,
  lines: Array<PostReceiptLine>,
  receivedBy: string,
): Promise<{ shortfalls: ReceiptShortfall[]; duplicateOf: ReceiptDuplicate | null }> {
  // The receiver is required so `received_by` can never stay NULL. Validate
  // before touching anything so a caller that forgot gets a named error.
  if (typeof receivedBy !== 'string' || receivedBy.trim() === '') {
    throw new Error(
      `postReceipt: receivedBy must be a non-empty user id (got ${JSON.stringify(receivedBy)})`,
    );
  }

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
  // A `posted` receipt is terminal; a `draft` or a `receiving` one may be posted.
  if (receipt.status === 'posted') {
    throw new Error(
      `postReceipt: receipt ${receiptId} cannot be posted — its status is 'posted' (already posted)`,
    );
  }

  // Surface — never block — a delivery note already posted by another receipt in
  // this tenant. `ref_no` is already normalised (trimmed, upper-cased), so a
  // plain equality is the right test. Skip when this receipt has no note.
  const duplicateOf = await findPostedDuplicate(db, receipt.ref_no, receiptId);

  const shortfalls: ReceiptShortfall[] = [];

  for (const line of lines) {
    // `packs` must be a real number: a numeric STRING would be coerced silently
    // by the multiplication ('2' × 24 = 48) and a typo would post a wrong
    // quantity. Same discipline as `receivedQty` below, checked BEFORE the
    // conversion so nothing is coerced on the way in.
    if (
      line.packs != null &&
      (typeof line.packs !== 'number' || !Number.isFinite(line.packs) || line.packs < 0)
    ) {
      throw new Error(
        `postReceipt: packs ${JSON.stringify(line.packs)} for variant ${line.variantId} must be a finite number >= 0, not a string`,
      );
    }

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
        actorUserId: receivedBy,
        refType: 'RECEIPT',
        refId: receiptId,
        idempotencyKey: receiptLineKey(receiptId, line.variantId),
      });
    }

    // A shortfall is reported for a line RECEIVED in this post and differing
    // from expected — never for a line left untouched (its goods have not
    // arrived, so it is not a shortage).
    const variance = lineVariance(expected, received);
    if (variance !== 0) {
      shortfalls.push({ variantId: line.variantId, expected, received, variance });
    }
  }

  // Advance the header. `posted` only once EVERY line carries a `received_qty`;
  // otherwise the receipt stays `receiving` and may be posted again. Done last,
  // so a failure above (a bad variant, a refused line) rolls the whole post back
  // and leaves the receipt in its previous status. `received_by`/`received_at`
  // record who received — on every post, so the latest receiver is on the header.
  const { rows: unreceived } = await db.query<{ n: number }>(
    `select count(*)::int as n from receipt_lines
      where tenant_id = ${TENANT} and receipt_id = $1 and received_qty is null`,
    [receiptId],
  );
  const status = unreceived[0]!.n === 0 ? 'posted' : 'receiving';

  await db.query(
    `update receipts set status = $2, received_by = $3, received_at = now()
      where id = $1 and tenant_id = ${TENANT}`,
    [receiptId, status, receivedBy],
  );

  return { shortfalls, duplicateOf };
}

/**
 * The EARLIEST-posted OTHER receipt in this tenant carrying the same normalised
 * delivery-note number, if any. `null` when the note is blank or no other
 * receipt has posted it. A reportable warning, never a block.
 *
 * EXPORTED because the intake screen must surface the warning BEFORE the goods
 * are accepted — a manager at the door with a lorry decides whether to take the
 * delivery — and that pre-check must ask exactly the question the post asks.
 * `excludeReceiptId` is the receipt doing the asking; pass `null` when there is
 * none yet (the screen's pre-check runs before the receipt exists).
 */
export async function findPostedDuplicate(
  db: Queryable,
  refNo: string | null,
  excludeReceiptId: string | null,
): Promise<ReceiptDuplicate | null> {
  if (refNo == null) return null;
  const { rows } = await db.query<{ id: string; received_at: Date | null }>(
    `select id, received_at
       from receipts
      where tenant_id = ${TENANT}
        and ref_no = $1
        and status = 'posted'
        and ($2::uuid is null or id <> $2)
      order by received_at asc nulls last
      limit 1`,
    [refNo, excludeReceiptId],
  );
  const row = rows[0];
  if (!row) return null;
  // `received_at` is a timestamptz, which node-postgres hands back as a Date;
  // the caller gets an ISO string so the shape is stable.
  return { receiptId: row.id, postedAt: row.received_at ? row.received_at.toISOString() : '' };
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
