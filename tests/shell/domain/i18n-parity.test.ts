import assert from 'node:assert/strict';
import { test } from 'node:test';

import ar from '../../../src/i18n/ar.json';
import en from '../../../src/i18n/en.json';

/**
 * i18n PARITY (MAP §4.3): the two dictionaries must never drift apart.
 *
 * The rule as stated in MAP §4.3 is "ar.json and en.json have identical key
 * sets". This test enforces exactly that, with the ONE deliberate exception the
 * codebase makes: Arabic is the source of truth (and the fallback), so English
 * may NEVER hold a key Arabic lacks, while Arabic MAY hold a handful of keys
 * English does not need — the CLDR plural categories `zero`, `two`, `few`,
 * `many`. `Intl.PluralRules('en')` only ever selects `one` and `other`, so
 * `en.json` has no word for صنفان (two) or {count} صنفًا (eleven); Arabic does.
 *
 * What this test GUARDS, in both directions:
 *   * a key added to `en.json` but not `ar.json`  → fails (Arabic is the fallback,
 *     so an English-only key would render as the RAW KEY for Arabic users);
 *   * a key added to `ar.json` but not `en.json`   → fails UNLESS it is one of the
 *     four Arabic-only plural categories, so a translator who adds `stock.typo`
 *     to Arabic and forgets English cannot slip through.
 *
 * The comparison is RECURSIVE over nested objects (flattened to dotted paths),
 * so a future move to nested JSON dictionaries is compared leaf-by-leaf, not
 * just at the top level — today the files are flat, and `leafPaths` on a flat
 * object is exactly `Object.keys`.
 */

/** The CLDR plural categories Arabic needs that English's `Intl.PluralRules` never selects. */
const AR_ONLY_PLURAL_CATEGORIES = ['zero', 'two', 'few', 'many'] as const;

/**
 * Every dotted path to a leaf value, recursing into nested objects. For the
 * flat dictionaries this is `Object.keys`; for nested ones it is the fully
 * qualified key path (`cart.items.one`).
 */
function leafPaths(root: unknown, prefix = ''): string[] {
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return [];

  const paths: string[] = [];
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...leafPaths(value, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

/** The final dotted segment of a key path: `cart.items.two` → `two`. */
function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

test('ar.json and en.json have identical key sets, except the Arabic-only plural forms', () => {
  const arKeys = leafPaths(ar).sort();
  const enKeys = leafPaths(en).sort();

  // A degenerate comparison proves nothing: both dictionaries must be read and
  // both must be substantial, or "identical" is just "both empty".
  assert.ok(arKeys.length > 100, `expected a substantial Arabic dictionary, got ${arKeys.length} keys`);
  assert.ok(enKeys.length > 100, `expected a substantial English dictionary, got ${enKeys.length} keys`);

  const arSet = new Set(arKeys);
  const enSet = new Set(enKeys);

  const onlyInEn = enKeys.filter((key) => !arSet.has(key));
  const onlyInAr = arKeys.filter((key) => !enSet.has(key));

  // Direction 1 — English is a subset of Arabic. An English-only key would have
  // no Arabic string and no fallback, so an Arabic user would see the raw key.
  assert.deepEqual(
    onlyInEn,
    [],
    'every English key must exist in Arabic — these keys exist only in en.json',
  );

  // Direction 2 — the ONLY keys Arabic may hold that English does not are the
  // four CLDR plural categories. Anything else is translator drift.
  const strayAr = onlyInAr.filter(
    (key) => !AR_ONLY_PLURAL_CATEGORIES.includes(lastSegment(key) as never),
  );
  assert.deepEqual(
    strayAr,
    [],
    'the only Arabic-only keys allowed are the CLDR plural forms zero/two/few/many — ' +
      'these keys are missing from en.json',
  );

  // The exception must be REAL, not vacuous: Arabic actually carries the plural
  // forms, so a refactor that silently made the dictionaries literally identical
  // (and this branch untested) would still be noticed here.
  assert.ok(
    onlyInAr.length > 0,
    'expected Arabic to hold its CLDR plural forms (zero/two/few/many) that English omits',
  );
});
