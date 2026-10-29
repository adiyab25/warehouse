import { readRoute } from '@/modules/api/index';
import { optEnum, parseCursor, parseLimit } from '@/modules/api/domain/params';
import { listLocations } from '@/modules/api/index';

/** GET /api/v1/locations. */
const route = readRoute((db, url) => {
  const q = url.searchParams;
  return listLocations(db, {
    type: optEnum(q, 'type', ['warehouse', 'bin', 'branch', 'transit', 'vendor', 'scrap', 'quarantine', 'holder'] as const),
    limit: parseLimit(q),
    cursor: parseCursor(q, { c: 'text', i: 'uuid' }),
  });
});

export const GET = route.GET;
export const HEAD = route.HEAD;
export const OPTIONS = route.OPTIONS;
export const POST = route.POST;
export const PUT = route.PUT;
export const PATCH = route.PATCH;
export const DELETE = route.DELETE;
