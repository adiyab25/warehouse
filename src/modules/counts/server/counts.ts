import type { Queryable } from '@/modules/platform/index';
import { lockStockPair, postMovement } from '@/modules/ledger/index';
import type { CountLine, CountSession } from '@/modules/platform/index';

// Re-export the GENERATED row types rather than hand-declaring copies. The
// migration is the source of truth, `src/db/types.ts` is generated from it, and
// a hand copy here would drift: add a column, regenerate, and `types.ts` gains
// it while this file's copy (the actual return type) does not — both still
// typecheck. Import + re-export makes drift impossible.
export type { CountSession, CountLine };
/** The status union the migration's CHECK owns, derived from the generated type. */
export type CountSessionStatus = CountSession['status'];

/** The input {@link openCount} accepts; `db` supplies the tenant. */
export interface OpenCountInput {
  /** The location whose shelf is being counted. */
  locationId: string;
  /** Who is starting the count. REQUIRED, and written to `started_by`. */
  startedBy: string;
}

/** One counted line handed to {@link recordCount}. */
export interface CountedLine {
  variantId: string;
  countedQty: number;
}

/** The one place `app.tenant_id` is read for a write, so it is written once. */
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/** The ledger `ref_type` every count correction carries. */
export const COUNT_REF_TYPE = 'COUNT';

/**
 * Throws unless `value` is a non-empty string — the actor and the count quantity
 * are validated before anything is written, the same discipline every other
 * writer applies.
 */
function requireNonEmpty(value: unknown, field: string, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context}: ${field} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Throws unless `value` is a finite number. A counted quantity MAY be zero (a
 * shelf deliberately counted as empty) but not negative or non-numeric.
 */
