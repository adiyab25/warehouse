import type { Queryable } from '@/modules/platform/index';
/* Role defined below */
/* readSession defined below */
import { SESSION_COOKIE } from './schema.ts';

/**
 * The CURRENT USER — who the request's session cookie actually is.
 *
 * This is the one place a cookie is turned into a person, and it is deliberately
 * a thin layer: the trust decision (is this token live?) belongs to
 * {@link readSession}, and everything it returns is filtered by the tenant
 * `withTenant` pinned, so a cookie can never resolve outside the deployment's
 * tenant.
 *
 * TWO ENTRY POINTS, on purpose:
 *
 *   * {@link currentUser} — the SEAM. It takes an already tenant-scoped `db` and
 *     a cookie value, so a test can drive it against a real database with rows
 *     it provisioned, and with no HTTP layer at all.
 *   * {@link loadCurrentUser} — the REQUEST path. It reads the request's cookie
 *     via `next/headers`, opens EXACTLY ONE `withTenant` boundary (the
 *     deployment tenant is configuration, `configuredTenantId()`), and resolves
 *     the session inside it. A page calls this once and gets `null` or a user;
 *     it must not open its own `withTenant` (`withTenant` is not re-entrant —
 *     see src/db/client.ts).
 *
 * A MISS IS A NULL, never an error: an absent cookie, an unknown token, an
 * expired session, a revoked session and a deactivated user all mean the same
 * thing to the caller — not signed in.
 */

/** The signed-in person, as the app needs them. */
export interface CurrentUser {
  /** `app_users.id` — the identity the session was opened for. */
  userId: string;
  /** The tenant the session belongs to (always the deployment's tenant). */
  tenantId: string;
  /** What the person may do. Mirrors `app_users.role`. */
  role: Role;
  /** The person's name AS TYPED — display data, never a credential. */
  displayName: string;
  /** The assigned username the person signed in with. */
  username: string;
  /**
   * The permission keys the person's ROLE holds (`role_permissions`), resolved
   * with the session so a screen asks "may I?" without a second round-trip.
   *
   * This is the AUTHORITY. `role` above is the legacy enum, kept because
   * screens still use it to decide which data a person may SEE (a branch user
   * sees their own branch); it must never decide whether an act is allowed —
   * that is {@link can}.
   */
  permissions: readonly string[];
}

/**
 * Resolves a raw session cookie to the person behind it, or `null`.
 *
 * Call it with the `db` of an ALREADY-OPEN `withTenant` scope; it opens none of
 * its own. The session is resolved ONCE — one `readSession`, one follow-up read
 * of the person's display row — inside that single transaction, so a request
 * costs one connection checkout regardless of how many screens ask who is
 * signed in.
 */
export async function currentUser(
  db: Queryable,
  cookieValue: string | undefined | null,
): Promise<CurrentUser | null> {
  if (typeof cookieValue !== 'string' || cookieValue === '') return null;

  const session = await readSession(db, cookieValue);
  if (!session) return null;

  // ONE read: the person's display row AND the permission set of their role.
  // Joined on `role_id`, not on the enum, so a tenant that renames a role or
  // edits its permissions is honoured on the very next request.
  const { rows } = await db.query<{ name: string; username: string; permissions: string[] }>(
    `select u.name,
            u.username,
            coalesce(
              array_agg(rp.permission_key order by rp.permission_key)
                filter (where rp.permission_key is not null),
              '{}'
            ) as permissions
       from app_users u
       left join role_permissions rp on rp.role_id = u.role_id
      where u.id = $1
      group by u.name, u.username`,
    [session.userId],
  );
  const person = rows[0];
  if (!person) return null;

  return {
    userId: session.userId,
    tenantId: session.tenantId,
    role: session.role,
    displayName: person.name,
    username: person.username,
    permissions: person.permissions ?? [],
  };
}

/**
 * The request-scoped version: reads the session cookie and resolves it inside
 * ONE `withTenant` boundary.
 *
 * `next/headers` is imported DYNAMICALLY so this module's static graph stays
 * free of the Next request layer — which is what lets tests import
 * {@link currentUser} directly (see tests/contract/current-user.test.ts).
 */
