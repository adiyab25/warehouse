import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BARCODE_HEIGHT_MM,
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  VARIANT_NAME_BUDGET,
  locationLabelSvg,
  truncateName,
  variantLabelSvg,
} from '../../src/domain/labels.ts';

/**
 * The printable label, as a contract on its SVG source.
 *
 * Three properties are asserted over and over, because they are the three ways a
 * thermal label is ruined and they are all invisible to a type checker:
 *
 *   * the BARCODE and the SKU are both on the sticker, from the raw values;
 *   * a long Arabic name is ELLIPSISED, never allowed to push the layout — the
 *     root geometry and the barcode block are byte-identical for a 3-char and an
 *     80-char name;
 *   * the Arabic is drawn RTL and the machine-read value LTR, in separate text
 *     nodes, so a Latin SKU inside an RTL run cannot be re-ordered.
 */

const BASE = { nameAr: 'كرتونة', sku: 'AB-0012', barcode: 'AB-0012' };

/** The whole opening `<svg …>` tag. */
function rootTag(svg: string): string {
  const m = /<svg[^>]*>/.exec(svg);
  assert.ok(m, 'the label must open with an <svg> tag');
  return m[0];
}

/** The declared height of the barcode BLOCK rect. */
function barcodeRectHeight(svg: string): string {
  const m = /<rect class="barcode-area"[^>]*height="([^"]+)"/.exec(svg);
  assert.ok(m, `no barcode rect in:\n${svg}`);
  return m[1]!;
}

/** The text content of the first element carrying `class="…"`. */
function textContent(svg: string, cls: string): string {
  const m = new RegExp(`<text class="${cls}"[^>]*>([^<]*)</text>`).exec(svg);
  assert.ok(m, `no .${cls} text in:\n${svg}`);
  return m[1]!;
}

test('the variant label contains the barcode and the SKU', () => {
  const svg = variantLabelSvg(BASE);

  assert.match(svg, /AB-0012/, 'the SKU must be printed');
  // bwip-js draws the code as <path> bar runs; their presence is the barcode.
  assert.match(svg, /<path[^>]*stroke="#000000"/, 'the barcode bars must be drawn');
  assert.match(svg, /class="barcode-area"/, 'the code must sit in the barcode block');

  // The Arabic headline is on the sticker too.
  assert.match(svg, /كرتونة/);
});

test('the size and colour are printed when present, and omitted when absent', () => {
  const withAttrs = variantLabelSvg({ ...BASE, size: 'L', colour: 'أحمر' });
  assert.match(withAttrs, /L · أحمر/, 'size and colour are printed joined');

  const without = variantLabelSvg(BASE);
  assert.doesNotMatch(without, /label-attrs/, 'no size/colour ⇒ no attributes line');
});

test('a long Arabic name is ellipsised, not overflowing', () => {
  const long = 'ا'.repeat(80);
  const svg = variantLabelSvg({ ...BASE, nameAr: long });

  const shown = textContent(svg, 'label-name');
  assert.ok(shown.endsWith('…'), `the name must end with the ellipsis character (got ${shown})`);
  assert.equal(
    Array.from(shown).length,
    VARIANT_NAME_BUDGET + 1,
    'it must be the budget plus the one ellipsis character',
  );
  assert.ok(!svg.includes(long), 'the untruncated 80-char name must never reach the SVG');

  // ...and the label's GEOMETRY is untouched by the long name.
  assert.equal(
    rootTag(svg),
    rootTag(variantLabelSvg({ ...BASE, nameAr: 'كرتونة' })),
    'the root geometry must not change with the name length',
  );
});

test('the barcode area keeps a fixed height when the name wraps', () => {
  const short = variantLabelSvg({ ...BASE, nameAr: 'كرتونة' });
  const long = variantLabelSvg({ ...BASE, nameAr: 'ا'.repeat(80) });

  assert.equal(
    barcodeRectHeight(short),
    barcodeRectHeight(long),
    'the barcode block height must be identical for a short and a long name',
  );
  assert.equal(barcodeRectHeight(short), String(BARCODE_HEIGHT_MM));
});

test('an unknown/empty barcode value never produces an empty svg', () => {
  assert.throws(
    () => variantLabelSvg({ nameAr: 'كرتونة', sku: 'AB-0012', barcode: '' }),
    /barcode/,
    'an empty barcode must THROW so the route can answer 400',
  );
  assert.throws(
    () => variantLabelSvg({ nameAr: 'كرتونة', sku: 'AB-0012', barcode: '   ' }),
    /barcode/,
    'a blank barcode must THROW too',
  );
  assert.throws(
    () => locationLabelSvg({ nameAr: 'الفرع', code: '' }),
    /code/,
    'an empty location code must THROW',
  );
});

test('both labels render right-to-left text sensibly', () => {
  const variant = variantLabelSvg({ ...BASE, nameAr: 'كرتونة كبيرة' });
  const location = locationLabelSvg({ nameAr: 'الرف أ', code: 'BIN-A1' });

  for (const svg of [variant, location]) {
    assert.match(svg, /كرتونة كبيرة|الرف أ/, 'the Arabic run is present');
    assert.match(svg, /direction="rtl"/, 'the Arabic run declares RTL');
    assert.match(
      rootTag(svg),
      /font-family="[^"]*Arabic/i,
      'the svg must declare an Arabic-capable font stack',
    );
  }

  // The machine-read values live in their OWN LTR-isolated text nodes — a Latin
  // SKU inside the RTL run is exactly what gets re-ordered.
  assert.match(variant, /class="label-sku"[^>]*direction:ltr;unicode-bidi:isolate/);
  assert.match(location, /class="label-code"[^>]*direction:ltr;unicode-bidi:isolate/);
});

test('the label is 50x30mm by default and honours an override', () => {
  const def = variantLabelSvg(BASE);
  assert.match(def, new RegExp(`width="${LABEL_WIDTH_MM}mm" height="${LABEL_HEIGHT_MM}mm"`));
  assert.match(def, /viewBox="0 0 50 30"/);

  const big = variantLabelSvg({ ...BASE, widthMm: 100, heightMm: 60 });
  assert.match(big, /width="100mm" height="60mm"/);
  assert.match(big, /viewBox="0 0 100 60"/);
});

test('truncateName does not split a code point', () => {
  // A character outside the BMP (a surrogate pair in UTF-16).
  const astral = '𝔸';
  const cut = truncateName(astral.repeat(30), 5);
  assert.equal(Array.from(cut).length, 6, 'five code points plus the ellipsis');
  assert.ok(!cut.includes('\uFFFD'), 'no broken surrogate half survives');
  assert.equal(truncateName('قصير', 22), 'قصير', 'a name that fits is returned untouched');
});
