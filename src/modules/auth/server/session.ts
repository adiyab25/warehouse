import type { Queryable } from '@/modules/platform/index';
import type { AppUser } from '@/modules/platform/index';
import { generateToken, hashToken } from '../domain/token.ts';

/**
 * Sessions — a signed-in PERSON.
 *
 * A session is one issued token. The raw token is handed back ONCE (to be set
 * as a cookie) and only its hash is stored, so the database can never hand a
 * live credential back out. Every session carries a mandatory `expires_at`;
 * {@link readSession} treats an expired or revoked row as a miss (null), never
 * an error.
 *
 * ---- NOTES REQUIRED BY TASK 11 (the auth shell) — deliberately NOT built here
 * This module is SESSION STORAGE only. The sign-in flow itself lives in
 * src/auth/login.ts (constant-time unknown-user path, the per-account lockout)
 * and the screens in src/app; the notes below are decisions that belong to
 * session storage and are recorded here rather than silently assumed:
 *
 *   * The LOCKOUT and the constant-time unknown-user path are implemented in
 *     src/auth/login.ts, not here — they belong to the LOGIN flow, not to
 *     session storage, and this module neither knows nor cares how a session was
 *     created.
 *   * A PASSWORD CHANGE does NOT invalidate live sessions. `readSession` checks
 *     the session and the user's `active` flag, not the password hash, so
 *     changing a password leaves every already-issued session valid until it
 *     expires. This is a DELIBERATE v1 decision — passwords are re-hashed in
 *     place and stored sessions survive — and the shell must either accept it or
 *     explicitly revoke this user's sessions (`update sessions set revoked_at =
 *     now() where user_id = $1 and tenant_id = …`) on a password change. It is
 *     called out here so it is a stated decision, not a surprise.
 */

/** The three roles a person may hold. Mirrors the `app_users.role` CHECK. */
export type Role = 'owner' | 'warehouse_manager' | 'branch_user';

/** The input {@link createSession} accepts; `db` supplies the tenant. */
export interface CreateSessionInput {
  /** The `app_users.id` the session is opened for. */
  userId: string;
  /** How long the session lives, in milliseconds. Defaults to 12 hours. */
  ttlMs?: number;
}

/** The once-only credential a successful sign-in returns. */
export interface CreatedSession {
  /** The raw token — returned ONCE, never stored, never retrievable again. */
  token: string;
  expiresAt: Date;
}

/** What {@link readSession} resolves a live token to. */
export interface ReadSessionResult {
  userId: string;
  tenantId: string;
  role: Role;
}

/**
 * The default session lifetime: 12 hours. A day's shift fits inside one, and the
 * token cannot outlive the day it was issued for by much.
 */
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Opens a session for a user and returns the raw token ONCE.
 *
 * The tenant is NOT a parameter — it is read from `app.tenant_id`, which
 * `withTenant` pinned, so a caller cannot open a session for a tenant it is not
 * scoped to (the `with check` half of the policy would refuse it anyway). Call
 * it with the scoped `db` from inside `withTenant`; never nest `withTenant`.
 *
 * The token is 32 random bytes ({@link generateToken}) and is stored ONLY as a
 * hash: the returned `token` is the one and only time the caller ever sees it.
 * `expires_at` is computed from the DATABASE clock (`now()`), not the app's, so
 * a skewed application server cannot mint a session that is already expired — or
 * one that never expires.
 */
export async function createSession(
  db: Queryable,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (!userId) {
    throw new Error('createSession: userId must be a non-empty string');
  }
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs)) {
    throw new Error(`createSession: ttlMs must be a finite number (got ${JSON.stringify(input.ttlMs)})`);
  }

  const token = generateToken();
  const tokenHash = hashToken(token);

  const { rows } = await db.query<{ expires_at: Date }>(
    `insert into sessions (tenant_id, user_id, token_hash, expires_at)
     values (
       nullif(current_setting('app.tenant_id', true), '')::uuid,
       $1,
       $2,
       now() + make_interval(secs => $3::double precision / 1000.0)
     )
     returning expires_at`,
    [userId, tokenHash, ttlMs],
  );

  const row = rows[0];
  if (!row) throw new Error('createSession: no row returned from insert');
  return { token, expiresAt: row.expires_at };
}

/**
 * Resolves a raw session token to its user, tenant and role — or `null`.
 *
 * Returns null for a token that is unknown, EXPIRED (`expires_at` in the past),
 * REVOKED (`revoked_at` set) or belongs to a DEACTIVATED user (`u.active` is
 * false). The `u.active` join is the offboarding hook Task 11 leans on: setting
 * a user inactive ends every live session immediately, without hunting down and
 * revoking individual tokens (guarded by
 * tests/contract/auth-guards.test.ts). A miss is a plain null, never an error:
 * the caller's whole decision is "signed in or not".
 *
 * NOTE: this is NOT affected by a password change — see the module docstring.
 *
 * TENANT-SCOPED, deliberately. A sign-in names the tenant (the login form / host
 * does), so the app has already pinned `app.tenant_id` by the time it reads a
 * session back; the token therefore never has to reveal a tenant, and no
 * SECURITY DEFINER escape hatch is needed for sessions (contrast
 * src/db/api-clients.ts, whose token IS the only way to learn the tenant). Call
 * it with the scoped `db` from inside `withTenant`.
 */
export async function readSession(db: Queryable, token: string): Promise<ReadSessionResult | null> {
  if (typeof token !== 'string' || token === '') return null;

  const tokenHash = hashToken(token);

  const { rows } = await db.query<{ user_id: string; tenant_id: string; role: Role }>(
    `select s.user_id, s.tenant_id, u.role
       from sessions s
       join app_users u on u.id = s.user_id and u.tenant_id = s.tenant_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and u.active`,
    [tokenHash],
  );

  const row = rows[0];
  if (!row) return null;
  return { userId: row.user_id, tenantId: row.tenant_id, role: row.role };
}

/** Re-exported for callers that need the generated user row shape. */
export type { AppUser };
