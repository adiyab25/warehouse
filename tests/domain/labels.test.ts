import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toSVG } from 'bwip-js/node';

import {
  BARCODE_HEIGHT_MM,
  GLYPH_EM,
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  MIN_MODULE_MM,
  PREFERRED_MODULE_MM,
  QUIET_ZONE_MODULES,
  code128Geometry,
  code128ModuleCount,
  estimateTextWidthMm,
  locationLabelSvg,
  truncateToWidth,
  variantLabelSvg,
} from '../../src/domain/labels.ts';

/**
 * The printable label, as a contract on its SVG source.
 *
 * These assert the PHYSICAL properties a type checker cannot see:
 *
 *   * the printed code and the encoded code are the SAME string (the bar
 *     geometry is the bwip-js geometry for the printed value, not a constant);
 *   * the module (bar) width is a fixed physical size — not a function of the
 *     length of the code — and never below the floor;
 *   * there is a real quiet zone (>= 10 modules) either side of the bars;
 *   * a long name is truncated BY WIDTH and closed with `…`, never allowed to
 *     push the layout — the root geometry and the barcode block are
 *     byte-identical for a short and an 80-char name;
 *   * a code too long to show in full is REFUSED, not clipped;
 *   * the Arabic is drawn RTL anchored to its right edge and the machine-read
 *     value LTR, in separate text nodes.
 */

const BASE = { nameAr: 'كرتونة', barcode: 'AB-0012' };

/** The whole opening `<svg …>` tag. */
function rootTag(svg: string): string {
  const m = /<svg[^>]*>/.exec(svg);
  assert.ok(m, 'the label must open with an <svg> tag');
  return m[0];
}

/** The declared geometry of the barcode BLOCK rect. */
function barcodeRect(svg: string): { x: number; y: number; w: number; h: number } {
  const m = /<rect class="barcode-area" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(
    svg,
  );
  assert.ok(m, `no barcode rect in:\n${svg}`);
  return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
}

/** The barcode's scale transform: its origin (mm) and the bwip-units→mm scale. */
function barcodeTransform(svg: string): { x: number; y: number; scale: number } {
  const m = /<g transform="translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+)\)">/.exec(svg);
  assert.ok(m, `no barcode transform in:\n${svg}`);
  return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
}

/** The text content of the first element carrying `class="…"`. */
function textContent(svg: string, cls: string): string {
  const m = new RegExp(`<text class="${cls}"[^>]*>([^<]*)</text>`).exec(svg);
  assert.ok(m, `no .${cls} text in:\n${svg}`);
  return m[1]!;
}

/** The bar `<path>` element bwip-js renders for `code`. */
function bwipPath(code: string): string {
  const m = /<path[^>]*>/.exec(toSVG({ bcid: 'code128', text: code, includetext: false }));
  assert.ok(m, 'bwip-js produced no bar path');
  return m[0];
}

/** The bar `<path>` element inside a rendered label. */
function labelBarPath(svg: string): string {
  const m = /<path[^>]*>/.exec(svg);
  assert.ok(m, `no bar path in:\n${svg}`);
  return m[0];
}

// ---------------------------------------------------------------------------
// Critical 1 — the printed code and the encoded code are the SAME string.
// ---------------------------------------------------------------------------

test('the printed code and the encoded bars are the same value', () => {
  const svg = variantLabelSvg(BASE);

  // The text node shows the code …
  assert.equal(textContent(svg, 'label-sku'), 'AB-0012');
  // … and the bars ARE the bars bwip-js produces for that very code.
  assert.ok(
    svg.includes(bwipPath('AB-0012')),
    'the label must encode exactly the value it prints (this fails if the encoder is handed a constant)',
  );

  // A different code yields a different bar pattern AND a different text node.
  const other = variantLabelSvg({ ...BASE, barcode: 'AB-0013' });
  assert.notEqual(labelBarPath(other), labelBarPath(svg), 'distinct codes must encode distinctly');
  assert.equal(textContent(other, 'label-sku'), 'AB-0013');
  assert.ok(other.includes(bwipPath('AB-0013')));
});

