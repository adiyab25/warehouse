import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT } from '../harness/sql.ts';

/**
 * A regression guard for the sign-in screens being LEGIBLE.
 *
 * The defect this file guards: Tailwind's preflight zeroes every border and
 * makes controls transparent, and globals.css added no border/background — so a
 * form field rendered as a label with floating text and no box to type into.
 *
 * This reads the shared stylesheet (the ONE place a field's look is defined; see
 * the "SHARED FORM CONTROLS" block in globals.css) and asserts the base `input`
 * rule declares a border AND a background. Remove either from that rule and this
 * test fails — which is exactly the regression it exists to catch. It checks the
 * CSS source, not a rendered pixel: see the report for the screenshot evidence
 * that the stylesheet actually paints.
 */

const css = readFileSync(join(REPO_ROOT, 'src', 'app', 'globals.css'), 'utf8');
// Strip comments so a rule mentioned only in prose cannot satisfy an assertion.
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
// Selectors must not contain `{`, `}` or `;`, so a rule cannot swallow a
// preceding at-statement (e.g. `@import "tailwindcss";`).
const blocks: { selector: string; body: string }[] = [
  ...withoutComments.matchAll(/([^{};]+)\{([^{}]*)\}/g),
].map((m) => ({ selector: m[1].trim(), body: m[2].trim() }));

/** The first rule whose selector list contains exactly `sel`. */
function ruleFor(sel: string) {
  return blocks.find((b) => b.selector.split(',').map((s) => s.trim()).includes(sel));
}

test('a text field is visibly bordered and given a background', () => {
  const input = ruleFor('input');
  assert.ok(input, 'globals.css must define a rule for the `input` element');
  assert.match(
    input.body,
    /border\s*:\s*[^;]*solid/,
    'the input rule must set a visible (solid) border — without it a field is invisible',
  );
  assert.match(
    input.body,
    /background(-color)?\s*:/,
    'the input rule must set a background — without it a field is invisible on the page',
  );
});

test('a focused field shows a focus ring', () => {
  const focus = blocks.find((b) => /:focus/.test(b.selector));
  assert.ok(focus, 'globals.css must define a focus state for controls');
  assert.match(
    focus.body,
    /outline\s*:|box-shadow\s*:/,
    'the focus state must draw a ring (outline or box-shadow)',
  );
});

test('a button reads as a button (filled background and a border)', () => {
  const button = ruleFor('button');
  assert.ok(button, 'globals.css must define a rule for the `button` element');
  assert.match(button.body, /background(-color)?\s*:/, 'the button rule must set a background');
  assert.match(button.body, /border\s*:/, 'the button rule must set a border');
});

// The machine-read-field class must stay exactly as it is — the direction fix is
// load-bearing for barcode/SKU entry and must not be collateral damage.
test('the .ltr-value rule is preserved unchanged', () => {
  const ltr = ruleFor('.ltr-value');
  assert.ok(ltr, 'globals.css must keep the .ltr-value rule');
  assert.equal(
    ltr.body.replace(/\s+/g, ' ').trim(),
    'direction: ltr; text-align: left; unicode-bidi: plaintext;',
  );
});
