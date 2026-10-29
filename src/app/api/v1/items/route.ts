import { readRoute } from '@/modules/api/index';
import { optEnum, parseCursor, parseLimit } from '@/modules/api/domain/params';
import { listItems } from '@/modules/api/index';

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