test('a code too long to show in full is REFUSED, not clipped', () => {
  // 22 characters — the value the reviewer measured printing to 51.2 mm on a
  // 50 mm label, its trailing digits clipped by the viewport.
  const tooLong = 'PRODUCTPREFIX-00000042';
  assert.ok(
    estimateTextWidthMm(tooLong, { fontSizeMm: 3, letterSpacingMm: 0.3 }) > 46,
    'the fixture must genuinely exceed the 46 mm band',
  );

  assert.throws(
    () => variantLabelSvg({ ...BASE, barcode: tooLong }),
    (err: Error) => err.message.includes(tooLong) && /mm/.test(err.message),
    'a code that cannot be shown in full must throw, naming the code and the limit',
  );

  assert.throws(
    () => locationLabelSvg({ nameAr: 'الرف', code: tooLong }),
    (err: Error) => err.message.includes(tooLong),
    'the location label refuses a too-long code too',
  );

  // A code whose BARS would fit but whose TEXT would not — the pure
  // printed-code-width refusal. Twenty digits pack two-per-symbol, so the bars
  // are fine while the human-readable run overruns the band.
  const wideText = '00000000000000000000';
  assert.ok(
    code128Geometry(wideText, 46).moduleMm >= MIN_MODULE_MM,
    'the fixture bars must pass the module floor, or the width guard is not what refuses it',
  );
  assert.ok(
    estimateTextWidthMm(wideText, { fontSizeMm: 3, letterSpacingMm: 0.3 }) > 46,
    'the fixture text must exceed the band',
  );
  assert.throws(
    () => variantLabelSvg({ ...BASE, barcode: wideText }),
    /band/,
    'a code too wide to show in full must be refused for its WIDTH, not clipped',
  );
});

// ---------------------------------------------------------------------------
// Important 2 & 5 — fixed module width with a floor, and a real quiet zone.
// ---------------------------------------------------------------------------

test('a short code prints at the preferred module width, centred with a quiet zone', () => {
  const code = 'AB-0012';
  const svg = variantLabelSvg({ ...BASE, barcode: code });
  const block = barcodeRect(svg);
  const transform = barcodeTransform(svg);
  const geometry = code128Geometry(code, block.w);

  assert.ok(
    Math.abs(geometry.moduleMm - PREFERRED_MODULE_MM) < 1e-9,
    `a short code should print at ${PREFERRED_MODULE_MM}mm/module (got ${geometry.moduleMm})`,
  );

  // The rendered scale must agree with the geometry the domain computed.
  assert.ok(
    Math.abs(transform.scale * 2 - geometry.moduleMm) < 1e-3,
    'the rendered scale must match the module width the domain decided',
  );

  // CENTRED: the transform origin is the block's left edge plus half the slack.
  assert.ok(
    Math.abs(transform.x - (block.x + (block.w - geometry.codeWidthMm) / 2)) < 1e-3,
    'the code must be centred in the block',
  );

  // QUIET ZONE: at least 10 modules of blank label either side of the ink.
  const leftQuietMm = transform.x - block.x;
  const rightQuietMm = block.x + block.w - (transform.x + geometry.codeWidthMm);
  assert.ok(
    leftQuietMm >= QUIET_ZONE_MODULES * geometry.moduleMm - 1e-6,
    `left quiet zone ${leftQuietMm}mm is below ${QUIET_ZONE_MODULES} modules`,
  );
  assert.ok(
    rightQuietMm >= QUIET_ZONE_MODULES * geometry.moduleMm - 1e-6,
    `right quiet zone ${rightQuietMm}mm is below ${QUIET_ZONE_MODULES} modules`,
  );
  // ...and the outer edges are actually inside the block.
  assert.ok(transform.x >= block.x - 1e-9 && rightQuietMm > 0);
});

test('the module width is NOT inversely proportional to the code length', () => {
  const blockW = 46;
  const short = code128Geometry('AB-001', blockW); // 6 characters
  const longer = code128Geometry('AB-0012', blockW); // 7 characters

  // Both fit at the preferred width, so both print at the SAME module size —
  // the exact property scale-to-fill got wrong (it would print the longer code
  // proportionally narrower).
  assert.equal(short.moduleMm, PREFERRED_MODULE_MM);
  assert.equal(longer.moduleMm, PREFERRED_MODULE_MM);
  assert.notEqual(
    short.moduleMm,
    blockW / short.modules,
    'the module width must not be block/modules (the old scale-to-fill formula)',
  );
  // The code's WIDTH, not its module size, follows from its length.
  assert.ok(longer.codeWidthMm > short.codeWidthMm || longer.modules >= short.modules);
});

