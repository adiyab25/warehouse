import { readRoute } from '@/modules/api/index';
import { optText, optUuid, parseCursor, parseLimit } from '@/modules/api/domain/params';
import { listOnHand } from '@/modules/api/index';

/** GET /api/v1/on-hand — thin adapter; auth, scope, tenant and errors live in `readRoute`. */
const route = readRoute((db, url) => {
  const q = url.searchParams;
  return listOnHand(db, {
    variantId: optUuid(q, 'variantId'),
    sku: optText(q, 'sku'),
    locationId: optUuid(q, 'locationId'),
    limit: parseLimit(q),
    cursor: parseCursor(q, { v: 'uuid', l: 'uuid' }),
  });
});

export const GET = route.GET;
export const HEAD = route.HEAD;
export const OPTIONS = route.OPTIONS;
export const POST = route.POST;
export const PUT = route.PUT;
export const PATCH = route.PATCH;
export const DELETE = route.DELETE;
