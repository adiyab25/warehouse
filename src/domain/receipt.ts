/**
 * Receipt rules — pure functions, no database.
 *
 * A receipt is what the warehouse manager books when goods arrive against a
 * delivery note. The system records what was EXPECTED and what actually
 * ARRIVED, and reports the difference rather than absorbing it: a delivery that
 * is short must surface as a number, not quietly become the new truth.
 *
 * Consumables are bought by the CARTON and issued as singles, so a quantity a
 * person types while receiving is often in purchase packs rather than base
 * units. {@link packToUnits} is the ONE place that conversion happens, and it is
 * used ONLY at receiving — the ledger always holds base units, so nothing
 * downstream has to know what a "carton" is.
 */

/**
 * Converts a quantity entered in PURCHASE PACKS into base units.
 *
 * An item carries an optional `pack_factor` — how many base units are in one
 * pack (e.g. 24 shirts to a carton). Entering `2` packs of a pack_factor-24
 * item posts 48 units. An item with no pack factor (`null`) is bought and held
 * one-for-one, so the entered number IS the base-unit count.
 */
export function packToUnits(qtyEntered: number, packFactor: number | null): number {
  return packFactor != null ? qtyEntered * packFactor : qtyEntered;
}

/**
 * The signed difference between what arrived and what was expected:
 * `received - expected`.
 *
 * Negative is a shortfall (the delivery note said 40, 36 arrived ⇒ `-4`),
 * positive an over-delivery (`44 - 40 = +4`), zero an exact match. This mirrors
 * the database's generated `receipt_lines.variance_qty` exactly, so the number
 * the app reports before writing and the number stored afterwards can never
 * disagree.
 */
export function lineVariance(expected: number, received: number): number {
  return received - expected;
}
