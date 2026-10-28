import { currentUser, type CurrentUser } from '../../auth/current-user.ts';
import type { Queryable } from '../../db/client.ts';
import { findByBarcode } from '../../db/items.ts';
import { findWarehouseLocation, vendorLocations } from '../../db/locations.ts';
import {
  createReceipt,
  findPostedDuplicate,
  postReceipt,
  type ReceiptDuplicate,
  type ReceiptShortfall,
} from '../../db/receipts.ts';
import type { Location } from '../../db/types.ts';
import {
  canReceive,
  receivedLines,
  resolveScan,
  type ReceiptForm,
  type ScanResult,
} from '../../domain/intake.ts';

/**
 * The intake screen's LOGIC, with the request boundary left OUT.
 *
 * WHY THIS IS NOT INSIDE `actions.ts` (which is `'use server'`): a `'use server'`
 * module may export only async functions, it reads `next/headers` — which no
 * `node --test` process has — and it opens the tenant scope. Splitting the two
 * is the same seam `src/auth/current-user.ts` uses (`currentUser` / the request
 * path) and the same shape as `src/app/api/labels/handler.ts`:
 *
 *   * {@link frontDoor}, {@link scanIn}, {@link submitIn}, {@link checkNoteIn}
 *     are the LOGIC. Each takes an ALREADY tenant-scoped `db` and the raw
 *     session cookie value, so a test drives them against a real database on a
 *     real tenant with no HTTP layer at all.
 *   * `src/app/intake/actions.ts` is the REQUEST path: it reads the cookie,
 *     opens EXACTLY ONE `withTenant` (`await getAppPool()`,
 *     `configuredTenantId()`) and delegates.
 *
 * `withTenant` is NOT re-entrant, which is why the scope is opened at the
 * boundary and never here — every function below assumes it is already inside
 * one and must not nest.
 *
 * EVERY WRITE GOES THROUGH TASK 6. The receipt is created by `createReceipt`
 * and posted by `postReceipt`; nothing here inserts a ledger row, and nothing
 * here can create an item. The screen is a ledger writer, so it uses the
 * ledger's writers and re-implements none of their rules.
 */

/** Why an intake request was refused — a named condition, not a bare `Error`. */
export type IntakeRefusal = 'unauthenticated' | 'forbidden' | 'invalid';

/**
 * A refusal the screen can render, carrying a machine-readable `code` AND a
 * message that names the problem. The code is what the UI switches on; the
 * message is what a developer reads in a log.
 */
export class IntakeError extends Error {
  readonly code: IntakeRefusal;

  constructor(code: IntakeRefusal, message: string) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
  }
}

/**
 * Resolves the caller and asserts they may receive goods — the ONE role gate.
 *
 * Every intake seam calls this and nothing else asks the question, so there is
 * a single place a reviewer has to check and a single place the constraint can
 * drift from. A missing/forged/expired cookie is `unauthenticated`; a live
 * session whose role is not {@link canReceive} is `forbidden`.
 */
export async function requireReceiver(
  db: Queryable,
  cookie: string | undefined | null,
): Promise<CurrentUser> {
  const user = await currentUser(db, cookie);
  if (!user) {
    throw new IntakeError(
      'unauthenticated',
      'Intake: you are not signed in (or the session has ended) — sign in again.',
    );
  }
  if (!canReceive(user.role)) {
    throw new IntakeError(
      'forbidden',
      `Intake is a warehouse function: role "${user.role}" is not permitted to receive goods.`,
    );
  }
  return user;
}

/** What the screen needs to render its door at all. */
export interface FrontDoor {
  /** Who is asking, or `null` when the cookie is not a live session. */
  user: CurrentUser | null;
  /** Whether this person may post a receipt at all (see {@link canReceive}). */
  mayReceive: boolean;
  /** The locations goods may arrive FROM (the tenant's active vendors). */
  sources: Location[];
  /** Where the goods will arrive, auto-filled, or `null` if there is no warehouse. */
  dest: Location | null;
}

/**
 * Everything the page needs, read in ONE pass inside the caller's tenant scope.
 *
 * The page must not open a second `withTenant` for the vendor list, so this
 * answers all four questions over the one connection the boundary already
 * checked out. A visitor who is not signed in — or who may not receive — gets
 * `null`/empty everywhere and NO reads at all: an unauthorised caller learns
 * nothing about the catalogue or the shelf layout.
 */
