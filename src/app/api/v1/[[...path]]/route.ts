import { ApiError, errorResponse } from '@/modules/api/domain/errors';

/** Any unknown `/api/v1/*` path is a JSON 404 (the framework default is HTML). */
const notFound = async (_req?: Request): Promise<Response> =>
  errorResponse(new ApiError(404, 'not_found', 'No such API route'));

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