test('a code that would need a module below the floor is refused', () => {
  const long = 'PRODUCTPREFIX-00000042';
  assert.throws(
    () => code128Geometry(long, 46),
    (err: Error) => err.message.includes(long) && err.message.includes(String(MIN_MODULE_MM)),
    'a code needing a sub-floor module must throw, naming the code and the floor',
  );

  // A code short enough for the TEXT band but still too wide for the bars at the
  // floor — the label must refuse it for the MODULE reason alone.
  const wideBars = 'ABCDE-000000000';
  assert.ok(
    estimateTextWidthMm(wideBars, { fontSizeMm: 3, letterSpacingMm: 0.3 }) <= 46,
    'the fixture must fit the text band, so only the module floor can refuse it',
  );
  assert.throws(
    () => code128Geometry(wideBars, 46),
    /module/,
    'the module floor must refuse a code the text band would accept',
  );
  assert.throws(
    () => variantLabelSvg({ ...BASE, barcode: wideBars }),
    /module/,
    'and the label must surface the module refusal',
  );
});

test('the override keeps the module floor as well as the geometry', () => {
  const big = variantLabelSvg({ ...BASE, widthMm: 100, heightMm: 60 });
  assert.match(rootTag(big), /width="100mm" height="60mm"/);
  assert.match(big, /viewBox="0 0 100 60"/);

  const block = barcodeRect(big);
  const geometry = code128Geometry('AB-0012', block.w);
  assert.ok(
    geometry.moduleMm >= MIN_MODULE_MM,
    'the module floor must hold for an override too',
  );
  assert.ok(Math.abs(geometry.moduleMm - PREFERRED_MODULE_MM) < 1e-9);
});

// ---------------------------------------------------------------------------
// Important 3 & 4 — width-based truncation for every text band.
// ---------------------------------------------------------------------------

test('a long Arabic name is ellipsised and fits the band', () => {
  const long = 'ا'.repeat(80);
  const svg = variantLabelSvg({ ...BASE, nameAr: long });

  const shown = textContent(svg, 'label-name');
  assert.ok(shown.endsWith('…'), `the name must end with the ellipsis character (got ${shown})`);
  assert.ok(
    estimateTextWidthMm(shown, { fontSizeMm: 3.4 }) <= 46 + 1e-9,
    `the shown name must fit the 46 mm band (got ${estimateTextWidthMm(shown, { fontSizeMm: 3.4 })})`,
  );
  assert.ok(!svg.includes(long), 'the untruncated 80-char name must never reach the SVG');

  // ...and the label's GEOMETRY is untouched by the long name.
  assert.equal(
    rootTag(svg),
    rootTag(variantLabelSvg({ ...BASE, nameAr: 'كرتونة' })),
    'the root geometry must not change with the name length',
  );
});

test('a 22-character LATIN name is truncated by width and fits the band', () => {
  const latin = 'ABCDEFGHIJKLMNOPQRSTUV';
  const svg = variantLabelSvg({ ...BASE, nameAr: latin });
  const shown = textContent(svg, 'label-name');

  assert.ok(shown.endsWith('…'), `a 22-char Latin name must be ellipsised (got ${shown})`);
  assert.ok(
    estimateTextWidthMm(shown, { fontSizeMm: 3.4 }) <= 46 + 1e-9,
    'the shown Latin name must fit the band',
  );
  assert.ok(Array.from(shown).length < Array.from(latin).length, 'it must actually have been cut');
});

test('a mixed Arabic/Latin name is truncated by width and fits the band', () => {
  const mixed = 'ABCDEFGHIJKLMNOPقميصقطني';
  const svg = variantLabelSvg({ ...BASE, nameAr: mixed });
  const shown = textContent(svg, 'label-name');

  assert.ok(shown.endsWith('…'), `a long mixed name must be ellipsised (got ${shown})`);
  assert.ok(
    estimateTextWidthMm(shown, { fontSizeMm: 3.4 }) <= 46 + 1e-9,
    'the shown mixed name must fit the band',
  );
  assert.ok(!svg.includes(mixed), 'the untruncated mixed name must never reach the SVG');
});

test('the size/colour line is truncated to the band too', () => {
  const longColour = 'أحمر'.repeat(20);
  const svg = variantLabelSvg({ ...BASE, size: 'L', colour: longColour });
  const shown = textContent(svg, 'label-attrs');

  assert.ok(shown.endsWith('…'), `a long colour line must be ellipsised (got ${shown})`);
  assert.ok(
    estimateTextWidthMm(shown, { fontSizeMm: 2.6 }) <= 46 + 1e-9,
    'the shown attrs line must fit the band',
  );
  assert.ok(!svg.includes(longColour));
});

