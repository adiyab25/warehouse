import { itemLevelAt } from '../db/replenishment.ts';
import { lockStockPair, postMovement } from '../db/movements.ts';
import type { Queryable } from '../db/client.ts';
import { isValidScannedCode, normaliseScannedCode } from '../domain/barcode.ts';
import { emit } from '../domain/events.ts';
import { MOVEMENT_REASONS, validateMovement } from '../domain/movement.ts';
import { ApiError } from './errors.ts';
import type { WriteContext, WriteResult } from './write.ts';

/**
 * POST /api/v1/movements — the write half of the movement API.
 *
 * LEAST PRIVILEGE ON REASONS. An outside system may post ONLY these reasons.
 * Everything else on the closed list (receipt, issue_to_branch, transfer,
 * count_correction, write_off, opening_balance) is a WAREHOUSE act with its own
 * screen and document (receipts, requisitions, counts, CSV import) and is
 * refused with 403 `reason_not_allowed`. Widening this list is a security
 * decision, not a convenience.
 */
export const API_ALLOWED_REASONS = ['sale', 'consumption', 'return_from_branch'] as const;

/** The only keys a body may carry. Anything else (a typo, `actor`) is a 400. */
const ALLOWED_KEYS = [
  'variantId',
  'sku',
  'qty',
  'reason',
  'fromLocationId',
  'fromLocationCode',
  'toLocationId',
  'toLocationCode',
  'occurredAt',
  'refType',
  'refId',
  'notes',
] as const;

/** A sales system may backfill a short outage: up to 31 days back, 5 minutes ahead. */
export const MAX_AGE_MS = 31 * 24 * 3600 * 1000;
export const MAX_FUTURE_MS = 5 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ASCII digits only (\d without the u flag), no sign, no exponent, no leading
// zeros, at most 9 integer digits (numeric(12,3)) and 3 decimals.
const QTY = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const bad = (field: string, why: string): ApiError =>
  new ApiError(400, 'invalid_parameter', `Invalid field "${field}": ${why}`, {}, { field });
const invalidField = (field: string, why: string): ApiError =>
  new ApiError(422, 'invalid_field', `Invalid field "${field}": ${why}`, {}, { field });

export type ParsedMovement = {
  variantId: string | null;
  sku: string | null;
  qty: string;
  reason: (typeof API_ALLOWED_REASONS)[number];
  from: { id?: string; code?: string; field: string } | null;
  to: { id?: string; code?: string; field: string } | null;
  occurredAt: string | null;
  refType: string | null;
  refId: string | null;
  notes: string | null;
};

function optString(b: Record<string, unknown>, k: string, max: number): string | null {
  const v = b[k];
  if (v === undefined) return null;
  if (typeof v !== 'string') throw bad(k, 'must be a string');
  if (v.length > max) throw bad(k, `must be at most ${max} characters`);
  return v;
}

function side(
  b: Record<string, unknown>,
  idKey: string,
  codeKey: string,
): { id?: string; code?: string; field: string } | null {
  const id = optString(b, idKey, 36);
  const code = optString(b, codeKey, 64);
  if (id !== null && code !== null) throw bad(idKey, `give ${idKey} or ${codeKey}, not both`);
  if (id !== null) {
    if (!UUID.test(id)) throw bad(idKey, 'must be a UUID');
    return { id: id.toLowerCase(), field: idKey };
  }
  if (code !== null) {
    const c = code.trim().toUpperCase();
    if (c === '') throw bad(codeKey, 'must not be empty');
    return { code: c, field: codeKey };
  }
  return null;
}

