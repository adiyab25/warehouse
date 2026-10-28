import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOCKOUT_THRESHOLD, LOCKOUT_WINDOW_MS, signIn } from '../../src/auth/login.ts';
import { hashPassword } from '../../src/auth/password.ts';
import type { Queryable } from '../../src/db/client.ts';

/**
 * The PURE half of sign-in — no database, so it can prove the two decisions
 * that are easy to get subtly wrong and impossible to see from the happy path:
 *
 *   (1) The lockout governor is CONFIGURATION, not a magic number sprinkled
 *       through the code. Both thresholds are exported constants so a test (and
 *       an operator reading the code) can see exactly what "too many" means.
 *
 *   (2) The UNKNOWN-USER path is CONSTANT-TIME. If a supplied name does not
 *       exist, sign-in must still run the password KDF against a fixed DUMMY
 *       hash exactly as it would for a real user with a wrong password.
 *       Comparing a password ONLY when the user is found makes the unknown-user
 *       reply measurably faster, which turns the endpoint into a free oracle
 *       for enumerating which names exist. This test injects a stub
 *       `verifyPassword` and asserts it is invoked once on BOTH paths.
 */

test('the lockout threshold and window are exported constants', () => {
  assert.equal(LOCKOUT_THRESHOLD, 5, 'the lockout threshold must be exactly 5 failures');
  assert.ok(Number.isInteger(LOCKOUT_THRESHOLD), 'the threshold must be an integer');
  assert.equal(
    LOCKOUT_WINDOW_MS,
    15 * 60 * 1000,
    'the lockout window must be exactly 15 minutes, expressed in milliseconds',
  );
});

test('an unknown user takes the same path as a wrong password', async () => {
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
    { userLookup: 'ghost', password: 'whatever' },
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
    { userLookup: 'someone', password: 'wrong' },
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