export async function loadCurrentUser(): Promise<CurrentUser | null> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;

  const { getAppPool } = await import('@/modules/platform/index');
  const { withTenant } = await import('@/modules/platform/index');
  const { configuredTenantId } = await import('./db.ts');

  return withTenant(await getAppPool(), configuredTenantId(), (db) => currentUser(db, value));
}
import { normaliseUsername } from '@/modules/platform/schema';
/* createSession defined below */
import { verifyPassword as realVerifyPassword } from './schema.ts';

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
  const openSession = deps.createSession ?? createSession;

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
import type { AppUser } from '@/modules/platform/index';
import { generateToken, hashToken } from './schema.ts';

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
/**
 * Which tenant THIS DEPLOYMENT serves.
 *
 * v1 is ONE DEPLOYMENT PER CLIENT, so the tenant is deployment CONFIGURATION,
 * not something the app discovers at runtime: the id is handed to the process at
 * boot in the `TENANT_ID` environment variable, and this module is the single
 * place that reads it. Task 11 (the auth shell) needs a tenant BEFORE any
 * session exists — to pin `app.tenant_id` on a `withTenant` connection so it can
 * read `app_users` and check a password, and to read back a session cookie — and
 * this is what supplies it.
 *
 * WHY IT CANNOT BE RESOLVED FROM THE DATABASE (yet): `tenants` has only
 * `(id, name, created_at)` — no host and no slug column — and its policy is
 * `id = current_setting('app.tenant_id')`, so a connection with no tenant pinned
 * cannot look ANY tenant up (and a scoped one can only see the tenant it is
 * already scoped to). There is deliberately NO host/subdomain → tenant resolver
 * and no second SECURITY DEFINER function: adding one is a real, separate design
 * decision for the SaaS end state (many tenants behind one host, resolved per
 * request), and it should be made explicitly rather than smuggled in behind the
 * auth shell. A host/subdomain mapping is therefore a LATER, deliberate
 * addition; until then the tenant is configuration.
 */

/** A plain uuid v4-ish shape check — enough to reject a placeholder or a name. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The NIL uuid — `00000000-0000-0000-0000-000000000000`.
 *
 * It is a valid uuid SHAPE and it is not a tenant: it is what a placeholder
 * (`.env.example`, a scaffold, an unset variable copied by hand) contains. It
 * must be REJECTED here, because a deployment that boots scoped to it is worse
 * than one that refuses to boot: the RLS policies pin a tenant that does not
 * exist, so every query returns zero rows, every sign-in fails as `invalid`,
 * and the failure looks like a wrong password rather than a misconfiguration.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The tenant id this deployment serves, from `TENANT_ID`.
 *
 * Returns the trimmed value, or THROWS a clear, actionable error when it is
 * unset, malformed, or the nil uuid: a deployment that does not know its tenant
 * cannot resolve a login, and failing loudly at boot beats failing quietly on
 * the first request (or, worse, scoping to the wrong tenant). Callers should
 * let the error propagate — it is a misconfiguration, never a user-facing
 * condition.
 */
export function configuredTenantId(): string {
  const raw = process.env.TENANT_ID?.trim() ?? '';
  if (!raw) {
    throw new Error(
      'configuredTenantId: TENANT_ID is not set — one deployment serves one tenant ' +
        'and the tenant id is deployment configuration (see README, "Which tenant this ' +
        'deployment serves"). Set TENANT_ID to the tenant uuid at boot.',
    );
  }
  if (!UUID.test(raw)) {
    throw new Error(
      `configuredTenantId: TENANT_ID must be a tenant uuid (got ${JSON.stringify(raw)})`,
    );
  }
  if (raw.toLowerCase() === NIL_UUID) {
    throw new Error(
      'configuredTenantId: TENANT_ID is the nil uuid (00000000-0000-0000-0000-000000000000). ' +
        'That is a placeholder, not a tenant: no row in `tenants` has it, so every query ' +
        'would return zero rows and every sign-in would fail as "invalid". Set TENANT_ID ' +
        'to the real tenant uuid.',
    );
  }
  return raw;
}

// ---- Permission checks (P1 1A.3) ----

/** Check if a role has a given permission key. */
export async function hasPermission(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { permission_key: string }[] }> },
  roleId: string,
  permissionKey: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from role_permissions where role_id = $1 and permission_key = $2 limit 1`,
    [roleId, permissionKey],
  );
  return rows.length > 0;
}

/** Require a permission from a session — throws if denied. */
export async function requirePermissionForSession(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  session: { userId: string },
  permissionKey: string,
): Promise<void> {
  const { rows } = await db.query(
    `select role_id from app_users where id = $1`,
    [session.userId],
  );
  const roleId = (rows[0] as { role_id: string } | undefined)?.role_id;
  if (!roleId) throw new Error(`Permission denied: ${permissionKey}`);
  const ok = await hasPermission(
    db as Parameters<typeof hasPermission>[0],
    roleId,
    permissionKey,
  );
  if (!ok) throw new Error(`Permission denied: ${permissionKey}`);
}