/** PURE: shape, types, limits, reason allowlist. Throws ApiError; touches no DB. */
export function parseMovementBody(body: Record<string, unknown>, now: number = Date.now()): ParsedMovement {
  for (const k of Object.keys(body)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(k)) {
      throw bad(k, 'unknown field');
    }
  }

  // Variant: exactly one of variantId / sku.
  const variantId = optString(body, 'variantId', 36);
  const sku = optString(body, 'sku', 64);
  if ((variantId === null) === (sku === null)) throw bad('variantId', 'give exactly one of variantId or sku');
  if (variantId !== null && !UUID.test(variantId)) throw bad('variantId', 'must be a UUID');

  // Quantity: a decimal STRING only. A JSON number loses precision.
  const qty = body.qty;
  if (typeof qty !== 'string') throw bad('qty', 'must be a decimal string such as "2" or "1.250"');
  if (!QTY.test(qty) || !/[1-9]/.test(qty)) {
    throw bad('qty', 'must be a positive decimal string, at most 9 digits and 3 decimals');
  }

  // Reason: closed list first (400), then the API's allowlist (403).
  const reason = body.reason;
  if (typeof reason !== 'string' || !(MOVEMENT_REASONS as readonly string[]).includes(reason)) {
    throw bad('reason', `must be one of: ${MOVEMENT_REASONS.join(', ')}`);
  }
  if (!(API_ALLOWED_REASONS as readonly string[]).includes(reason)) {
    throw new ApiError(
      403,
      'reason_not_allowed',
      `The API may post only: ${API_ALLOWED_REASONS.join(', ')}. "${reason}" is done through its own warehouse screen.`,
      {},
      { field: 'reason' },
    );
  }

  const from = side(body, 'fromLocationId', 'fromLocationCode');
  const to = side(body, 'toLocationId', 'toLocationCode');
  // What each allowed reason means for direction — so `sale` can never ADD stock.
  if (reason === 'sale' || reason === 'consumption') {
    if (!from) throw invalidField('fromLocationId', `${reason} needs the location it leaves`);
    if (to) throw invalidField(to.field, `${reason} cannot name a destination`);
  } else if (!to) {
    throw invalidField('toLocationId', `${reason} needs the location it arrives at`);
  }

  let occurredAt: string | null = null;
  const oa = optString(body, 'occurredAt', 40);
  if (oa !== null) {
    const t = ISO.test(oa) ? Date.parse(oa) : NaN;
    if (Number.isNaN(t)) throw bad('occurredAt', 'must be an ISO 8601 instant with a timezone, e.g. 2026-10-28T09:30:00Z');
    if (t > now + MAX_FUTURE_MS) throw bad('occurredAt', 'is more than 5 minutes in the future');
    if (t < now - MAX_AGE_MS) throw bad('occurredAt', 'is older than 31 days');
    occurredAt = new Date(t).toISOString();
  }

  let refType = optString(body, 'refType', 40);
  if (refType !== null) {
    refType = refType.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9 ._:/-]{0,39}$/.test(refType)) throw bad('refType', 'must be 1-40 letters, digits or . _ : / -');
  }
  const refId = optString(body, 'refId', 36);
  if (refId !== null && !UUID.test(refId)) throw bad('refId', 'must be a UUID');

  let notes = optString(body, 'notes', 500);
  if (notes !== null) {
    notes = notes.trim();
    if (notes === '') notes = null;
  }

  return {
    variantId: variantId?.toLowerCase() ?? null,
    sku,
    qty,
    reason: reason as ParsedMovement['reason'],
    from,
    to,
    occurredAt,
    refType,
    refId: refId?.toLowerCase() ?? null,
    notes,
  };
}

type Loc = { id: string; code: string };

async function resolveLocation(
  db: Queryable,
  s: { id?: string; code?: string; field: string } | null,
): Promise<Loc | null> {
  if (!s) return null;
  const { rows } = await db.query<Loc>(
    `select id, code from locations
      where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and active
        and ($1::uuid is null or id = $1)
        and ($2::text is null or code = $2)`,
    [s.id ?? null, s.code ?? null],
  );
  const row = rows[0];
  if (!row) throw invalidField(s.field, 'unknown or inactive location');
  return row;
}

