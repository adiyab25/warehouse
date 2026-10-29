import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashPassword, verifyPassword } from '@/modules/auth/domain/password';

/**
 * Unit tests for password hashing — the credential a PERSON signs in with.
 *
 * No database here. The properties that matter are:
 *
 *   - a password verifies against ITS OWN hash and against no other;
 *   - two hashes of the SAME password differ (each carries its own random salt),
 *     so a stolen table cannot be attacked with one dictionary pass;
 *   - a malformed stored hash returns `false` rather than throwing — a corrupt
 *     row is an authentication failure, not a 500;
 *   - a same-length key that simply is not the password is refused, and a
 *     wrong-length key is refused by the shape check — the two outcomes a
 *     timing-safe comparison turns on.
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

/**
 * The two outcomes a timing-safe comparison can produce in the wild, each of
 * which a naive `===` WOULD get wrong or leak:
 *
 *   - a stored key of EXACTLY the right length that is simply not the derived
 *     key. This is the case `timingSafeEqual` exists for: it compares every byte
 *     and never short-circuits. A byte-by-byte `===` on the hex strings would
 *     exit at the first differing character and leak, by timing, how much of a
 *     guess was correct. `verifyPassword` always hands the comparison two
 *     buffers of the SAME length (see src/auth/password.ts), so this is the only
 *     secret-dependent branch and it is the one that must not leak.
 *   - a stored key of the WRONG length, which the shape check refuses outright
 *     rather than feeding the comparison buffers of unequal length (which
 *     `timingSafeEqual` throws on — a 500, and a row-existence oracle).
 *
 * The comparison IS `timingSafeEqual`, deliberately not `===`; that choice is
 * documented in src/auth/password.ts. The one thing that CAN be asserted here is
 * the OBSERVABLE result, which is what these cases pin.
 */
test('a same-length non-matching key and a wrong-length key both verify false', async () => {
  const hash = await hashPassword('the real secret');
  const [, saltHex, keyHex] = hash.split('$') as [string, string, string];

  // Right length, wrong bytes: flip the first hex character of the stored key.
  const flipped = (keyHex[0] === '0' ? '1' : '0') + keyHex.slice(1);
  assert.notEqual(flipped, keyHex, 'the flipped key really differs');
  assert.equal(
    await verifyPassword('the real secret', `scrypt${'$'}${saltHex}${'$'}${flipped}`),
    false,
    'a same-length KEY that is not the derived key must not verify',
  );

  // Wrong length, well-formed hex: refused by the shape check, not compared.
  const short = keyHex.slice(0, -2);
  assert.equal(
    await verifyPassword('the real secret', `scrypt${'$'}${saltHex}${'$'}${short}`),
    false,
    'a wrong-length key must return false (never compare unequal buffers)',
  );

  // A nonsense guess against the real hash is false too — the positive control
  // lives in the first test.
  assert.equal(await verifyPassword('not the real secret', hash), false, 'a wrong guess is false');
});
