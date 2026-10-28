import { readRoute } from '../../../../api/read.ts';
import { optEnum, parseCursor, parseLimit } from '../../../../api/params.ts';
import { listLocations } from '../../../../db/read-api.ts';

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
