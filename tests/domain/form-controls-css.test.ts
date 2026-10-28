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

// WIDTH BUDGET for the scanned product name (Task 13). The name is a
// right-to-left catalogue string in a fixed-width column; a long UNBROKEN token
// (no spaces, no hyphens) refuses to shrink (a flex item defaults to
// `min-width: auto`) and overflows the card, pushing the quantity inputs off the
// screen. This guard fails if either the shrink allowance or the break rule is
// removed. The rendered proof at 390px is in the report.
test('the scanned product name has a width budget (shrinks and breaks)', () => {
  const name = ruleFor('.intake-line-name');
  assert.ok(name, 'globals.css must define .intake-line-name');
  assert.match(
    name.body,
    /min-width\s*:\s*0\b/,
    'the name must be allowed to shrink below its longest word (min-width: 0)',
  );
  assert.match(
    name.body,
    /overflow-wrap\s*:\s*(anywhere|break-word)/,
    'a long unbroken name must be able to break (overflow-wrap: anywhere)',
  );

  const head = ruleFor('.intake-line-head');
  assert.ok(head, 'globals.css must define .intake-line-head');
  assert.match(
    head.body,
    /min-width\s*:\s*0\b/,
    'the flex container must be allowed to shrink too, or the item cannot break',
  );
});

// WIDTH BUDGET for the requisition line cells (Task 14). Each is an unbroken
// catalogue string — an Arabic name, a branch label, or a SKU — in a flex item on
// a 390px phone. A flex item defaults to `min-width: auto` and refuses to shrink
// below its longest token, so a pathologically long unbroken code overflows the
// card (the review measured `.req-line-code` at 458px on a 390px viewport before
// the fix). Every one of these cells must therefore be allowed to shrink
// (`min-width: 0`) and to break (`overflow-wrap: anywhere`); the rendered proof
// at 390px is in the report.
test('the requisition line cells have a width budget (shrink and break)', () => {
  for (const sel of ['.req-line-name', '.req-branch-name', '.req-line-code']) {
    const rule = ruleFor(sel);
    assert.ok(rule, `globals.css must define ${sel}`);
    assert.match(
      rule.body,
      /min-width\s*:\s*0\b/,
      `${sel} must be allowed to shrink below its longest word (min-width: 0)`,
    );
    assert.match(
      rule.body,
      /overflow-wrap\s*:\s*(anywhere|break-word)/,
      `${sel} must be able to break a long unbroken token (overflow-wrap: anywhere)`,
    );
  }

  const head = ruleFor('.req-line-head');
  assert.ok(head, 'globals.css must define .req-line-head');
  assert.match(
    head.body,
    /min-width\s*:\s*0\b/,
    'the requisition flex container must be allowed to shrink too, or its cells cannot break',
  );
});
