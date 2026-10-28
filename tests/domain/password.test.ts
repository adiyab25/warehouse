import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashPassword, verifyPassword } from '../../src/auth/password.ts';

/**
 * Unit tests for password hashing — the credential a PERSON signs in with.
 *
 * No database here. The properties that matter are:
 *
 *   - a password verifies against ITS OWN hash and against no other;
 *   - two hashes of the SAME password differ (each carries its own random salt),
 *     so a stolen table cannot be attacked with one dictionary pass;
 *   - a malformed stored hash returns `false` rather than throwing — a corrupt
 *     row is an authentication failure, not a 500.
 */

test('a password verifies against its own hash and no other', async () => {
  const hash = await hashPassword('correct horse battery staple');

  assert.equal(
    await verifyPassword('correct horse battery staple', hash),
    true,
    'the password that made the hash must verify',
  );
  assert.equal(
    await verifyPassword('correct horse battery stapler', hash),
    false,
    'a password differing by one character must NOT verify',
  );
  assert.equal(await verifyPassword('', hash), false, 'an empty guess must not verify');

  // ...and it must not verify against ANOTHER user's hash either.
  const other = await hashPassword('a different secret entirely');
  assert.equal(
    await verifyPassword('correct horse battery staple', other),
    false,
    'a password must not verify against a different hash',
  );
});

test('two hashes of the same password differ (salted)', async () => {
  const a = await hashPassword('same password twice');
  const b = await hashPassword('same password twice');

  assert.notEqual(a, b, 'each hash must carry its own random salt, so the hashes differ');
  assert.equal(await verifyPassword('same password twice', a), true, 'both still verify');
  assert.equal(await verifyPassword('same password twice', b), true, 'both still verify');

  // The salt lives in the hash itself (hex, between two `$`), so nothing else
  // needs to be stored alongside it.
  const parts = a.split('$');
  assert.equal(parts.length, 3, 'the stored form is scheme$salt$key');
  assert.equal(parts[0], 'scrypt', 'the scheme is named so a future change can be told apart');
});

test('a malformed stored hash returns false rather than throwing', async () => {
  const malformed = [
    '', // empty
    'not-a-hash', // no fields at all
    'scrypt$zzzz$zzzz', // non-hex salt and key
    'scrypt$ab$', // empty key
    'bcrypt$aa$bb', // unknown scheme
    'scrypt$aa', // missing a field
    'scrypt$aa$bb$cc', // one field too many
    `scrypt$aa${'ff'.repeat(63)}`, // key one byte short of the real length
  ];

  for (const stored of malformed) {
    let result: boolean | undefined;
    await assert.doesNotReject(async () => {
      result = await verifyPassword('anything', stored);
    }, `verifyPassword must not throw for the malformed hash ${JSON.stringify(stored)}`);
    assert.equal(
      result,
      false,
      `a malformed stored hash ${JSON.stringify(stored)} must return false`,
    );
  }

  // A hash that is well-formed but of the wrong key length is malformed too.
  assert.equal(
    await verifyPassword('x', `scrypt${'$'}${'aa'.repeat(16)}${'$'}${'ff'.repeat(32)}`),
    false,
    'a key of the wrong length is malformed, not a match',
  );
});
