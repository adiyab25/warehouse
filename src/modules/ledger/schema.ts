/**
 * Movement rules — pure functions, no database.
 *
 * A movement is the atom of the whole backbone: every number the app shows is
 * derived from rows of `stock_movements`. These helpers are the rules that a
 * movement is judged against BEFORE it is written, so a malformed one never
 * reaches the ledger:
 *
 *   - the `reason` must be one of the closed set the database also enforces;
 *   - the quantity must be positive, and a whole number for a discrete item
 *     (you cannot hold half a dress), while a measured one may carry up to
 *     three decimal places — matching `numeric(12, 3)`;
 *   - a movement must touch at least one location, and never the SAME one on
 *     both sides.
 *
 * The database carries the matching CHECKs; this is the layer that turns them
 * into a named field and a readable message before a round-trip.
 */

/**
 * The closed list of movement reasons. Kept in lockstep with the
 * `stock_movements_reason_check` CHECK in 0005 — the database is the last line,
 * this is the first one. Nothing mutates it.
 */
export const MOVEMENT_REASONS = [
  'receipt',
  'issue_to_branch',
  'transfer',
  'return_from_branch',
  'consumption',
  'sale',
  'count_correction',
  'write_off',
  'opening_balance',
] as const satisfies readonly string[];

/** One of the closed reasons a movement may carry. */
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

/**
 * The i18n key for each movement reason — the ONE place a raw enum value becomes
 * a translated label.
 *
 * The reason list is a CLOSED, TRANSLATED CONTRACT: every reason the database
 * accepts (`MOVEMENT_REASONS`, mirrored by `stock_movements_reason_check`) has
 * its own Arabic AND English string, and a raw enum value (`issue_to_branch`)
 * must NEVER reach a screen. Typing the record `Record<MovementReason, string>`
 * makes TypeScript refuse a MISSING reason at compile time; the domain test
 * ('every movement reason has an Arabic and English label') refuses one that is
 * added to the list without a dictionary entry at run time, so adding a reason
 * in the migration can never silently render its raw value.
 */
export const REASON_MESSAGE_KEYS: Record<MovementReason, string> = {
  receipt: 'stock.reason.receipt',
  issue_to_branch: 'stock.reason.issue_to_branch',
  transfer: 'stock.reason.transfer',
  return_from_branch: 'stock.reason.return_from_branch',
  consumption: 'stock.reason.consumption',
  sale: 'stock.reason.sale',
  count_correction: 'stock.reason.count_correction',
  write_off: 'stock.reason.write_off',
  opening_balance: 'stock.reason.opening_balance',
};

/**
 * A candidate movement handed to {@link validateMovement}.
 *
 * `reason` is typed as a plain `string` (not {@link MovementReason}) on purpose:
 * validation exists to REJECT a value outside the list, which is only meaningful
 * if the bad value is representable. Everything else is optional, so a caller
 * can validate a partly-filled form and be told the first field that is wrong.
 */
export interface MovementInput {
  reason: string;
  /** The magnitude of the move. Always positive; direction is from/to. */
  qty?: number;
  /**
   * Whether the item is counted in whole units. Defaults to `true` — that is
   * right for kids-wear and paper, and makes a fraction an error unless the
   * caller has explicitly said the item is measured.
   */
  discrete?: boolean;
  fromLocationId?: string | null;
  toLocationId?: string | null;
}

/** The result of {@link validateMovement}: success, or the field at fault. */
export type MovementValidation =
  | { ok: true }
  | { ok: false; field: string; message: string };

/** How many decimal places a non-discrete quantity may carry (`numeric(12,3)`). */
const MAX_QTY_DECIMALS = 3;

/**
 * Judges a candidate movement against the rules above.
 *
 * Returns `{ ok: true }` when it may be written, otherwise
 * `{ ok: false, field, message }` naming the offending field (`'reason'` or
 * `'quantity'`, or a location field) and the value, so a caller can surface it
 * without parsing an error string.
 *
 * Checks run in a fixed order — reason, then quantity, then locations — so the
 * SAME bad input always reports the SAME field.
 */
export function validateMovement(input: MovementInput): MovementValidation {
  if (!(MOVEMENT_REASONS as readonly string[]).includes(input.reason)) {
    return {
      ok: false,
      field: 'reason',
      message: `reason ${JSON.stringify(input.reason)} is not one of: ${MOVEMENT_REASONS.join(', ')}`,
    };
  }

  const qty = input.qty;
  if (typeof qty !== 'number' || !Number.isFinite(qty)) {
    return {
      ok: false,
      field: 'quantity',
      message: `quantity ${JSON.stringify(qty)} must be a finite number`,
    };
  }
  if (qty <= 0) {
    return {
      ok: false,
      field: 'quantity',
      message: `quantity ${qty} must be greater than zero`,
    };
  }
  if ((input.discrete ?? true) && !Number.isInteger(qty)) {
    return {
      ok: false,
      field: 'quantity',
      message: `quantity ${qty} is not a whole number, but the item is discrete (counted in whole units)`,
    };
  }
  const scaled = qty * 10 ** MAX_QTY_DECIMALS;
  if (!(input.discrete ?? true) && Math.abs(Math.round(scaled) - scaled) > 1e-9) {
    return {
      ok: false,
      field: 'quantity',
      message: `quantity ${qty} carries more than ${MAX_QTY_DECIMALS} decimal places`,
    };
  }

  const from = input.fromLocationId ?? null;
  const to = input.toLocationId ?? null;
  if (from === null && to === null) {
    return {
      ok: false,
      field: 'toLocationId',
      message: 'a movement must name a from location or a to location',
    };
  }
  if (from !== null && to !== null && from === to) {
    return {
      ok: false,
      field: 'toLocationId',
      message: `the from and to locations are both ${from}, but they must differ`,
    };
  }

  return { ok: true };
}

/**
 * The signed contribution of one movement to one location's on-hand quantity:
 * `+qty` where the movement arrives, `-qty` where it leaves.
 *
 * For a transfer (both sides set) this is `+qty` when asked about the
 * destination and `-qty` about the source — one function, so a reader derives
 * both sides the same way `on_hand` does. A location the movement does not
 * touch contributes 0.
 */
export function signedDelta(m: {
  qty: number;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  locationId: string;
}): number {
  let delta = 0;
  if (m.toLocationId != null && m.toLocationId === m.locationId) delta += m.qty;
  if (m.fromLocationId != null && m.fromLocationId === m.locationId) delta -= m.qty;
  return delta;
}
