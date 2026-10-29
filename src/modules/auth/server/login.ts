import type { Queryable } from '@/modules/platform/index';
import { normaliseUsername } from '@/modules/platform/domain/text';
import {
  createSession as realCreateSession,
  type CreatedSession,
  type CreateSessionInput,
} from './session.ts';
import { verifyPassword as realVerifyPassword } from '../domain/password.ts';

/**
 * Sign-in — the one place a password is checked.
 *
 * IDENTITY IS AN ASSIGNED USERNAME, never the person's name. A name is display
 * data: two employees really can both be called `أحمد علي`, and looking a
 * person up by NAME made them ONE identity — one person's password checked
 * against the other's hash, and one shared lockout bucket. `app_users.username`
 * is unique per tenant (migration 0012) and that constraint, not a `limit 1` in
 * this file, is what makes a sign-in name exactly one account.
 *
 * This module owns three decisions that are easy to get subtly wrong:
 *
 *   (1) CONSTANT TIME ON THE UNKNOWN-USER PATH. When the supplied username
 *       matches no user, this module still runs the password KDF once — against
 *       a fixed DUMMY hash below — exactly as it would for a real user with a
 *       wrong password. Verifying a password ONLY when the user is found makes
 *       the unknown-user reply measurably faster, which turns the endpoint into
 *       a free oracle for enumerating which usernames exist. Both paths
 *       therefore do the SAME single KDF call (guarded by
 *       tests/domain/login.test.ts), and an attempt is recorded even for a
 *       username that does not exist — so a locked username behaves the same
 *       whether or not it is real.
 *
 *   (2) LOCKOUT, NOT EXTENDABLE. After {@link LOCKOUT_THRESHOLD} failures for
 *       the same normalised USERNAME inside {@link LOCKOUT_WINDOW_MS}, sign-in
 *       is refused WITHOUT checking the password at all, and while locked the
 *       attempt is NOT recorded. That last part is the fix: recording it let an
 *       attacker hold the account shut forever with one request per window, and
 *       the lock now really does end at "the last failure plus the window".
 *       Both thresholds are environment configuration
 *       ({@link parseLockoutConfig}), defaulted to the v1 values.
 *
 *       THE LOCKOUT IDENTIFIER IS THE USERNAME. It used to be the person's
 *       NAME, so a colleague who shared that name could lock someone out; the
 *       lookup and the lockout now agree on one value.
 *
 *       ---- ACCEPTED RESIDUAL RISK (a deliberate v1 decision) ---------------
 *       There is NO per-IP and no global rate limit, and the lock is PER
 *       ACCOUNT: an attacker who knows a username can deliberately submit
 *       {@link LOCKOUT_THRESHOLD} bad passwords and deny that one account
 *       sign-in for up to {@link LOCKOUT_WINDOW_MS}. That denial of service
 *       against a named account is ACCEPTED, because the alternative — letting
 *       a correct password through while locked — hands an attacker unlimited
 *       guesses, which is the worse failure. Mitigations belonging to a later
 *       task: per-IP and global limiting, and an operator-visible alert on
 *       repeated lockouts. They are NOT built here. The lock is not a permanent
 *       state: it cannot be extended (above) and expires on its own.
 *
 * TENANCY: every query here runs through the `db` it is handed, which the
 * caller has already scoped with `withTenant(configuredTenantId(), …)` ONCE at
 * the request boundary. `withTenant` is not re-entrant, so this module NEVER
 * opens one — it takes the scoped handle and reads the tenant implicitly from
 * `app.tenant_id` (the RLS policy on `login_attempts`/`app_users` supplies it).
 *
 * SECRETS: a password, a raw token and a hash are NEVER logged here.
 */

/** The default number of failures — for one username, inside the window. */
const DEFAULT_LOCKOUT_THRESHOLD = 5;

/** The default window the failures are counted over: 15 minutes. */
const DEFAULT_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Reads the lockout governor from the environment.
 *
 * `LOCKOUT_THRESHOLD` and `LOCKOUT_WINDOW_MS` tune the lockout per deployment —
 * a warehouse with 400 branch users wants different numbers from a shop with
 * three. Both are VALIDATED here rather than trusted: a value that is not a
 * positive integer (a typo, an empty string, a float) falls back to the
 * default, so a bad manifest can never silently disable the lockout. Exported,
 * and pure (it takes `env` as an argument), so the rule is testable on its own.
 */
export function parseLockoutConfig(env: Record<string, string | undefined> = process.env): {
  threshold: number;
  windowMs: number;
} {
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    // Deliberately strict: only digits. `parseInt` would accept '2.5' as 2 and
    // '3abc' as 3, which is a number nobody wrote.
    if (!/^\d+$/.test(raw ?? '')) return fallback;
    const parsed = Number.parseInt(raw as string, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    threshold: positiveInt(env.LOCKOUT_THRESHOLD, DEFAULT_LOCKOUT_THRESHOLD),
    windowMs: positiveInt(env.LOCKOUT_WINDOW_MS, DEFAULT_LOCKOUT_WINDOW_MS),
  };
}

/**
 * How many failures — for one username, inside the window — lock it out.
 * Deployment configuration, read once at boot from `LOCKOUT_THRESHOLD`.
 */
