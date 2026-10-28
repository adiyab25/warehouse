import { readRoute } from '../../../../api/read.ts';
import { optEnum, optUuid, parseCursor, parseLimit } from '../../../../api/params.ts';
import { listRequisitions } from '../../../../db/read-api.ts';
import type { RequisitionStatus } from '../../../../domain/requisition.ts';

/** The closed state list (mirrors `requisitions_status_check`). */
const REQUISITION_STATUSES = [
  'requested', 'approved', 'partially_issued', 'issued', 'received', 'closed', 'rejected', 'returned',
] as const satisfies readonly RequisitionStatus[];

/** GET /api/v1/requisitions — header + lines. Quantities are decimal strings. */
const route = readRoute((db, url) => {
  const q = url.searchParams;
  return listRequisitions(db, {
    status: optEnum(q, 'status', REQUISITION_STATUSES),
    branchLocationId: optUuid(q, 'branchLocationId'),
    limit: parseLimit(q),
    cursor: parseCursor(q, { t: 'ts', i: 'uuid' }),
  });
});

export const GET = route.GET;
export const HEAD = route.HEAD;
export const OPTIONS = route.OPTIONS;
export const POST = route.POST;
export const PUT = route.PUT;
export const PATCH = route.PATCH;
export const DELETE = route.DELETE;