function requireFiniteQty(value: unknown, field: string, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context}: ${field} ${JSON.stringify(value)} must be a finite number`);
  }
  return value;
}

/** Rounds to the 3 decimals `numeric(12, 3)` stores, so a decimal chain cannot drift. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The stable per-line idempotency key a close posts under. No timestamps. */
function countCorrectionKey(sessionId: string, variantId: string): string {
  return `count:${sessionId}:${variantId}`;
}

/**
 * Opens a count session for ONE location and FREEZES what the system expects
 * there right now.
 *
 * Every variant that currently has stock at `locationId` (read from the
 * `on_hand` view — an ABSENT row means zero, so only rows that exist are
 * snapshotted, and a pair that nets to zero is not stock and is skipped) gets a
 * `count_lines` row carrying that on-hand as `expected_qty`, with `counted_qty`
 * left NULL. Because that number is snapshotted NOW, a movement posted while the
 * sheets are out (a sale, an issue, a return) does NOT move the target the
 * counter is measured against — a moving goalpost would make every variance a
 * fiction.
 *
 * `startedBy` is REQUIRED and written to `started_by`, so the count is
 * attributable from the moment it opens.
 *
 * ATOMICITY: this writes the header AND its lines, so it is NOT atomic on its
 * own — it requires the caller's tenant-scoped transaction (`withTenant`),
 * exactly as createReceipt / issue / postReturn do. A failure mid-snapshot rolls
 * the whole session back, leaving no orphan header. Call it with the scoped `db`
 * from inside `withTenant`; never nest `withTenant`.
 *
 * The tenant is NOT a parameter: it is read from `app.tenant_id`, which
 * `withTenant` pinned, so a caller cannot open a count for a tenant it is not
 * scoped to.
 */
export async function openCount(db: Queryable, input: OpenCountInput): Promise<CountSession> {
  requireNonEmpty(input.startedBy, 'startedBy', 'openCount');

  const { rows } = await db.query<CountSession>(
    `insert into count_sessions (tenant_id, location_id, started_by)
     values (${TENANT}, $1, $2)
     returning *`,
    [input.locationId, input.startedBy],
  );
  const session = rows[0];
  if (!session) {
    throw new Error(`openCount: no session row returned for location ${input.locationId}`);
  }

  // Snapshot the expected quantity for EVERY variant that currently has stock at
  // this location. `on_hand` has no row for a pair that never appears in the
  // ledger, so the set of lines is defined by the rows that exist; a pair whose
  // movements net to exactly zero is not stock and is skipped.
  await db.query(
    `insert into count_lines (tenant_id, count_session_id, variant_id, expected_qty)
     select ${TENANT}, $1, oh.variant_id, oh.qty
       from on_hand oh
      where oh.location_id = $2
        and oh.qty <> 0`,
    [session.id, input.locationId],
  );

  return session;
}

/**
 * Records counted quantities against an OPEN session.
 *
 * Callable more than once while the session is open — a shelf counted in the
 * morning and again after lunch — and each line is an UPSERT on
 * `(tenant_id, count_session_id, variant_id)`: a variant already on the sheet
 * has its `counted_qty` REPLACED (the later count wins), while a variant NOT yet
 * on the sheet is ADDED with its `expected_qty` snapshotted at THAT moment
 * (current on-hand; absence means zero). Either way the target is frozen once a
 * line exists, so the morning's expectation is not silently rewritten by the
 * afternoon's movements.
 *
 * A CLOSED session is refused, naming the state: a posted count is frozen and
 * must not be edited — a correcting count is the way to change it.
 *
 * Quantities are validated here (finite; zero allowed, negative refused) so a
 * bad number never reaches the table. The `(tenant_id, variant_id)` composite FK
 * refuses a variant of ANOTHER tenant, so a count cannot be recorded against
 * another tenant's item.
 *
 * ATOMICITY: this writes only `count_lines` rows, so it requires the caller's
 * tenant-scoped transaction all the same (it reads the header and the current
 * on-hand through the same `db`). Call it with the scoped `db` from inside
 * `withTenant`; never nest `withTenant`.
 */
export async function recordCount(
  db: Queryable,
  sessionId: string,
  lines: CountedLine[],
): Promise<{ recorded: number }> {
  // Lock the header for the life of the transaction so two concurrent recorders
  // serialise on it, and a close cannot race a final count into a closed sheet.
  const { rows: headerRows } = await db.query<CountSession>(
    `select * from count_sessions where id = $1 for update`,
    [sessionId],
  );
  const session = headerRows[0];
  if (!session) {
    throw new Error(`recordCount: count session ${sessionId} was not found for this tenant`);
  }
  if (session.status !== 'open') {
    throw new Error(
      `recordCount: count session ${sessionId} cannot be recorded — its status is '${session.status}' (only an 'open' session can be counted; a closed count is frozen)`,
    );
  }

  for (const line of lines) {
    const countedQty = requireFiniteQty(
      line.countedQty,
      'countedQty',
      `recordCount (variant ${line.variantId})`,
    );
    if (countedQty < 0) {
      throw new Error(
        `recordCount: countedQty ${countedQty} for variant ${line.variantId} must not be negative`,
      );
    }

    // Upsert: replace the count where a line already exists; otherwise ADD it
    // with the on-hand snapshotted at THIS instant (absence means zero). The
    // expected quantity is only ever set on INSERT, never on the update, so a
    // line already on the sheet keeps the target it was opened against.
    await db.query(
      `insert into count_lines (tenant_id, count_session_id, variant_id, expected_qty, counted_qty)
       values (
         ${TENANT}, $1, $2,
         coalesce((select qty from on_hand where variant_id = $2 and location_id = $3), 0),
         $4
       )
       on conflict (tenant_id, count_session_id, variant_id)
       do update set counted_qty = excluded.counted_qty`,
      [sessionId, line.variantId, session.location_id, countedQty],
    );
  }

  return { recorded: lines.length };
}

/**
 * Closes a count session and RECONCILES the ledger to the shelf.
 *
 * THE ADJUSTMENT IS A RECONCILIATION, NOT THE SHEET'S DRIFT. For every line
 * that was COUNTED this posts — where needed — ONE ledger movement with reason
 * `count_correction`, through {@link postMovement} (the one gate that validates
 * quantity, reason and locations and derives discreteness from the item) —
 * never a raw insert. The POSTED amount is
 * `counted − the on-hand at the MOMENT OF CLOSING` (read inside this
 * transaction and AFTER the pair's lock, so a concurrent issue or return cannot
 * interleave), NOT the line's generated `variance_qty`.
 *
 * WHY THE DISTINCTION IS LOAD-BEARING: `variance_qty` is
 * `coalesce(counted_qty, 0) - expected_qty`, and `expected_qty` was FROZEN when
 * the line was created — so a movement that lands while the sheets are out (a
 * sale, an issue, a return, a transfer) is invisible to it. Reconciling against
 * that frozen number would reconcile the shelf to the SHEET, not to the ledger,
 * and leave the ledger wrong:
 *
 *   issue 20 mid-count, counted 75: expected was 100, sheet drift is −25, but
 *   the ledger already stands at 80 — the honest correction is 75 − 80 = −5,
 *   taking the ledger to exactly 75 (the frozen formula would take it to 55);
 *
 *   return 30 mid-count, counted 90: expected was 50, sheet drift is +40, but
 *   the ledger already stands at 80 — the honest correction is 90 − 80 = +10,
 *   taking the ledger to exactly 90 (the frozen formula would take it to 120).
 *
 * The frozen `expected_qty` and the generated `variance_qty` are KEPT — they are
 * the DRIFT report ("what changed since this sheet was started"), which is
 * exactly the fact an operator needs to see; they are simply not the posted
 * amount. The posted amount is the reconciliation to the shelf.
 *
 * A correction is legitimately ONE-SIDED, exactly as before: a SHORTAGE (the
 * ledger holds MORE than was counted) is `from_location_id = the counted
 * location` with NO destination, and a SURPLUS (the ledger holds LESS than was
 * counted) is `to_location_id = the counted location` with NO source. Both
 * sides are never the same location (the ledger refuses from == to). The
 * movement carries `ref_type = 'COUNT'`, `ref_id` = the session, a human-readable
 * `notes` describing the reconciliation, and the STABLE per-line key
 * `count:<sessionId>:<variantId>` (no timestamps), so a retried close cannot
 * double-post — and the closing user is written to the movement's actor. There is
 * deliberately NO generated column for the posted amount: a generated column
 * cannot read the ledger, so the movement row itself is the record.
 *
 * AN UNCOUNTED LINE POSTS NOTHING, AND IS NOT A WRITE-OFF. A line whose
 * `counted_qty` is NULL means the shelf was never counted — deliberately
 * distinct from a counted zero. `variance_qty` is `coalesce(counted_qty, 0) -
 * expected_qty`, which would read `-expected_qty` for a NULL line and look like
 * a full loss; this function therefore filters on `counted_qty is not null`
 * BEFORE computing anything, so an uncounted line produces NO movement and the
 * location's on-hand is left exactly as it was. Inventing a write-off for stock
 * nobody looked at is the worst thing a stocktake can do.
 *
 * IT REPORTS HOW MANY MOVEMENTS TOUCHED THE COUNTED PAIRS during the count, so
 * the operator learns the shelf moved under them — `movementsDuringCount`. A
 * non-zero figure is the signal that the `variance_qty` on the sheet and the
 * posted adjustment legitimately DIFFER, and why: stock moved between
 * `started_at` and the close. Zero means the sheet's drift and the posted
 * correction agree, which is the only case where they can be read as the same
 * number.
 *
 * CLOSING TWICE IS REFUSED, naming the state: the session is locked `for
 * update`, and a session that is already `closed` throws rather than re-posting
 * (the frozen `closed` terminal in the migration refuses a raw reopen too).
 *
 * ATOMICITY + LOCKING: this posts MANY movements AND stamps the header, so it is
 * NOT atomic on its own — it requires the caller's tenant-scoped transaction
 * (exactly as createReceipt / issue / postReturn do). A line that fails rolls
 * the whole close back, leaving the session `open` and every movement unposted.
 * Because a correction CHANGES balances, the SAME advisory lock every guarded
 * writer uses is taken before EACH reconciliation read AND its post —
 * {@link lockStockPair} on the (variant, location) pair — so a concurrent issue
 * or return on the same pair cannot interleave between the balance read and the
 * movement that corrects it (a read of the balance and then a post against it is
 * a lost-update race otherwise). Call it with the scoped `db` from inside
 * `withTenant`; never nest `withTenant`.
 */
export async function closeCount(
  db: Queryable,
  sessionId: string,
  closedBy: string,
): Promise<{ adjustments: number; movementsDuringCount: number }> {
  requireNonEmpty(closedBy, 'closedBy', 'closeCount');

  // Lock the header so two concurrent closes serialise on it and the second sees
  // the first's `closed`.
  const { rows: headerRows } = await db.query<CountSession>(
    `select * from count_sessions where id = $1 for update`,
    [sessionId],
  );
  const session = headerRows[0];
  if (!session) {
    throw new Error(`closeCount: count session ${sessionId} was not found for this tenant`);
  }
  if (session.status !== 'open') {
    throw new Error(
      `closeCount: count session ${sessionId} cannot be closed — its status is '${session.status}' (a closed count is terminal)`,
    );
  }

  // Only COUNTED lines (counted_qty is not null) can produce a reconciliation.
  // The `counted_qty is not null` guard is load-bearing: an uncounted line was
  // never looked at, and its generated variance would read `-expected_qty` and
  // post a phantom write-off. `variance_qty` is deliberately NOT selected — the
  // posted amount is derived from the LIVE ledger below, not from the frozen
  // sheet.
  const { rows: lineRows } = await db.query<{
    variant_id: string;
    counted_qty: string;
  }>(
    `select variant_id, counted_qty
       from count_lines
      where tenant_id = ${TENANT}
        and count_session_id = $1
        and counted_qty is not null
      order by variant_id`,
    [sessionId],
  );

  let adjustments = 0;
  for (const line of lineRows) {
    const countedQty = round3(Number(line.counted_qty));

    // Serialise with every other guarded writer on this (variant, location)
    // pair BEFORE reading the balance AND before posting: a concurrent issue or
    // return must not slip between the read and the correction.
    await lockStockPair(db, line.variant_id, session.location_id);

    // The LIVE on-hand for this pair, read inside this transaction and AFTER the
    // lock. Absence of a row means zero — a pair that never appears in the
    // ledger is not stock.
    const { rows: onHandRows } = await db.query<{ qty: string }>(
      `select coalesce(
                (select qty from on_hand where variant_id = $1 and location_id = $2),
                0
              ) as qty`,
      [line.variant_id, session.location_id],
    );
    const onHandNow = round3(Number(onHandRows[0]?.qty ?? 0));

    // The RECONCILIATION: take the ledger to what the shelf actually holds. A
    // zero adjustment needs no movement — the ledger already agrees.
    const adjustment = round3(countedQty - onHandNow);
    if (adjustment === 0) continue;

    // A shortage removes from the location (from only, no destination); a
    // surplus arrives at it (to only, no source). Never both sides the same.
    const shortage = adjustment < 0;
    await postMovement(db, {
      variantId: line.variant_id,
      qty: Math.abs(adjustment),
      reason: 'count_correction',
      fromLocationId: shortage ? session.location_id : null,
      toLocationId: shortage ? null : session.location_id,
      actorUserId: closedBy,
      refType: COUNT_REF_TYPE,
      refId: sessionId,
      idempotencyKey: countCorrectionKey(sessionId, line.variant_id),
      notes: `stocktake reconciliation: counted ${countedQty}, ledger on-hand at close ${onHandNow}`,
    });
    adjustments += 1;
  }

  // HOW THE SHELF MOVED UNDER THE COUNTER: movements on the SAME (variant,
  // location) pairs this session covers, posted between `started_at` and now.
  // This session's OWN corrections are excluded — they are the reconciliation,
  // not a shelf movement — so a run that posts nothing still reports nothing.
  const { rows: movedRows } = await db.query<{ n: number }>(
    `select count(*)::int as n
       from stock_movements m
      where m.tenant_id = ${TENANT}
        and m.occurred_at >= $2
        and m.occurred_at <= now()
        and (m.from_location_id = $3 or m.to_location_id = $3)
        and exists (
          select 1 from count_lines cl
           where cl.tenant_id = m.tenant_id
             and cl.count_session_id = $1
             and cl.variant_id = m.variant_id
        )
        and not (m.reason = 'count_correction' and m.ref_id = $1)`,
    [sessionId, session.started_at, session.location_id],
  );
  const movementsDuringCount = movedRows[0]?.n ?? 0;

  // Advance the header LAST, so a failure above rolls the whole close back and
  // leaves the session `open` with every movement unposted.
  await db.query(
    `update count_sessions
        set status = 'closed', closed_by = $2, closed_at = now()
      where id = $1 and tenant_id = ${TENANT}`,
    [sessionId, closedBy],
  );

  return { adjustments, movementsDuringCount };
}
