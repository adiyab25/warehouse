import { generateToken, hashToken } from '@/modules/auth/domain/token';
import { withTenant, type Queryable } from '@/modules/platform/index';
import type { ApiClient } from '@/modules/platform/index';

// Re-export the GENERATED row type rather than hand-declaring a copy. The
// migration is the source of truth, `src/db/types.ts` is regenerated from it,
// and a hand copy here would drift (see src/db/returns.ts for the same rule).
export type { ApiClient };

/** What an issued key may do. The API understands read and write today. */
export type ApiScope = 'read' | 'write';

/** The input {@link issueClient} accepts; `db` supplies the tenant. */
export interface IssueClientInput {
  /** A human label for the integrator. Stored trimmed (the DB CHECK enforces it). */
  name: string;
  /** What the key may do. Omitted or empty ⇒ least privilege, `read`. */
  scopes?: ApiScope[];
}

/** A key resolved back to its client. Note: NO token and NO hash. */
export interface AuthenticatedClient {
  id: string;
  tenantId: string;
  scopes: string[];
}

/** The least-privilege default scope. */
const DEFAULT_SCOPES: ApiScope[] = ['read'];

/**
 * Issues an api key for an outside system and returns the raw token ONCE.
 *
 * The tenant is NOT a parameter — it is read from `app.tenant_id`, which
 * `withTenant` pinned, so a caller cannot issue a key for a tenant it is not
 * scoped to. Call it with the scoped `db` from inside `withTenant`; never nest
 * `withTenant`.
 *
 * The token is 32 random bytes ({@link generateToken}) and is stored ONLY as a
 * hash — the returned `token` is the one and only time the caller ever sees it,
 * and there is no later read that can hand it back. `name` is trimmed before it
 * is stored (the table's CHECK refuses an un-trimmed or empty value at the
 * database, for any writer that bypasses this function). Scopes default to
 * `read` when none are given.
 */
export async function issueClient(
  db: Queryable,
  input: IssueClientInput,
): Promise<{ id: string; token: string }> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw new Error('issueClient: name must be a non-empty string');
  }
  const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : DEFAULT_SCOPES;

  // The raw token exists only here, in memory, long enough to be hashed and
  // handed back. It is never written to a column and never logged.
  const token = generateToken();
  const tokenHash = hashToken(token);

  const { rows } = await db.query<{ id: string }>(
    `insert into api_clients (tenant_id, name, token_hash, scopes)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3)
     returning id`,
    [name, tokenHash, scopes],
  );

  const row = rows[0];
  if (!row) throw new Error('issueClient: no row returned from insert');
  return { id: row.id, token };
}

/**
 * Authenticates an api key, resolving the tenant the key belongs to.
 *
 * THIS IS THE ONE PATH THAT READS TENANT DATA WITHOUT `app.tenant_id` PINNED,
 * and it has to be: the tenant is precisely what the key is presented to
 * discover. Reading `api_clients` with a tenant scope would hide the very row
 * needed to find the tenant, so nothing would ever authenticate. The lookup
 * therefore goes through the `authenticate_api_token(text)` SECURITY DEFINER
 * function (migration 0010) — the single sanctioned exception to tenant
 * scoping, restricted to one hash and three columns — and then EVERYTHING
 * afterwards runs inside an ordinary tenant-scoped `withTenant` transaction for
 * the tenant that function returned.
 *
 * Returns null for an unknown or REVOKED (`active = false`) key — the resolver
 * filters on `active`, so a revoked key simply does not resolve.
 *
 * On a successful resolve it WRITES `last_used_at` (inside the tenant scope),
 * so an integrator's last activity is actually recorded rather than accepted and
 * forgotten. The stamp is COARSE: written only if null or older than 60 s, and
 * (when `opts.scope` is given) only if the key holds that scope — a 403 call
 * does not stamp. The result still carries `scopes` so the caller can refuse. Call it OUTSIDE a `withTenant` scope — it opens its own, and
 * `withTenant` is not re-entrant.
 */
export async function authenticateClient(
  db: Queryable,
  token: string,
  opts: { scope?: string } = {},
): Promise<AuthenticatedClient | null> {
  if (typeof token !== 'string' || token === '') return null;

  const tokenHash = hashToken(token);

  // The sanctioned exception: resolve the key to its tenant WITHOUT a scope.
  const { rows } = await db.query<{ client_id: string; tenant_id: string; scopes: string[] }>(
    `select client_id, tenant_id, scopes from authenticate_api_token($1)`,
    [tokenHash],
  );

  const row = rows[0];
  if (!row) return null;

  // Record use — but only for a call that is actually ALLOWED (a key lacking the
  // required scope is a 403 and must not stamp) and only when the last stamp is
  // older than STAMP_INTERVAL: ONE conditional UPDATE (no read-then-write race),
  // which takes the row lock only when it really writes.
  if (opts.scope === undefined || row.scopes.includes(opts.scope)) {
    await withTenant(db, row.tenant_id, async (tdb) => {
      await tdb.query(
        `update api_clients set last_used_at = now()
          where id = $1
            and (last_used_at is null or last_used_at < now() - interval '60 seconds')`,
        [row.client_id],
      );
    });
  }

  return { id: row.client_id, tenantId: row.tenant_id, scopes: row.scopes };
}
