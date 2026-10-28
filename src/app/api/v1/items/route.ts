import { readRoute } from '../../../../api/read.ts';
import { optEnum, parseCursor, parseLimit } from '../../../../api/params.ts';
import { listItems } from '../../../../db/read-api.ts';

/** GET /api/v1/items — items + variants. Cost is deliberately omitted (v1). */
const route = readRoute((db, url) => {
  const q = url.searchParams;
  return listItems(db, {
    family: optEnum(q, 'family', ['sellable', 'consumable', 'asset'] as const),
    limit: parseLimit(q),
    cursor: parseCursor(q, { i: 'uuid' }),
  });
});

export const GET = route.GET;
export const HEAD = route.HEAD;
export const OPTIONS = route.OPTIONS;
export const POST = route.POST;
export const PUT = route.PUT;
export const PATCH = route.PATCH;
export const DELETE = route.DELETE;
