import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  LANGS,
  ar,
  en,
  formatCurrency,
  formatDate,
  formatNumber,
  hasKey,
  plural,
  t,
} from '@/i18n/index';
import { REPO_ROOT } from '../../harness/sql.ts';

/**
 * The i18n shell has the properties four screens are about to lean on:
 *
 *   (1) Arabic is COMPLETE — every English key has an Arabic string, so a
 *       screen rendered in the default language never falls through to a raw
 *       key. English is the secondary language; Arabic is the source of truth.
 *   (2) A MISSING key degrades safely. `t` must return the KEY itself — never
 *       `undefined`, never `''` — so a missing string shows up as a visible,
 *       searchable token instead of the word "undefined" on the page or an
 *       empty label.
 *   (3) Arabic is the DEFAULT and the FALLBACK. Calling `t` with no language
 *       must render Arabic, and a key that exists ONLY in Arabic must still
 *       render it when another language is asked for — the fallback branch is
 *       load-bearing, and this file would otherwise stay green without it.
 *   (4) NUMERALS ARE LATIN, in every language, through every formatter —
 *       Arabic-Indic digits never match a printed barcode, an SKU or a receipt.
 *   (5) PLURALS ARE CATEGORIES. Arabic has six CLDR forms; a screen must be
 *       able to say صنفان (two) and {count} صنفًا (eleven) differently.
 *   (6) A key used in CODE but missing from the DICTIONARIES is detectable
 *       ({@link hasKey}), and this file fails if one is.
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

  // `hasKey` is the question `t` cannot answer: which keys really exist.
  assert.equal(hasKey(key), false, 'hasKey must say a missing key is missing');
  assert.equal(hasKey('sign_in.title'), true, 'hasKey must say a present key is present');
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

test('a key that exists ONLY in Arabic falls back to Arabic in every other language', () => {
  // These are real Arabic-only keys: the CLDR plural forms Arabic needs and
  // English does not (English has `one` and `other`; Arabic also needs `zero`,
  // `two`, `few` and `many`). Without the Arabic-fallback branch in `t`, each of
  // these returns the KEY ITSELF — which is exactly what the assertions below
  // would catch.
  const arOnlyKeys = ['cart.items.zero', 'cart.items.two', 'cart.items.few', 'cart.items.many'];

  for (const key of arOnlyKeys) {
    assert.equal(hasKey(key, 'ar'), true, `${key} must exist in Arabic`);
    assert.equal(hasKey(key, 'en'), false, `${key} is deliberately English-free`);
    assert.notEqual(ar[key], undefined, `${key} must have a real Arabic string`);

    assert.equal(
      t(key, 'en'),
      ar[key],
      `a key missing in English must fall back to its ARABIC string (${key})`,
    );
    assert.notEqual(t(key, 'en'), key, `the fallback must not hand back the raw key (${key})`);
  }
});

test('numbers, money and dates always use LATIN digits, in both languages', () => {
  const ARABIC_INDIC = /[\u0660-\u0669\u06f0-\u06f9]/;

  const numbers = [0, 1234.5, -98.25, 1_000_000];
  for (const lang of LANGS) {
    for (const value of numbers) {
      const rendered = formatNumber(value, lang);
      assert.doesNotMatch(
        rendered,
        ARABIC_INDIC,
        `formatNumber(${value}, '${lang}') must not contain Arabic-Indic digits (got ${rendered})`,
      );
      assert.match(rendered, /[0-9]/, 'a number must contain 0-9 digits');
    }

    const money = formatCurrency(1234.5, lang);
    assert.doesNotMatch(
      money,
      ARABIC_INDIC,
      `formatCurrency must not contain Arabic-Indic digits (got ${money})`,
    );
    assert.match(money, /EGP|ج\.م/, `formatCurrency must name EGP (got ${money})`);
    assert.match(money, /1[,٬]?234/);

    const date = formatDate(new Date(Date.UTC(2026, 0, 15)), lang);
    assert.doesNotMatch(
      date,
      ARABIC_INDIC,
      `formatDate must not contain Arabic-Indic digits (got ${date})`,
    );
    assert.match(date, /2026/, 'a date must contain the 4-digit year in Latin digits');
  }

  // The control that makes the assertions above meaningful: the BARE `ar-EG`
  // locale really does render Arabic-Indic digits, which is why the module pins
  // `ar-EG-u-nu-latn` instead of trusting the tag.
  const arabicIndic = new Intl.NumberFormat('ar-EG').format(1234.5);
  assert.match(
    arabicIndic,
    ARABIC_INDIC,
    'the bare ar-EG locale is expected to render Arabic-Indic digits — that is the hazard',
  );
});

test('several counts, several Arabic forms — and English gets by with two', () => {
  // `plural(keyBase, count)` selects the CLDR category with Intl.PluralRules
  // and looks up `<keyBase>.<category>`, so the six Arabic forms are reachable.
  const arForms = new Map([
    [0, ar['cart.items.zero']],
    [1, ar['cart.items.one']],
    [2, ar['cart.items.two']],
    [3, ar['cart.items.few']],
    [11, ar['cart.items.many']],
    [100, ar['cart.items.other']],
  ]);

  for (const [count, expected] of arForms) {
    assert.equal(
      plural('cart.items', count),
      expected?.replace('{count}', String(count)),
      `plural('cart.items', ${count}) must use the Arabic form for that category`,
    );
  }

  // Two and eleven must be DIFFERENT strings — a flat dictionary could not say
  // this, which is the whole reason the helper exists.
  assert.notEqual(plural('cart.items', 2), plural('cart.items', 11));

  // English: one and other only, with {count} interpolated.
  assert.equal(plural('cart.items', 1, { lang: 'en' }), 'There is 1 item in the basket.');
  assert.equal(plural('cart.items', 7, { lang: 'en' }), 'There are 7 items in the basket.');
});

test('interpolation is by NAME, and an unknown placeholder stays visible', () => {
  assert.equal(
    t('home.signed_in_as', { params: { name: 'أحمد علي' } }),
    'مسجَّل الدخول باسم أحمد علي.',
  );
  assert.equal(
    t('home.signed_in_as', { lang: 'en', params: { name: 'Ahmed' } }),
    'Signed in as Ahmed.',
  );

  // A typo in a template shows up as a visible {token} rather than vanishing.
  assert.equal(
    t('home.signed_in_as', { lang: 'en', params: { nam: 'x' } }),
    'Signed in as {name}.',
  );
});

test('a key used in the app but missing from the dictionaries is detectable', () => {
  // Walk src/, collect every literal key handed to t()/plural(), and ask
  // hasKey whether the dictionary really has it. This is the guard the review
  // asked for: a screen that says t('home.typo') runs fine and renders the raw
  // key, and nothing else would notice.
  const files = [
    'src/app/page.tsx',
    'src/app/layout.tsx',
    'src/app/(auth)/sign-in/page.tsx',
    'src/app/(auth)/sign-in/contract.ts',
    'src/app/sign-out/route.ts',
    'src/app/intake/page.tsx',
    'src/modules/receiving/ui/IntakeScreen.tsx',
    'src/modules/receiving/ui/ExpectedVsReceived.tsx',
    'src/modules/shell/ui/ScanField.tsx',
    'src/app/requisitions/page.tsx',
    'src/app/requisitions/[id]/page.tsx',
    'src/modules/requisitions/ui/RequisitionListScreen.tsx',
    'src/modules/requisitions/ui/RequisitionDetailScreen.tsx',
    'src/app/stock/page.tsx',
    'src/app/stock/[variantId]/page.tsx',
    'src/app/stock/usage/page.tsx',
    'src/modules/ledger/ui/StockListScreen.tsx',
    'src/modules/ledger/ui/StockHistoryScreen.tsx',
    'src/modules/branch-usage/ui/StockUsageScreen.tsx',
    'src/app/(app)/reports/page.tsx',
    'src/modules/reports/ui/ReplenishmentScreen.tsx',
    'src/proxy.ts',
    'src/i18n/index.ts',
  ];

  const used = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) used.set(match[1], file);
    for (const match of source.matchAll(/\bplural\(\s*'([^']+)'/g)) {
      used.set(`${match[1]}.other`, file);
    }
  }

  assert.ok(used.size > 0, 'the scan must actually find keys — an empty scan proves nothing');

  const missing = [...used.entries()]
    .filter(([key]) => !hasKey(key, 'ar'))
    .map(([key, file]) => `${key} (used in ${file})`);

  assert.deepEqual(missing, [], 'these keys are referenced in code but absent from the Arabic dictionary');
});
