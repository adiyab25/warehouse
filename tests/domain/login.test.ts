import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LOCKOUT_THRESHOLD,
  LOCKOUT_WINDOW_MS,
  parseLockoutConfig,
  signIn,
} from '../../src/auth/login.ts';
import { hashPassword } from '../../src/auth/password.ts';
import type { Queryable } from '../../src/db/client.ts';

/**
 * The PURE half of sign-in — no database, so it can prove the decisions that
 * are easy to get subtly wrong and impossible to see from the happy path:
 *
 *   (1) The lockout governor is CONFIGURATION, not a magic number sprinkled
 *       through the code. Both thresholds are exported constants so a test (and
 *       an operator reading the code) can see exactly what "too many" means, and
 *       they are READ FROM THE ENVIRONMENT with the v1 values as defaults.
 *
 *   (2) The UNKNOWN-USER path is CONSTANT-TIME. If a supplied username does not
 *       exist, sign-in must still run the password KDF against a fixed DUMMY
 *       hash exactly as it would for a real user with a wrong password.
 *       Comparing a password ONLY when the user is found makes the unknown-user
 *       reply measurably faster, which turns the endpoint into a free oracle
 *       for enumerating which usernames exist. This test injects a stub
 *       `verifyPassword` and asserts it is invoked once on BOTH paths.
 */

test('the lockout threshold and window are exported constants', () => {
  assert.equal(LOCKOUT_THRESHOLD, 5, 'the lockout threshold must default to 5 failures');
  assert.ok(Number.isInteger(LOCKOUT_THRESHOLD), 'the threshold must be an integer');
  assert.equal(
    LOCKOUT_WINDOW_MS,
    15 * 60 * 1000,
    'the lockout window must default to exactly 15 minutes, expressed in milliseconds',
  );
});

test('the lockout governor is environment configuration, and a bad value cannot disable it', () => {
  // The defaults, when nothing is configured.
  assert.deepEqual(parseLockoutConfig({}), { threshold: 5, windowMs: 15 * 60 * 1000 });

  // A deployment may tune both.
  assert.deepEqual(parseLockoutConfig({ LOCKOUT_THRESHOLD: '3', LOCKOUT_WINDOW_MS: '60000' }), {
    threshold: 3,
    windowMs: 60_000,
  });

  // ...but a typo, a zero, a negative or a float falls back to the default
  // rather than silently switching the lockout off (0 would lock nobody out).
  for (const bad of ['', '0', '-1', 'forever', '2.5', undefined]) {
    assert.deepEqual(
      parseLockoutConfig({ LOCKOUT_THRESHOLD: bad }),
      { threshold: 5, windowMs: 15 * 60 * 1000 },
      `LOCKOUT_THRESHOLD=${JSON.stringify(bad)} must fall back to the default`,
    );
    assert.deepEqual(
      parseLockoutConfig({ LOCKOUT_WINDOW_MS: bad }),
      { threshold: 5, windowMs: 15 * 60 * 1000 },
      `LOCKOUT_WINDOW_MS=${JSON.stringify(bad)} must fall back to the default`,
    );
  }
});

test('an unknown username takes the same path as a wrong password', async () => {
  const realHash = await hashPassword('the-real-password');

  // --- Path A: the user does not exist. --------------------------------
  let unknownKdfCalls = 0;
  let unknownHash = '';
  const unknownDb = {
    query: async (sql: string) => {
      if (sql.includes('count(*)')) return { rows: [{ n: 0 }] }; // no prior failures
      if (sql.includes('from app_users')) return { rows: [] }; // user not found
      return { rows: [] };
    },
  } as Queryable;

  const unknown = await signIn(
    unknownDb,
    { username: 'ghost_user', password: 'whatever' },
    {
      verifyPassword: async (_plain, hash) => {
        unknownKdfCalls += 1;
        unknownHash = hash;
        return false;
      },
    },
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false && unknown.reason, 'invalid');
  assert.equal(
    unknownKdfCalls,
    1,
    'the unknown-user path must still run the password KDF exactly once (constant time)',
  );
  assert.match(
    unknownHash,
    /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/,
    'the unknown user must be verified against a well-formed dummy hash, so the KDF actually runs',
  );

  // --- Path B: the user exists, the password is wrong. -----------------
  let knownKdfCalls = 0;
  const knownDb = {
    query: async (sql: string) => {
      if (sql.includes('count(*)')) return { rows: [{ n: 0 }] };
      if (sql.includes('from app_users')) {
        return { rows: [{ id: 'u1', password_hash: realHash, active: true }] };
      }
      return { rows: [] };
    },
  } as Queryable;

  const known = await signIn(
    knownDb,
    { username: 'owner_one', password: 'wrong' },
    {
      verifyPassword: async () => {
        knownKdfCalls += 1;
        return false;
      },
    },
  );
  assert.equal(known.ok, false);
  assert.equal(known.ok === false && known.reason, 'invalid');
  assert.equal(knownKdfCalls, 1, 'a wrong password must run the KDF exactly once too');

  assert.equal(
    unknownKdfCalls,
    knownKdfCalls,
    'a missing user and a wrong password must make the SAME number of KDF calls',
  );
});
