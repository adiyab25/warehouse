import type { Queryable } from '../db/client.ts';
import {
  createSession as realCreateSession,
  type CreatedSession,
  type CreateSessionInput,
} from './session.ts';
import { verifyPassword as realVerifyPassword } from './password.ts';

/**
 * Sign-in — the one place a password is checked.
 *
 * This module owns two decisions that are easy to get subtly wrong:
 *
 *   (1) CONSTANT TIME ON THE UNKNOWN-USER PATH. When the supplied name matches
 *       no user, this module still runs the password KDF once — against a fixed
 *       DUMMY hash below — exactly as it would for a real user with a wrong
 *       password. Verifying a password ONLY when the user is found makes the
 *       unknown-user reply measurably faster, which turns the endpoint into a
 *       free oracle for enumerating which names exist. Both paths therefore do
 *       the SAME single KDF call (guarded by tests/domain/login.test.ts).
 *
 *   (2) LOCKOUT. After {@link LOCKOUT_THRESHOLD} failures for the same
 *       NORMALISED identifier within {@link LOCKOUT_WINDOW_MS}, sign-in is
 *       refused WITHOUT checking the password at all, and a SUCCESS clears the
 *       failure count for that identifier. Both thresholds are named constants,
 *       never magic numbers.
 *
 * TENANCY: every query here runs through the `db` it is handed, which the
 * caller has already scoped with `withTenant(configuredTenantId(), …)` ONCE at
 * the request boundary. `withTenant` is not re-entrant, so this module NEVER
 * opens one — it takes the scoped handle and reads the tenant implicitly from
 * `app.tenant_id` (the RLS policy on `login_attempts`/`app_users` supplies it).
 *
 * SECRETS: a password, a raw token and a hash are NEVER logged here.
 */

/**
 * How many failures — for one identifier, inside the window — lock it out.
 * Named, exported configuration, not a literal buried in a query.
 */
export const LOCKOUT_THRESHOLD = 5;

/** The window the failures are counted over: 15 minutes, in milliseconds. */
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/**
 * A fixed, well-formed scrypt hash of an arbitrary string that no user has.
 *
 * It is REAL and well-formed on purpose: {@link realVerifyPassword} only runs
 * the KDF when the stored hash parses, so a malformed dummy would return
 * `false` immediately — no scrypt work — and the unknown-user path would be
 * fast again, defeating the whole point. This hash matches nothing, so the KDF
 * runs and the comparison is `false`, indistinguishable in cost from a real
 * user's wrong password. It is never compared to anything a caller controls.
 */
const DUMMY_HASH =
  'scrypt$7f5bf404f9502ad789653401a53dc627$' +
  'd5ce7424a0902de21d699bfbf450a41ef266e383fb8bc5a32799c51fd204ea54' +
  'ece07ea57891ecdbfea999e69443063125d417965aac2d5ca6cb3271963dc503';

/** What {@link signIn} is given. The tenant comes from the scoped `db`. */
export interface SignInInput {
  /** The human-typed name. Normalised (trim + upper) before use. */
  userLookup: string;
  /** The password to verify. Never logged. */
  password: string;
}

/** The outcome of a sign-in attempt. */
export type SignInResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'invalid' | 'locked' };

/**
 * Injection seam for the pure/branch tests. Both default to the real
 * implementations; only tests pass them.
 */
export interface SignInDeps {
  verifyPassword?: (plain: string, hash: string) => Promise<boolean>;
  createSession?: (db: Queryable, input: CreateSessionInput) => Promise<CreatedSession>;
}

/** The row shape this module reads back from `app_users`. */
interface UserRow {
  id: string;
  password_hash: string;
  active: boolean;
}

/**
 * Normalises a human-typed identifier to the stored form: trim, then upper.
 *
 * The SAME function is applied to the lookup and to the recorded attempt, and
 * the `login_attempts` CHECK enforces the identical rule at the database, so a
 * writer that bypasses this module cannot store an un-normalised identifier
 * (`'  Ahmed '` → `'AHMED'`).
 */
export function normaliseIdentifier(raw: string): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

/**
 * Attempts to sign a person in.
 *
 * Call it with a `db` already scoped to the configured tenant (inside
 * `withTenant`); it must NOT be called before a tenant is pinned. Returns
 * `{ ok: true, token, expiresAt }` on success, or `{ ok: false, reason }` where
 * `reason` is `'locked'` (too many recent failures) or `'invalid'` (no such
 * user, wrong password, or an inactive user).
 */
export async function signIn(
  db: Queryable,
  input: SignInInput,
  deps: SignInDeps = {},
): Promise<SignInResult> {
  const verify = deps.verifyPassword ?? realVerifyPassword;
  const openSession = deps.createSession ?? realCreateSession;

  const identifier = normaliseIdentifier(input.userLookup);
  const password = typeof input.password === 'string' ? input.password : '';

  // 1. LOCKOUT — refuse BEFORE touching the password, so a locked identifier
  //    cannot be used to grind passwords (and costs no KDF time).
  if (await isLockedOut(db, identifier)) {
    return { ok: false, reason: 'locked' };
  }

  // 2. LOOK-UP within the pinned tenant (RLS scopes the query to it). The name
  //    is matched on its normalised form so casing/whitespace cannot smuggle a
  //    second identifier past the lockout.
  const { rows } = await db.query<UserRow>(
    `select id, password_hash, active
       from app_users
      where upper(btrim(name)) = $1
      limit 1`,
    [identifier],
  );
  const user: UserRow | undefined = rows[0];

  // 3. VERIFY — CONSTANT TIME. Run the KDF exactly once on BOTH paths: a real
  //    hash when the user exists, the fixed DUMMY hash when it does not.
  const storedHash = user?.password_hash ?? DUMMY_HASH;
  const passwordMatches = await verify(password, storedHash);
  const authenticated = user !== undefined && passwordMatches && user.active;

  if (!authenticated) {
    // Record the FAILURE (the attempted identifier is normalised) and refuse.
    await recordAttempt(db, identifier, false);
    return { ok: false, reason: 'invalid' };
  }

  // 4. SUCCESS — open a session, record the success, and CLEAR the failures
  //    for this identifier so a legitimate user is not locked out later.
  const session = await openSession(db, { userId: user.id });
  await recordAttempt(db, identifier, true);
  await clearFailures(db, identifier);

  return { ok: true, token: session.token, expiresAt: session.expiresAt };
}

/** Counts recent failures for `identifier` within the window and compares. */
async function isLockedOut(db: Queryable, identifier: string): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n
       from login_attempts
      where identifier = $1
        and not succeeded
        and attempted_at > now() - make_interval(secs => $2)`,
    [identifier, LOCKOUT_WINDOW_MS / 1000],
  );
  return (rows[0]?.n ?? 0) >= LOCKOUT_THRESHOLD;
}

/** Writes one attempt row. `tenant_id` comes from the pinned `app.tenant_id`. */
async function recordAttempt(db: Queryable, identifier: string, succeeded: boolean): Promise<void> {
  await db.query(
    `insert into login_attempts (tenant_id, identifier, succeeded)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2)`,
    [identifier, succeeded],
  );
}

/** Deletes the failure rows for `identifier`, leaving the successes. */
async function clearFailures(db: Queryable, identifier: string): Promise<void> {
  await db.query(`delete from login_attempts where identifier = $1 and not succeeded`, [identifier]);
}