/** Test seam: runs after the ledger row AND its events are written, just before commit. Never reachable over HTTP. */
export type MovementHooks = { beforeCommit?: (db: Queryable) => Promise<void> };

const lockKey = (db: Queryable, key: string) =>
  db.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [key]);

/**
 * The write itself, run INSIDE the caller's single `withTenant` transaction:
 * resolve names → validate with the SAME `validateMovement` as the UI →
 * idempotency (namespaced per client, content-compared) → guard-then-debit
 * under the advisory lock → insert (actor = the authenticated client) →
 * `movement.posted` (+ edge-triggered `stock.low`) in the same transaction.
 */
export async function executeMovement(
  ctx: WriteContext,
  p: ParsedMovement,
  hooks: MovementHooks = {},
): Promise<WriteResult> {
  const { db, clientId, tenantId } = ctx;
  if (!clientId) throw new Error('executeMovement: an authenticated client is required as the actor');

  // 1. The variant, within this tenant, active item AND variant only.
  const vf = p.variantId !== null ? 'variantId' : 'sku';
  const { rows: vr } = await db.query<{ variantId: string; itemId: string; sku: string; discrete: boolean }>(
    `select v.id as "variantId", v.item_id as "itemId", v.sku as "sku", i.discrete as "discrete"
       from item_variants v
       join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
      where v.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and v.active and i.active
        and ($1::uuid is null or v.id = $1)
        and ($2::text is null or v.sku = $2)`,
    [p.variantId, p.sku !== null ? normaliseScannedCode(p.sku) : null],
  );
  const variant = vr[0];
  if (!variant || (p.sku !== null && !isValidScannedCode(normaliseScannedCode(p.sku)))) {
    throw invalidField(vf, 'unknown variant');
  }

  // 2. Locations, within this tenant, active only.
  const from = await resolveLocation(db, p.from);
  const to = await resolveLocation(db, p.to);

  // 3. The SAME rules the screens use. Number() is exact here: the string was
  // already proven to be <= 12 significant digits with <= 3 decimals.
  const check = validateMovement({
    reason: p.reason,
    qty: Number(p.qty),
    discrete: variant.discrete,
    fromLocationId: from?.id ?? null,
    toLocationId: to?.id ?? null,
  });
  if (!check.ok) {
    throw invalidField(check.field === 'quantity' ? 'qty' : check.field, check.message);
  }

  // 4. Idempotency. Keys are unique per TENANT, so the stored key is namespaced
  // by the client: two integrations can pick the same key without colliding.
  const storedKey = `api:${clientId}:${ctx.idempotencyKey}`;
  await lockKey(db, `idem:${tenantId}:${storedKey}`);
  const { rows: ex } = await db.query<{ id: string; same: boolean }>(
    `select id,
            (variant_id = $2 and qty = $3::numeric
             and from_location_id is not distinct from $4::uuid
             and to_location_id is not distinct from $5::uuid
             and reason = $6
             and ($7::timestamptz is null or occurred_at = $7::timestamptz)
             and ref_type is not distinct from $8::text
             and ref_id is not distinct from $9::uuid
             and notes is not distinct from $10::text) as same
       from stock_movements
      where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and idempotency_key = $1`,
    [storedKey, variant.variantId, p.qty, from?.id ?? null, to?.id ?? null, p.reason, p.occurredAt, p.refType, p.refId, p.notes],
  );
  if (ex[0]) {
    if (!ex[0].same) {
      throw new ApiError(
        409,
        'idempotency_conflict',
        'This Idempotency-Key was already used for a different movement; use a new key for a changed request',
      );
    }
    return { status: 200, body: { data: { id: ex[0].id, deduped: true } } };
  }

  // 5. Guard-then-debit. Lock order is fixed (idem key, variant pair, item
  // level) so concurrent writers cannot deadlock. A read is not a lock: the
  // advisory lock is what makes check+insert atomic per (variant, location).
  let before: Awaited<ReturnType<typeof itemLevelAt>> = null;
  if (from) {
    await lockStockPair(db, variant.variantId, from.id);
    await lockStockPair(db, variant.itemId, from.id); // the item-level edge for stock.low
    const { rows: g } = await db.query<{ onHand: string; enough: boolean }>(
      `select coalesce(sum(qty), 0)::numeric(12,3)::text as "onHand",
              coalesce(sum(qty), 0) >= $3::numeric as "enough"
         from on_hand where variant_id = $1 and location_id = $2`,
      [variant.variantId, from.id, p.qty],
    );
    if (!g[0]?.enough) {
      throw new ApiError(
        409,
        'insufficient_stock',
        `Only ${g[0]?.onHand ?? '0.000'} of variant ${variant.variantId} at ${from.code}; ${p.qty} requested`,
        {},
        { details: { variantId: variant.variantId, location: from.code, available: g[0]?.onHand ?? '0.000', requested: p.qty } },
      );
    }
    before = await itemLevelAt(db, variant.itemId, from.id);
  }

  // 6. The ledger row. The actor is the authenticated client, never the caller's say.
  const posted = await postMovement(db, {
    variantId: variant.variantId,
    qty: Number(p.qty),
    reason: p.reason,
    fromLocationId: from?.id ?? null,
    toLocationId: to?.id ?? null,
    actorApiClientId: clientId,
    occurredAt: p.occurredAt,
    refType: p.refType,
    refId: p.refId,
    idempotencyKey: storedKey,
    notes: p.notes,
  });
  if (posted.deduped) {
    // Cannot happen under the key lock; refuse rather than answer wrongly.
    throw new Error('executeMovement: unexpected dedupe under the idempotency lock');
  }

  // 7. The outbox, same transaction.
  const { rows: meta } = await db.query<{ seq: string; occurredAt: string; actorName: string }>(
    `select m.seq::text as "seq",
            to_char(m.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "occurredAt",
            c.name as "actorName"
       from stock_movements m
       join api_clients c on c.id = m.actor_api_client_id and c.tenant_id = m.tenant_id
      where m.id = $1`,
    [posted.id],
  );
  const m = meta[0];
  if (!m) throw new Error('executeMovement: posted movement not readable');
  const now = new Date().toISOString();

  await emit(db, {
    type: 'movement.posted',
    tenantId,
    occurredAt: now,
    payload: {
      movementId: posted.id,
      seq: m.seq,
      variantId: variant.variantId,
      itemId: variant.itemId,
      sku: variant.sku,
      qty: p.qty,
      reason: p.reason,
      fromLocationId: from?.id ?? null,
      fromLocation: from?.code ?? null,
      toLocationId: to?.id ?? null,
      toLocation: to?.code ?? null,
      refType: p.refType,
      refId: p.refId,
      movementOccurredAt: m.occurredAt,
      actor: { type: 'api_client', name: m.actorName },
    },
  });

  // 8. stock.low is EDGE-triggered: only the debit that moves the item at this
  // location from ABOVE its minimum to at-or-below it.
  if (from && before && !before.atOrBelow) {
    const after = await itemLevelAt(db, variant.itemId, from.id);
    if (after?.atOrBelow) {
      await emit(db, {
        type: 'stock.low',
        tenantId,
        occurredAt: now,
        payload: {
          itemId: variant.itemId,
          locationId: from.id,
          location: from.code,
          onHand: after.onHand,
          minQty: after.minQty,
          movementId: posted.id,
        },
      });
    }
  }

  await hooks.beforeCommit?.(db);
  return { status: 201, body: { data: { id: posted.id, deduped: false } } };
}

/** The `writeRoute` runner for POST /api/v1/movements. */
export async function postMovementRoute(ctx: WriteContext): Promise<WriteResult> {
  return executeMovement(ctx, parseMovementBody(ctx.body));
}
