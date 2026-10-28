import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { langFromAcceptLanguage } from '../../src/i18n/request.ts';

// The browser-language detection: English/Arabic out of an Accept-Language
// header, everything else null (the caller falls back to Arabic).
test('langFromAcceptLanguage picks the first supported language', () => {
  assert.equal(langFromAcceptLanguage('en-GB,en;q=0.9,ar;q=0.8'), 'en');
  assert.equal(langFromAcceptLanguage('ar-EG,ar;q=0.9'), 'ar');
  assert.equal(langFromAcceptLanguage('ar;q=0.9,en;q=0.8'), 'ar', 'order matters — the first one wins');
});

test('langFromAcceptLanguage is case- and whitespace-insensitive, and drops quality', () => {
  assert.equal(langFromAcceptLanguage(' EN-us ,  Ar ;q=0.5'), 'en');
  assert.equal(langFromAcceptLanguage('de-DE, EN;q=0.9, ar;q=0.8'), 'en');
});

test('langFromAcceptLanguage returns null for unsupported or absent input', () => {
  assert.equal(langFromAcceptLanguage('fr-FR,de;q=0.9'), null, 'French is not English/Arabic');
  assert.equal(langFromAcceptLanguage(null), null);
  assert.equal(langFromAcceptLanguage(undefined), null);
  assert.equal(langFromAcceptLanguage(''), null);
  assert.equal(langFromAcceptLanguage('zh,es'), null);
});

// Direction and language are declared ONCE, in the root layout, from the
// resolved language — a page hardcoding `dir` would fight the switch.
test('the root layout declares language and direction from the request', () => {
  const layout = readFileSync(join(process.cwd(), 'src', 'app', 'layout.tsx'), 'utf8');
  assert.match(layout, /getRequestLang\(\)/, 'the layout resolves the request language');
  assert.match(layout, /<html lang=\{lang\} dir=\{DIRECTION\[lang\]\}/, 'the html element carries lang and dir from the resolved language');
});