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
import { randomUUID } from 'node:crypto';

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
export const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

/** A JSON response with the API's standard headers. */
export function jsonResponse(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...extra } });
}

/**
 * Removes anything secret-shaped from an error message before it is logged:
 * URLs (a connection string), host:port pairs, quoted user/role names and any
 * long token-like run of base64url characters.
 */
export function scrubMessage(m: string): string {
  return m
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g, '[addr]')
    .replace(/\b(user|role|password|database)\s+"[^"]*"/gi, '$1 "[x]"')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

/**
 * Maps ANY thrown value to the stable error body. Unknown throwables are a
 * generic 500 for the client, and ONE line goes to the server log: a short id
 * (also returned as `x-request-id`), method, path (no query string), error name,
 * code and a scrubbed message. Never headers, token, query values or a URL.
 */
export function errorResponse(e: unknown, req?: Request): Response {
  if (e instanceof ApiError) {
    return jsonResponse({ error: { code: e.code, message: e.message } }, e.status, e.headers);
  }
  const id = randomUUID().slice(0, 8);
  let route = '-';
  try {
    if (req) route = `${req.method} ${new URL(req.url).pathname}`;
  } catch {
    /* an unparsable URL just logs '-' */
  }
  const err = e as { name?: unknown; code?: unknown; message?: unknown } | null;
  const name = typeof err?.name === 'string' ? err.name : typeof e;
  const code = typeof err?.code === 'string' ? ` code=${err.code.slice(0, 16)}` : '';
  const msg = scrubMessage(typeof err?.message === 'string' ? err.message : '');
  console.error(`[api] ${new Date().toISOString()} 500 id=${id} ${route} ${name}${code} msg="${msg}"`);
  return jsonResponse({ error: { code: 'internal', message: 'Internal server error' } }, 500, { 'x-request-id': id });
}

export const invalidParameter = (field: string, why: string): ApiError =>
  new ApiError(400, 'invalid_parameter', `Invalid parameter "${field}": ${why}`);
