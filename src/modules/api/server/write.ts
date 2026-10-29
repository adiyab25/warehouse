import { getAppPool } from '@/modules/platform/index';
import { withTenant, type Queryable } from '@/modules/platform/index';
import { requireScope } from './auth.ts';
import { ApiError, errorResponse, invalidParameter, jsonResponse } from '../domain/errors.ts';

/**
 * THE ONE SHARED PATH for every WRITE route, next to `readRoute`:
 *   bearer → `write` scope → Idempotency-Key header → Content-Type → size cap →
 *   JSON object → ONE `withTenant` (tenant from the TOKEN only) → run → error map.
 * A write route is a thin adapter `(ctx) => {status, body}`; it cannot forget a
 * check. A thrown ApiError inside `run` rolls the whole transaction back.
 *
 * SERVER-ONLY (reaches `pg`).
 */
export const MAX_BODY_BYTES = 16 * 1024;

/** 8–128 chars of a URL/log-safe alphabet; stored namespaced by the client. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export type WriteContext = {
  db: Queryable;
  /** A parsed JSON OBJECT (never null/array/scalar). Keys are NOT yet checked. */
  body: Record<string, unknown>;
  /** The authenticated client — the ONLY actor a write may carry. */
  clientId: string;
  tenantId: string;
  /** The raw, validated `Idempotency-Key` header value (not yet namespaced). */
  idempotencyKey: string;
};

export type WriteResult = { status: number; body: unknown };
export type WriteRunner = (ctx: WriteContext) => Promise<WriteResult>;

async function readCapped(req: Request): Promise<string> {
  const declared = req.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    throw tooLarge();
  }
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

const tooLarge = (): ApiError =>
  new ApiError(413, 'payload_too_large', `Request body must be at most ${MAX_BODY_BYTES} bytes`);

export function writeRoute(run: WriteRunner) {
  return async function POST(req: Request): Promise<Response> {
    try {
      const { clientId, tenantId } = await requireScope(req, 'write');

      const key = req.headers.get('idempotency-key');
      if (key === null || !IDEMPOTENCY_KEY.test(key)) {
        throw invalidParameter('Idempotency-Key', 'required header, 8-128 characters of A-Z a-z 0-9 . _ : -');
      }

      const ct = req.headers.get('content-type') ?? '';
      if (!/^application\/json\s*(;\s*charset=("?)utf-8\2\s*)?$/i.test(ct)) {
        throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
      }

      let text: string;
      try {
        text = await readCapped(req);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(400, 'invalid_parameter', 'Request body is not valid UTF-8 JSON');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ApiError(400, 'invalid_parameter', 'Request body is not valid JSON');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ApiError(400, 'invalid_parameter', 'Request body must be a JSON object');
      }
      const body = parsed as Record<string, unknown>;

      const pool = await getAppPool();
      const out = await withTenant(pool, tenantId, (db) =>
        run({ db, body, clientId, tenantId, idempotencyKey: key }),
      );
      return jsonResponse(out.body, out.status);
    } catch (e) {
      return errorResponse(e, req);
    }
  };
}
