/**
 * Human-typed and scanned-code helpers — pure functions, no database.
 *
 * A code reaches the app exactly as a person left it: padded with spaces,
 * lower-cased, or mistyped. Two things follow from that, and both matter:
 *
 *   1. Anything the app writes is CANONICALISED first — trimmed and
 *      upper-cased — so a code cannot be stored in several spellings. The
 *      database enforces the same rule with a CHECK (see 0004), and the
 *      per-tenant unique indexes are only case- and whitespace-sensitive, so a
 *      missed normalisation would silently split one product across rows.
 *   2. Anything that comes BACK from a scan is normalised before it is trusted,
 *      so `'  ab-0012 '` and `'AB-0012'` are the same code to a lookup.
 *
 * {@link isValidScannedCode} judges the NORMALISED form, so a valid code that
 * merely arrived lower-cased or padded is accepted, while a genuinely malformed
 * one is rejected BEFORE any database lookup — the unknown-code path must never
 * mint a new item.
 */

/**
 * The canonical form of a code: trimmed and upper-cased. Everything stored or
 * looked up goes through here first.
 */
export function normaliseScannedCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Whether `raw` is a well-formed scannable code once normalised.
 *
 * A code is one or more hyphen-separated runs of letters and digits — the
 * `PREFIX-SEQ` shape {@link formatSku} produces, e.g. `AB-0012`. Blank input,
 * a bare token with no sequence part (`x`), and anything carrying an embedded
 * space (`AB 0012`) are all rejected, so a mistyped scan never reaches a
 * lookup.
 */
export function isValidScannedCode(raw: string): boolean {
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(normaliseScannedCode(raw));
}

/**
 * Formats a sequence into a stable code: `formatSku('KG', 12)` → `'KG-0012'`.
 *
 * The sequence is zero-padded to a fixed width so codes sort in numeric order
 * and stay the same width as a person reads them. The prefix is upper-cased
 * like every other code; a sequence longer than the width is not truncated.
 */
export function formatSku(prefix: string, seq: number): string {
  return `${prefix.trim().toUpperCase()}-${String(seq).padStart(4, '0')}`;
}