export const LOCKOUT_THRESHOLD = parseLockoutConfig().threshold;

/** The window the failures are counted over, read from `LOCKOUT_WINDOW_MS`. */
export const LOCKOUT_WINDOW_MS = parseLockoutConfig().windowMs;

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
  /** The ASSIGNED username as typed. Normalised (trim + lower) before use. */
  username: string;
  /** The password to verify. Never logged. */
  password: string;
}

/** The outcome of a sign-in attempt. */
export type SignInResult =
  | { ok: true; token: string; expiresAt: Date; preferredLang: string | null }
  | { ok: false; reason: 'invalid' | 'locked' };

/**
 * Injection seam for the pure/branch tests — **not part of the public API**.
 *
 * @internal Both members default to the real implementation and the application
 * never passes them. It exists so `tests/domain/login.test.ts` can COUNT
 * password-KDF calls (proving the unknown-user path is constant-time: exactly
 * one KDF call on each path) and so `tests/contract/login-attempts.test.ts` can
 * prove a locked username is refused with NO KDF call at all. Nothing else may
 * depend on it.
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
  preferred_lang: string | null;
}

/**
 * Attempts to sign a person in.
 *
 * Call it with a `db` already scoped to the configured tenant (inside
 * `withTenant`); it must NOT be called before a tenant is pinned. Returns
 * `{ ok: true, token, expiresAt }` on success, or `{ ok: false, reason }` where
 * `reason` is `'locked'` (too many recent failures for this username) or
 * `'invalid'` (no such username, wrong password, or an inactive user).
 */
export async function signIn(
  db: Queryable,
  input: SignInInput,
  deps: SignInDeps = {},
): Promise<SignInResult> {
  const verify = deps.verifyPassword ?? realVerifyPassword;
  const openSession = deps.createSession ?? realCreateSession;

  const username = normaliseUsername(input.username);
  const password = typeof input.password === 'string' ? input.password : '';

  // 1. LOCKOUT — refuse BEFORE touching the password, so a locked username
  //    cannot be used to grind passwords (and costs no KDF time). The refused
  //    attempt is NOT recorded: recording it would let an attacker hold the
  //    account shut indefinitely (see the module docstring).
  if (await isLockedOut(db, username)) {
    return { ok: false, reason: 'locked' };
  }

  // 2. LOOK-UP within the pinned tenant (RLS scopes the query to it), BY
  //    USERNAME, exactly. No `limit 1`: `unique (tenant_id, username)` — the
  //    constraint migration 0012 adds — is what guarantees at most one row, and
  //    a `limit 1` here would quietly hide the day that stops being true.
  const { rows } = await db.query<UserRow>(
    `select id, password_hash, active, preferred_lang
       from app_users
      where username = $1`,
    [username],
  );
  const user: UserRow | undefined = rows[0];

  // 3. VERIFY — CONSTANT TIME. Run the KDF exactly once on BOTH paths: a real
  //    hash when the user exists, the fixed DUMMY hash when it does not.
  const storedHash = user?.password_hash ?? DUMMY_HASH;
  const passwordMatches = await verify(password, storedHash);
  const authenticated = user !== undefined && passwordMatches && user.active;

  if (!authenticated) {
    // Record the FAILURE (the username is normalised) and refuse. Recorded even
    // when the username is unknown, so a fake username locks exactly like a
    // real one.
    await recordAttempt(db, username, false);
    return { ok: false, reason: 'invalid' };
  }

  // 4. SUCCESS — open a session and record the success. The preceding failures
  //    are KEPT: deleting them destroyed the only record of the brute force
  //    that led up to a successful sign-in, and a success is not evidence that
  //    the failures did not happen. Bounding the table is the sweep's job
  //    (purge_login_attempts, migration 0012), not sign-in's.
  const session = await openSession(db, { userId: user.id });
  await recordAttempt(db, username, true);

  return { ok: true, token: session.token, expiresAt: session.expiresAt, preferredLang: user.preferred_lang ?? null };
}

/**
 * Is `username` locked out right now?
 *
 * Locked = at least {@link LOCKOUT_THRESHOLD} FAILURES for this normalised
 * username inside {@link LOCKOUT_WINDOW_MS}, measured against the DATABASE
 * clock (`now()`) on the scoped connection, never the application's.
 *
 * The lock therefore lasts until the last failure ages out of the window — and
 * because {@link signIn} records nothing while locked, no failure can be added,
 * so the window cannot be pushed out from under the lock.
 */
async function isLockedOut(db: Queryable, username: string): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n
       from login_attempts
      where identifier = $1
        and not succeeded
        and attempted_at > now() - make_interval(secs => $2)`,
    [username, LOCKOUT_WINDOW_MS / 1000],
  );
  return (rows[0]?.n ?? 0) >= LOCKOUT_THRESHOLD;
}

/** Writes one attempt row. `tenant_id` comes from the pinned `app.tenant_id`. */
async function recordAttempt(db: Queryable, username: string, succeeded: boolean): Promise<void> {
  await db.query(
    `insert into login_attempts (tenant_id, identifier, succeeded)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2)`,
    [username, succeeded],
  );
}
