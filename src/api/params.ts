import { invalidParameter } from './errors.ts';

/**
 * Query-string parsing for the read API. PURE (no pg): every malformed value is a
 * 400 `invalid_parameter` naming the field, so a bad uuid can never reach
 * Postgres and surface as a 22P02 500. A repeated parameter is refused.
 */

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The single value of `name`, `undefined` if absent; a duplicate is a 400. */
function single(q: URLSearchParams, name: string): string | undefined {
  const all = q.getAll(name);
  if (all.length === 0) return undefined;
  if (all.length > 1) throw invalidParameter(name, 'given more than once');
  return all[0];
}

export function optUuid(q: URLSearchParams, name: string): string | undefined {
  const v = single(q, name);
  if (v === undefined) return undefined;
  if (!UUID.test(v)) throw invalidParameter(name, 'must be a uuid');
  return v.toLowerCase();
}

export function optEnum<T extends string>(q: URLSearchParams, name: string, allowed: readonly T[]): T | undefined {
  const v = single(q, name);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw invalidParameter(name, `must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}

/** A free-text filter (e.g. sku): trimmed, non-empty, bounded. */
export function optText(q: URLSearchParams, name: string, max = 64): string | undefined {
  const v = single(q, name);
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === '' || t.length > max || t.includes('\u0000')) {
    throw invalidParameter(name, `must be 1-${max} characters`);
  }
  return t;
}

/** `limit`: an integer in 1..{@link MAX_LIMIT}; default {@link DEFAULT_LIMIT}. */
export function parseLimit(q: URLSearchParams): number {
  const v = single(q, 'limit');
  if (v === undefined) return DEFAULT_LIMIT;
  if (!/^[0-9]{1,6}$/.test(v)) throw invalidParameter('limit', 'must be a positive integer');
  const n = Number(v);
  if (n < 1 || n > MAX_LIMIT) throw invalidParameter('limit', `must be between 1 and ${MAX_LIMIT}`);
  return n;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** A date (`2026-03-01`, read as UTC midnight) or an RFC 3339 instant; returns a UTC ISO string. */
export function optInstant(q: URLSearchParams, name: string): string | undefined {
  const v = single(q, name);
  if (v === undefined) return undefined;
  const m = DATE_RE.exec(v);
  if (!m) throw invalidParameter(name, 'must be YYYY-MM-DD or an ISO-8601 instant with a timezone');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw invalidParameter(name, 'is not a real calendar date');
  }
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(t)) throw invalidParameter(name, 'is not a valid instant');
  return new Date(t).toISOString();
}

export type CursorKind = 'uuid' | 'seq' | 'text' | 'ts';
const SEQ = /^[0-9]{1,18}$/;
const TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?([+-])(\d{2})(?::?(\d{2}))?$/;
const SEQ_MAX = 9223372036854775807n;

/** A real Postgres-printed timestamptz: real calendar date (year 1..9999), real clock, offset within +-15:59. */
function isRealTimestamp(v: string): boolean {
  const m = TS.exec(v);
  if (!m) return false;
  const n = (i: number): number => Number(m[i] ?? '0');
  const [y, mo, d, h, mi, sec, oh, om] = [n(1), n(2), n(3), n(4), n(5), n(6), n(9), n(10)];
  if (y < 1 || y > 9999) return false;
  const probe = new Date(0);
  probe.setUTCFullYear(y, mo - 1, d); // setUTCFullYear: no two-digit-year remapping
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return false;
  if (h > 23 || mi > 59 || sec > 59) return false;
  return oh <= 15 && om <= 59;
}

/** Opaque cursor: base64url of a JSON object. Clients must treat it as an opaque string. */
export function encodeCursor(o: Record<string, string>): string {
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
}

/** Decodes and VALIDATES `cursor` against `spec`; any deviation is a 400 naming `cursor`. */
export function parseCursor<K extends string>(
  q: URLSearchParams,
  spec: Record<K, CursorKind>,
): Record<K, string> | undefined {
  const raw = single(q, 'cursor');
  if (raw === undefined) return undefined;
  const bad = () => invalidParameter('cursor', 'is not a valid cursor');
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw bad();
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad();
  const rec = obj as Record<string, unknown>;
  const keys = Object.keys(spec) as K[];
  if (Object.keys(rec).length !== keys.length) throw bad();
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const val = rec[k];
    if (typeof val !== 'string') throw bad();
    const kind = spec[k];
    if (kind === 'uuid' && !UUID.test(val)) throw bad();
    if (kind === 'seq' && (!SEQ.test(val) || BigInt(val) > SEQ_MAX)) throw bad();
    if (kind === 'ts' && !isRealTimestamp(val)) throw bad();
    if (kind === 'text' && (val === '' || val.length > 200 || val.includes('\u0000'))) throw bad();
    out[k] = val;
  }
  return out;
}
