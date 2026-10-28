import { readRoute } from '../../../../api/read.ts';
import { optEnum, optInstant, optUuid, parseCursor, parseLimit } from '../../../../api/params.ts';
import { listMovements } from '../../../../db/read-api.ts';
import { MOVEMENT_REASONS } from '../../../../domain/movement.ts';

/**
 * GET /api/v1/movements — "where did it go". Newest first by `seq` (NOT
 * occurred_at), cursor on `seq`. `from` inclusive, `to` EXCLUSIVE. `reason` is
 * the raw closed-list code, a stable machine contract.
 */
const route = readRoute((db, url) => {
  const q = url.searchParams;
  return listMovements(db, {
    variantId: optUuid(q, 'variantId'),
    reason: optEnum(q, 'reason', MOVEMENT_REASONS),
    from: optInstant(q, 'from'),
    to: optInstant(q, 'to'),
    limit: parseLimit(q),
    cursor: parseCursor(q, { s: 'seq' }),
  });
});

export const GET = route.GET;
export const HEAD = route.HEAD;
export const OPTIONS = route.OPTIONS;
export const POST = route.POST;
export const PUT = route.PUT;
export const PATCH = route.PATCH;
export const DELETE = route.DELETE;