export async function frontDoor(
  db: Queryable,
  cookie: string | undefined | null,
): Promise<FrontDoor> {
  const user = await currentUser(db, cookie);
  if (!user || !canReceive(user.role)) {
    return { user, mayReceive: false, sources: [], dest: null };
  }

  const [sources, dest] = await Promise.all([vendorLocations(db), findWarehouseLocation(db)]);
  return { user, mayReceive: true, sources, dest };
}

/**
 * Resolves one scanned (or typed) code, exactly as the screen's field does.
 *
 * The lookup is `findByBarcode` over THIS connection, so the tenant scoping is
 * the app's and the normalisation is {@link resolveScan}'s — the same
 * trim-and-upper-case the data layer applies, applied before the lookup rather
 * than relying on it. An unknown code comes back as `{ kind: 'unknown', code }`
 * and is rendered; nothing is created.
 */
export async function scanIn(
  db: Queryable,
  cookie: string | undefined | null,
  code: string,
): Promise<ScanResult> {
  await requireReceiver(db, cookie);
  return resolveScan(code, (normalised) => findByBarcode(db, normalised));
}

/**
 * Surfaces — BEFORE the goods are accepted — an already-posted receipt carrying
 * the same delivery-note number.
 *
 * A person at the door with a lorry needs to know that this note was booked
 * already, while the lorry is still there; being told after the goods are on
 * the rack is too late to ask the driver anything. It is a WARNING, never a
 * refusal: one note can legitimately cover several lorries, so the second
 * delivery still posts (Task 6's rule, honoured rather than re-litigated here).
 */
export async function checkNoteIn(
  db: Queryable,
  cookie: string | undefined | null,
  refNo: string,
): Promise<ReceiptDuplicate | null> {
  await requireReceiver(db, cookie);
  const normalised = typeof refNo === 'string' ? refNo.trim().toUpperCase() : '';
  if (normalised === '') return null;
  // No receipt yet — this IS the pre-check — so there is nothing to exclude.
  return findPostedDuplicate(db, normalised, null);
}

/** What a submit produced: the receipt it wrote, its variances, and any warning. */
export interface SubmitResult {
  /** The receipt this form wrote (stable across retries of the same form). */
  receiptId: string;
  /** The lines whose received quantity differed from the expected one. */
  shortfalls: ReceiptShortfall[];
  /** A delivery note already posted by another receipt in this tenant, if any. */
  duplicateOf: ReceiptDuplicate | null;
}

/**
 * What the SCREEN receives back from the submit action.
 *
 * A server action cannot throw a useful message at a production client — Next
 * masks it — and a refusal the manager must read (a lorry is waiting) is not an
 * exception, it is an answer. So the request boundary catches
 * {@link IntakeError} and hands back this plain, serialisable outcome: `ok`
 * with the receipt's numbers, or a `code` the UI switches on plus a message for
 * the log. It lives here, not in the `'use server'` module, so the client can
 * import the TYPE without pulling server code into its bundle.
 */
export interface SubmitOutcome {
  ok: boolean;
  receiptId: string | null;
  shortfalls: ReceiptShortfall[];
  duplicateOf: ReceiptDuplicate | null;
  error: { code: IntakeRefusal; message: string } | null;
}

/**
 * Posts a delivery: creates the receipt for this FORM and records what arrived.
 *
 * IDEMPOTENT ON THE FORM. `form.formId` — minted by the screen when the form
 * opened — becomes the receipt's id, and a retry of the same form finds that
 * receipt instead of racing a second one into existence. Because a receipt's
 * per-line movements are keyed `receipt:<receiptId>:<variantId>` (Task 6), the
 * retry lands on the SAME movement, and a receipt that is already `posted`
 * returns the numbers it stored rather than posting again. A double-tap or a
 * lost response therefore collapses to one movement, while a genuinely second
 * delivery — a new form, a new id — posts normally.
 *
 * WHAT IS REQUIRED IS REQUIRED HERE. The delivery-note number, the sending
 * party and at least one line with a positive expected quantity are all checked
 * at the moment of entry (rule: the things that matter are required at entry),
 * and the actor (`received_by`) and the time come from the session and the clock
 * — never from the form.
 *
 * ONLY THE LINES THAT ARRIVED ARE POSTED ({@link receivedLines}): a line with
 * no received quantity is left out, its `received_qty` stays NULL, the header
 * stays `receiving` and NO shortfall is reported for it — a delivery arriving
 * in parts must stay expressible.
 */
