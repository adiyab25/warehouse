/**
 * The read API's error contract and response builder.
 *
 * SERVER-ONLY by convention: nothing under `src/api/` may be imported by a client
 * component (`auth.ts` and `read.ts` reach `pg`). This file itself is pure.
 *
 * EVERY failure is `{ error: { code, message } }` with a stable `code`:
 *   400 invalid_parameter · 401 unauthorized · 403 forbidden · 404 not_found
 *   405 method_not_allowed · 500 internal
 * An unexpected exception becomes a GENERIC 500 — never a stack, SQL text or id.
 *
 * There are NO CORS headers anywhere: this is a server-to-server API.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra response headers (e.g. `Allow` on a 405). */
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** Headers on every API response. */
const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

/** A JSON response with the API's standard headers. */
export function jsonResponse(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...extra } });
}

/** Maps ANY thrown value to the stable error body. Unknown throwables are a generic 500. */
export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return jsonResponse({ error: { code: e.code, message: e.message } }, e.status, e.headers);
  }
  return jsonResponse({ error: { code: 'internal', message: 'Internal server error' } }, 500);
}

export const invalidParameter = (field: string, why: string): ApiError =>
  new ApiError(400, 'invalid_parameter', `Invalid parameter "${field}": ${why}`);
