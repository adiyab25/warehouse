/**
 * Identifier SHAPE — one rule, shared by the route handlers.
 *
 * A dynamic route segment (`/stock/<variantId>`, `/requisitions/<id>`) is
 * whatever text the URL carries: a hand-edited or stale link can hand a handler
 * `not-a-uuid`. Passing that straight into a query that compares it to a `uuid`
 * column makes Postgres reject the cast (`invalid input syntax for type uuid`,
 * SQLSTATE 22P02) — which surfaces as a 500 ("This page couldn't load") instead
 * of the graceful refusal a missing id already gets.
 *
 * Every id the app puts in a URL is a uuid, so the handler checks the SHAPE
 * first and answers with the SAME refusal a missing id gets — one code, no
 * oracle, no crash. This is deliberately a shape check, not a lookup: it runs
 * before any query is sent.
 */

/** The canonical 8-4-4-4-12 uuid form, any version, case-insensitive. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is `value` a well-formed uuid string? */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
/**
 * Text normalisation — ONE rule, agreed by the app AND the database.
 *
 * Arabic is the app's primary language, and it is written with LETTER VARIANTS
 * that ASCII-case-folding cannot see. `normaliseName` therefore folds the
 * variants that make the SAME name look different, instead of the
 * `trim().toUpperCase()` that used to stand here (a no-op on Arabic text, and
 * the reason `احمد علي` — the ordinary spelling, bare alef — was rejected while
 * `أحمد علي` was accepted).
 *
 * What it does, in order:
 *
 *   1. NFKC            — canonical/compatibility composition, so a name typed
 *                        with a combining mark sequence and the same name typed
 *                        precomposed compare equal (and NBSP becomes U+0020).
 *   2. strip TATWEEL   — U+0640, the purely decorative kashida elongation. It
 *                        changes the LOOK of a name and nothing else.
 *   3. fold the alef family — `أ`(U+0623) `إ`(U+0625) `آ`(U+0622) `ٱ`(U+0671)
 *                        → `ا`(U+0627). The bare alef is how the name is typed
 *                        on a keyboard that does not offer the hamza forms.
 *   4. fold `ى`(U+0649) → `ي`(U+064A)   — alef maqsura vs. ya.
 *   5. fold `ة`(U+0629) → `ه`(U+0647)   — ta marbuta vs. ha.
 *   6. collapse ALL Unicode whitespace runs to a single U+0020 and trim.
 *
 * THE DATABASE AGREES. `public.normalise_name(text)` (migration 0012) is the
 * same function in SQL, and `app_users.name_normalised` carries a CHECK that it
 * equals `normalise_name(name)` — so the app and the database cannot drift, and
 * a writer that bypasses this module is refused by the constraint. The SQL is
 * deliberately `translate()`-based rather than a table of `replace()` calls so
 * both languages do the fold in ONE pass in the same order as the steps above.
 *
 * This module is DEPENDENCY-FREE and runs in any runtime (edge, browser, Node).
 */

/** The whitespace-collapsed, variant-folded form of a human-typed name. */
export function normaliseName(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .replace(/\u0640/g, '') // tatweel / kashida
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627') // أ إ آ ٱ → ا
    .replace(/\u0649/g, '\u064A') // ى → ي
    .replace(/\u0629/g, '\u0647') // ة → ه
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The normalised form of an ASSIGNED username: trim + lowercase.
 *
 * A username is machine-typed (issued as `owner1`, `sara.zaki`) and is matched
 * EXACTLY, so its normalisation is deliberately the boring ASCII one — and it is
 * the ONE identifier the lockout counts against. The database agrees:
 * `app_users.username` carries `check (username = lower(btrim(username)) and
 * username ~ '^[a-z0-9][a-z0-9._-]{2,31}$')`.
 */
export function normaliseUsername(raw: string): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * The charset an assigned username must satisfy — the SAME regex the
 * `app_users_username_charset_check` constraint enforces. Starts
 * alphanumeric so a username is always a valid HTML id/fragment and never a
 * hidden file or a shell flag, and length-bounded so it fits a printout.
 */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** Is `raw` a username that is already in stored form? */
export function isStoredUsername(raw: unknown): boolean {
  return typeof raw === 'string' && normaliseUsername(raw) === raw && USERNAME_PATTERN.test(raw);
}