export async function submitIn(
  db: Queryable,
  cookie: string | undefined | null,
  form: ReceiptForm,
): Promise<SubmitResult> {
  const user = await requireReceiver(db, cookie);

  if (typeof form.formId !== 'string' || form.formId.trim() === '') {
    throw new IntakeError('invalid', 'Intake: the form has no id — reload the screen and try again.');
  }
  const refNo = typeof form.refNo === 'string' ? form.refNo.trim() : '';
  if (refNo === '') {
    throw new IntakeError(
      'invalid',
      'Intake: a delivery-note number is required — it is what the paperwork proves.',
    );
  }
  const sourceLocationId = typeof form.sourceLocationId === 'string' ? form.sourceLocationId.trim() : '';
  if (sourceLocationId === '') {
    throw new IntakeError(
      'invalid',
      'Intake: the sending party (from) is required — a receipt is a transfer, not an arrival from nowhere.',
    );
  }
  if (!Array.isArray(form.lines) || form.lines.length === 0) {
    throw new IntakeError('invalid', 'Intake: a receipt needs at least one line.');
  }
  for (const line of form.lines) {
    if (typeof line.expected !== 'number' || !Number.isFinite(line.expected) || line.expected <= 0) {
      throw new IntakeError(
        'invalid',
        `Intake: the expected quantity for ${line.variantId} must be a number greater than zero.`,
      );
    }
    if (line.received != null && (typeof line.received !== 'number' || !Number.isFinite(line.received) || line.received < 0)) {
      throw new IntakeError(
        'invalid',
        `Intake: the received quantity for ${line.variantId} must be a number, zero or more (leave it empty if it has not arrived).`,
      );
    }
  }

  // "To" is NOT asked for: there is one warehouse, and the system knows it.
  const dest = await findWarehouseLocation(db);
  if (!dest) {
    throw new IntakeError(
      'invalid',
      'Intake: this tenant has no active warehouse location, so there is nowhere to receive into.',
    );
  }

  const receipt = await createReceipt(db, {
    id: form.formId,
    sourceLocationId,
    destLocationId: dest.id,
    refNo,
    lines: form.lines.map((line) => ({ variantId: line.variantId, expectedQty: line.expected })),
  });

  // Already posted by an earlier submit of THIS form: a retry, not a new
  // delivery. Report the numbers the receipt actually stored — the same answer
  // the first call gave — instead of posting the goods a second time (Task 6
  // would refuse it, and a refusal is the wrong answer to a double-tap).
  if (receipt.status === 'posted') {
    return { receiptId: receipt.id, shortfalls: await storedShortfalls(db, receipt.id), duplicateOf: null };
  }

  const posted = await postReceipt(db, receipt.id, receivedLines(form.lines), user.userId);
  return { receiptId: receipt.id, shortfalls: posted.shortfalls, duplicateOf: posted.duplicateOf };
}

/**
 * A posted receipt's variances, read back from what it stored.
 *
 * Used only for the retry path above, so a retry answers with the receipt's OWN
 * numbers (from the generated `variance_qty` the database computed) rather than
 * recomputing them in the app and risking a different answer.
 */
async function storedShortfalls(db: Queryable, receiptId: string): Promise<ReceiptShortfall[]> {
  const { rows } = await db.query<{
    variant_id: string;
    expected_qty: string;
    received_qty: string;
    variance_qty: string;
  }>(
    `select variant_id, expected_qty, received_qty, variance_qty
       from receipt_lines
      where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and receipt_id = $1
        and received_qty is not null
        and variance_qty <> 0
      order by variant_id`,
    [receiptId],
  );

  return rows.map((row) => ({
    variantId: row.variant_id,
    expected: Number(row.expected_qty),
    received: Number(row.received_qty),
    variance: Number(row.variance_qty),
  }));
}
