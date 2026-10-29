import { getAppPool } from '@/modules/platform/index';
import { authenticateClient, type ApiScope } from './api-clients.ts';
import { ApiError } from '../domain/errors.ts';

/**
 * Bearer-token authentication for the outside-system API.
 *
 * SERVER-ONLY (reaches `pg`): never import from a client component.
 *
 * THE TOKEN IS THE ONLY CREDENTIAL. The browser session cookie is never read
 * here, and `src/proxy.ts` (the cookie gate) deliberately does not match
 * `/api/v1/*`. The TENANT is whatever the token resolves to — not `TENANT_ID`.
 *
 * The token is never logged, echoed or placed in an error message.
 */

// A real token is 32 random bytes as base64url (43 chars). Anything outside this
// shape cannot be a token, so it is refused WITHOUT touching the database.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

const unauthorized = (): ApiError => new ApiError(401, 'unauthorized', 'Missing or invalid API token');

/**
 * Header must be exactly `Bearer <token>` (scheme case-insensitive, ONE space,
 * no surrounding whitespace). Anything else is 401.
 */
function bearerToken(req: Request): string {
  const header = req.headers.get('authorization');
  if (!header) throw unauthorized();
  const m = /^bearer ([^\s]+)$/i.exec(header);
  const token = m?.[1];
  if (!token || !TOKEN_SHAPE.test(token)) throw unauthorized();
  return token;
}

/**
 * Authenticates the request and checks it holds `scope`.
 *   - no/garbled header, unknown, revoked token  → 401 `unauthorized`
 *   - valid token without the scope               → 403 `forbidden`
 * Resolution happens on the pool (the SECURITY DEFINER resolver), OUTSIDE any
 * tenant transaction; the caller then opens `withTenant` for `tenantId`.
 */
export async function requireScope(
  req: Request,
  scope: ApiScope,
): Promise<{ clientId: string; tenantId: string }> {
  const token = bearerToken(req);
  const client = await authenticateClient(await getAppPool(), token, { scope });
  if (!client) throw unauthorized();
  if (!client.scopes.includes(scope)) {
    throw new ApiError(403, 'forbidden', `This API key does not have the "${scope}" scope`);
  }
  return { clientId: client.id, tenantId: client.tenantId };
}
