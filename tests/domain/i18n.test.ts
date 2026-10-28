import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LANGS, ar, en, t } from '../../src/i18n/index.ts';

/**
 * The i18n shell has three load-bearing properties:
 *
 *   (1) Arabic is COMPLETE — every English key has an Arabic string, so a
 *       screen rendered in the default language never falls through to a raw
 *       key. English is the secondary language; Arabic is the source of truth.
 *   (2) A MISSING key degrades safely. `t` must return the KEY itself — never
 *       `undefined`, never `''` — so a missing string shows up as a visible,
 *       searchable token instead of the word "undefined" on the page or an
 *       empty label.
 *   (3) Arabic is the DEFAULT. Calling `t` with no language must render Arabic,
 *       because the whole app is Arabic-first and RTL; English is opt-in.
 */

test('every English key exists in Arabic', () => {
  const missing = Object.keys(en).filter((key) => !(key in ar));
  assert.deepEqual(
    missing,
    [],
    'Arabic is the source of truth — these English keys have no Arabic string',
  );
  // Arabic is also the fallback, so a non-empty Arabic dictionary is required.
  assert.ok(Object.keys(ar).length > 0, 'the Arabic dictionary must not be empty');
});

test('a missing key falls back to the key, never to undefined', () => {
  const key = 'this.key.does.not.exist';

  // No language given — the default path.
  const value = t(key);
  assert.equal(value, key, 'a missing key must return the key itself');
  assert.notEqual(value, undefined, 'a missing key must never be undefined');
  assert.notEqual(value, '', 'a missing key must never be an empty string');

  // And in every declared language, explicitly.
  for (const lang of LANGS) {
    assert.equal(t(key, lang), key, `missing key must fall back to the key in "${lang}"`);
  }
});

test('Arabic is the default language', () => {
  const key = 'sign_in.title';

  assert.equal(LANGS[0], 'ar', 'Arabic must be the first (default) language');
  assert.equal(t(key), t(key, 'ar'), 'calling t with no language must use Arabic');
  assert.equal(t(key), ar[key], "the default language's value must be the Arabic string");

  // Make the assertion meaningful: Arabic and English actually differ here.
  assert.notEqual(t(key, 'ar'), t(key, 'en'), 'this key must differ between Arabic and English');
  assert.equal(t(key, 'en'), en[key]);
});
