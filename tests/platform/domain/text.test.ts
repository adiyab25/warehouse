import assert from 'node:assert/strict';
import { test } from 'node:test';

import { USERNAME_PATTERN, isStoredUsername, normaliseName, normaliseUsername } from '@/modules/platform/domain/text';

/**
 * The normaliser that replaces `trim().toUpperCase()`.
 *
 * The old rule was a NO-OP for Arabic — upper-casing an Arabic letter changes
 * nothing — so a stored `أحمد علي` was a DIFFERENT string from the ordinary
 * keyboard spelling `احمد علي` (bare alef) and from `أحمد  علي` (two spaces),
 * and both were rejected. These tests pin the four cases the review verified
 * against the live database, plus each fold on its own.
 *
 * The DATABASE must agree with every one of these: migration 0012's
 * `public.normalise_name(text)` is the same function in SQL and
 * `app_users.name_normalised` carries a CHECK against it — see
 * tests/contract/app-users-identity.test.ts, which proves the two implementations
 * accept and reject the same strings.
 */

/** The ordinary spelling: bare alef, single space. Every case below folds to it. */
const CANONICAL = 'احمد علي';

test('the four Arabic cases all fold to ONE stored name', () => {
  // 1. The hamza spelling, as stored today.
  assert.equal(normaliseName('أحمد علي'), CANONICAL);
  // 2. Padded — the leading/trailing spaces the old `btrim` did handle.
  assert.equal(normaliseName(' أحمد علي '), CANONICAL);
  // 3. The bare-alef spelling — "the ordinary spelling" the review found REJECTED.
  assert.equal(normaliseName('احمد علي'), CANONICAL);
  // 4. A double space in the middle — also rejected before.
  assert.equal(normaliseName('أحمد  علي'), CANONICAL);

  // Which is the point: all four are the SAME name.
  const all = ['أحمد علي', ' أحمد علي ', 'احمد علي', 'أحمد  علي'].map(normaliseName);
  assert.equal(new Set(all).size, 1, 'four spellings must normalise to one string');
});

test('each fold does its own job', () => {
  // The alef family — أ إ آ ٱ — all fold to the bare alef.
  for (const alef of ['أ', 'إ', 'آ', 'ٱ']) {
    assert.equal(normaliseName(`${alef}حمد`), 'احمد', `${alef} must fold to ا`);
  }
  // Alef maqsura → ya.
  assert.equal(normaliseName('مصطفى'), 'مصطفي');
  // Ta marbuta → ha.
  assert.equal(normaliseName('أسامة'), 'اسامه');
  // Tatweel (kashida) is decorative and is stripped — only it.
  assert.equal(normaliseName('محمّـد'), 'محمّد');
  assert.equal(normaliseName('محمـد'), 'محمد');
  assert.equal(normaliseName('\u0640\u0640أحمد\u0640'), 'احمد');
});

test('NFKC means a combining sequence and its precomposed form are the same name', () => {
  const precomposed = 'أحمد';
  const decomposed = 'ا\u0654حمد'; // alef + combining hamza above
  assert.notEqual(precomposed, decomposed, 'the two spellings really are different strings');
  assert.equal(normaliseName(decomposed), normaliseName(precomposed));
  assert.equal(normaliseName(decomposed), 'احمد');
});

test('every kind of Unicode whitespace collapses to one ASCII space, and trims', () => {
  const spaces = ['  ', '\t', '\n', '\u00a0', '\u2003', '\u3000', '\r\n'];
  for (const gap of spaces) {
    assert.equal(
      normaliseName(`أحمد${gap}علي`),
      CANONICAL,
      `the gap ${JSON.stringify(gap)} must collapse to a single U+0020`,
    );
  }
  assert.equal(normaliseName('   أحمد   علي   '), CANONICAL);
  assert.equal(normaliseName(''), '');
  assert.equal(normaliseName('   '), '');
  assert.equal(normaliseName('أحمد'), 'احمد');
});

test('the username normaliser is trim + lower, and its charset is bounded', () => {
  assert.equal(normaliseUsername('  Owner_1  '), 'owner_1');
  assert.equal(normaliseUsername('OWNER_1'), 'owner_1');
  assert.equal(normaliseUsername(undefined as unknown as string), '');

  assert.equal(USERNAME_PATTERN.test('owner_1'), true);
  assert.equal(USERNAME_PATTERN.test('sara.zaki'), true);
  assert.equal(USERNAME_PATTERN.test('br-14'), true);
  assert.equal(USERNAME_PATTERN.test('ab'), false, 'a username is at least 3 characters');
  assert.equal(USERNAME_PATTERN.test('_owner'), false, 'it must start alphanumeric');
  assert.equal(USERNAME_PATTERN.test('owner one'), false, 'no spaces — it is machine-typed');
  assert.equal(USERNAME_PATTERN.test('أحمد'), false, 'no Arabic in a username');
  assert.equal(USERNAME_PATTERN.test('a'.repeat(33)), false, 'it is bounded to 32 characters');

  assert.equal(isStoredUsername('owner_1'), true);
  assert.equal(isStoredUsername('Owner_1'), false, 'an unstored spelling is not a stored username');
});
