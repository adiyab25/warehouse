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