test('truncateToWidth is pure, code-point safe and conservative', () => {
  // A character outside the BMP (a surrogate pair in UTF-16).
  const astral = '𝔸';
  const cut = truncateToWidth(astral.repeat(30), 5, { fontSizeMm: 2 });
  assert.ok(cut.endsWith('…'), 'a cut run ends with the ellipsis');
  assert.ok(!cut.includes('\uFFFD'), 'no broken surrogate half survives');
  assert.equal(truncateToWidth('قصير', 46, { fontSizeMm: 3.4 }), 'قصير', 'a run that fits is untouched');
  assert.ok(estimateTextWidthMm(cut, { fontSizeMm: 2 }) <= 5 + 1e-9);

  // CONSERVATIVE: measured in Chromium's getComputedTextLength, in this label's
  // font stack at weight 700 — the estimate for each must be at least as wide.
  const measured: Array<[string, number]> = [
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 61.22],
    ['abcdefghijklmnopqrstuvwxyz', 50.5],
    ['0123456789', 21.66],
    ['ابتثجحخدذرزسشصضطظعغفقكلمنهوي', 61.64],
    ['mixقميصCOTTONقطني', 41.06],
    ['قميص قطني', 21.44],
    ['كرتونة', 10.13],
  ];
  for (const [sample, measuredMm] of measured) {
    const estimateMm = estimateTextWidthMm(sample, { fontSizeMm: 3.4 });
    assert.ok(
      estimateMm >= measuredMm,
      `estimate ${estimateMm}mm for ${JSON.stringify(sample)} must not be under the measured ${measuredMm}mm`,
    );
  }
});

// ---------------------------------------------------------------------------
// Geometry, emptiness and direction — the standing invariants.
// ---------------------------------------------------------------------------

test('the barcode area keeps a fixed height when the name wraps', () => {
  const short = variantLabelSvg({ ...BASE, nameAr: 'كرتونة' });
  const long = variantLabelSvg({ ...BASE, nameAr: 'ا'.repeat(80) });

  assert.equal(
    barcodeRect(short).h,
    barcodeRect(long).h,
    'the barcode block height must be identical for a short and a long name',
  );
  assert.equal(barcodeRect(short).h, BARCODE_HEIGHT_MM);
});

test('an empty code never produces a label', () => {
  assert.throws(
    () => variantLabelSvg({ nameAr: 'كرتونة', barcode: '' }),
    /barcode/,
    'an empty barcode must THROW so the route can answer 400',
  );
  assert.throws(
    () => variantLabelSvg({ nameAr: 'كرتونة', barcode: '   ' }),
    /barcode/,
    'a blank barcode must THROW too',
  );
  assert.throws(
    () => locationLabelSvg({ nameAr: 'الفرع', code: '' }),
    /code/,
    'an empty location code must THROW',
  );
});

test('both labels render right-to-left text anchored to the right edge', () => {
  const variant = variantLabelSvg({ ...BASE, nameAr: 'كرتونة كبيرة' });
  const location = locationLabelSvg({ nameAr: 'الرف أ', code: 'BIN-A1' });

  for (const svg of [variant, location]) {
    assert.match(svg, /كرتونة كبيرة|الرف أ/, 'the Arabic run is present');
    assert.match(svg, /direction="rtl"/, 'the Arabic run declares RTL');
    // ANCHOR: a render caught `end` pushing Arabic off the label; flipping the
    // anchor back must fail this assertion.
    assert.match(
      svg,
      /<text class="label-name"[^>]*text-anchor="start"/,
      'the RTL name must be anchored to its start (the right edge)',
    );
    assert.match(
      rootTag(svg),
      /font-family="[^"]*Arabic/i,
      'the svg must declare an Arabic-capable font stack',
    );
  }

  assert.match(variant, /class="label-sku"[^>]*direction:ltr;unicode-bidi:isolate/);
  assert.match(location, /class="label-code"[^>]*direction:ltr;unicode-bidi:isolate/);
});

test('the label is 50x30mm by default', () => {
  const def = variantLabelSvg(BASE);
  assert.match(def, new RegExp(`width="${LABEL_WIDTH_MM}mm" height="${LABEL_HEIGHT_MM}mm"`));
  assert.match(def, /viewBox="0 0 50 30"/);
  assert.equal(typeof GLYPH_EM.arabic, 'number');
});

test('two distinct codes produce two distinct labels', () => {
  const a = variantLabelSvg({ ...BASE, barcode: 'AB-0012' });
  const b = variantLabelSvg({ ...BASE, barcode: 'XY-9999' });
  assert.notEqual(a, b, 'different codes must not render byte-identical labels');
  assert.equal(textContent(a, 'label-sku'), 'AB-0012');
  assert.equal(textContent(b, 'label-sku'), 'XY-9999');
  assert.equal(code128ModuleCount('AB-0012') > 0, true);
});
