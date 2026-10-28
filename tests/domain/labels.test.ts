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
  internalCodeLine,
  locationLabelSvg,
  truncateToWidth,
  variantLabelSvg,
} from '../../src/domain/labels.ts';
import {
  FUZZ_BAND_MM,
  FUZZ_CASES,
  FUZZ_CHECKSUM_S,
  FUZZ_CHECKSUM_T,
  FUZZ_FONT_MM,
  FUZZ_PX_S,
  FUZZ_PX_T,
  FUZZ_SAFETY,
  fuzzChecksum,
  generateFuzzStrings,
} from './label-fuzz.fixture.ts';

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
    // THE TAIL the review asked for: a name built from NOTHING but the widest
    // `س ش ص ض` forms, and a realistic long product name. The averaged estimate
    // under-read the first (176mm drawn on a 46mm band) — the constant must now
    // clear it.
    ['سشصض'.repeat(12), 175.19],
    ['صندوق شحن شاش صيني', 43.08],
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

// ---------------------------------------------------------------------------
// FUZZ — measure the WORST pools, not hand-picked samples. A per-character
// constant that is under its Chromium measurement makes the estimate smaller
// than the baked render and turns this RED; a string the estimator accepts that
// then renders past 46 mm turns it RED too. The pools are widest-heavy, so the
// dangerous tail is generated by construction and cannot hide.
// ---------------------------------------------------------------------------

/** The label's name band: 46 mm content, held back by TRUNCATE_SAFETY. */
const FUZZ_BAND_INNER_MM = FUZZ_BAND_MM * FUZZ_SAFETY;

/** Tenths of a pixel at 100 px -> millimetres at the name font size. */
function fuzzMm(deciPxAt100: number): number {
  return (deciPxAt100 / 1000) * FUZZ_FONT_MM;
}

test('FUZZ: the width estimate never under-reads Chromium and nothing clips 46 mm', () => {
  const strings = generateFuzzStrings();
  const shown = strings.map((s) => truncateToWidth(s, FUZZ_BAND_INNER_MM, { fontSizeMm: FUZZ_FONT_MM }));

  let underEstimates = 0;
  let worstUnderMm = 0;
  let acceptedOverBand = 0;
  let truncatedOverBand = 0;
  let shownUnderEstimates = 0;
  let accepted = 0;
  let worstTruncatedMm = 0;

  for (let i = 0; i < strings.length; i++) {
    const estFull = estimateTextWidthMm(strings[i]!, { fontSizeMm: FUZZ_FONT_MM });
    const renderedFull = fuzzMm(FUZZ_PX_S[i]!);

    // (1) CONSERVATIVE: the estimate must be at least the width Chromium drew.
    if (estFull < renderedFull - 1e-9) {
      underEstimates += 1;
      worstUnderMm = Math.max(worstUnderMm, renderedFull - estFull);
    }
    // (2) A name the estimator ACCEPTS in full must not render past the band.
    if (estFull <= FUZZ_BAND_MM + 1e-9) {
      accepted += 1;
      if (renderedFull > FUZZ_BAND_MM + 1e-9) acceptedOverBand += 1;
    }
    // (3) The TRUNCATED name — the thing the label actually prints — must
    //     render inside the 46 mm band, measured in Chromium.
    const renderedShown = fuzzMm(FUZZ_PX_T[i]!);
    worstTruncatedMm = Math.max(worstTruncatedMm, renderedShown);
    if (renderedShown > FUZZ_BAND_MM + 1e-9) truncatedOverBand += 1;
    // (4) and the estimate must still be conservative for the SHOWN run.
    if (estimateTextWidthMm(shown[i]!, { fontSizeMm: FUZZ_FONT_MM }) < renderedShown - 1e-9) {
      shownUnderEstimates += 1;
    }
  }

  console.log(
    `FUZZ pools=${strings.length} accepted=${accepted} under-estimates=${underEstimates}` +
      ` (worst ${worstUnderMm.toFixed(3)} mm) accepted-over-46mm=${acceptedOverBand}` +
      ` truncated-over-46mm=${truncatedOverBand} shown-under-estimates=${shownUnderEstimates}` +
      ` worst-truncated=${worstTruncatedMm.toFixed(3)} mm`,
  );

  // The GENERATED set must be exactly the one Chromium measured: a drift in the
  // pools fails loudly here instead of silently measuring nothing (the hole the
  // old sample-keyed table left).
  assert.equal(strings.length, FUZZ_PX_S.length, 'the fuzz set must match the baked render count');
  assert.equal(fuzzChecksum(strings), FUZZ_CHECKSUM_S, 'the generated strings must hash to the baked sweep');

  // The two counts that must be ZERO, asserted before the truncation checksum so
  // a bad width constant reports its under-estimate count rather than a hash.
  assert.equal(underEstimates, 0, 'the estimate must never be narrower than what Chromium renders');
  assert.equal(acceptedOverBand, 0, 'a name the estimator accepts must fit the 46 mm band');

  // The TRUNCATED strings must be the very ones the sweep measured and drawn.
  assert.equal(fuzzChecksum(shown), FUZZ_CHECKSUM_T, 'the truncated strings must hash to the baked sweep');
  assert.equal(truncatedOverBand, 0, 'a truncated name must render inside the 46 mm band');
  assert.equal(shownUnderEstimates, 0, 'the estimate must be conservative for the shown run too');
});

/** The named cases the review measured, re-rendered in the same Chromium sweep. */
const REVIEW_CASES: Readonly<Record<string, string>> = {
  Wx40: 'W'.repeat(40),
  Mx40: 'M'.repeat(40),
  MWM: 'MWM '.repeat(10).trim(),
  WASHER: 'WWW WASHER WWW WASHER WWW',
  arabic: 'صندوق شحن شاش صيني',
  mixed: 'MWMسش صضMWM',
  // THE DEFECT: a name of nothing but ط / ظ, whose widest connected run (0.859
  // em) sat above the old 0.75 floor with no table entry — the estimate accepted
  // 16xط in full and Chromium drew it off the 46 mm band. The per-code-point
  // maximum now truncates it, and the shown run renders inside the band.
  taa16: 'ط'.repeat(16),
  dhaa16: 'ظ'.repeat(16),
  seen16: 'س'.repeat(16),
  fullwidth: '１'.repeat(8),
};

test('REVIEW: the Latin worst cases, the Arabic names and the ط/ظ/fullwidth defect cases render inside 46 mm', () => {
  for (const [name, full] of Object.entries(REVIEW_CASES)) {
    const baked = FUZZ_CASES[name]!;
    const shown = truncateToWidth(full, FUZZ_BAND_INNER_MM, { fontSizeMm: FUZZ_FONT_MM });
    // The label prints exactly the string the sweep measured.
    assert.equal(shown, baked.shown, `${name}: the label must print the baked string`);

    const renderedFull = fuzzMm(baked.full);
    const renderedShown = fuzzMm(baked.trunc);
    // The estimator is conservative for the full string and for the shown one…
    assert.ok(
      estimateTextWidthMm(full, { fontSizeMm: FUZZ_FONT_MM }) >= renderedFull - 1e-9,
      `${name}: estimate under-reads the full render`,
    );
    assert.ok(
      estimateTextWidthMm(shown, { fontSizeMm: FUZZ_FONT_MM }) >= renderedShown - 1e-9,
      `${name}: estimate under-reads the shown render`,
    );
    // …and what is printed is INSIDE the 46 mm band.
    assert.ok(
      renderedShown <= FUZZ_BAND_MM + 1e-9,
      `${name} renders ${renderedShown.toFixed(3)}mm, over the ${FUZZ_BAND_MM}mm band`,
    );
    // The label's own render for this case must agree with the sweep.
    const label = variantLabelSvg({ ...BASE, nameAr: full });
    assert.equal(textContent(label, 'label-name'), shown, `${name}: the label draws the measured string`);
  }
});

test('the widest Arabic letters carry a widest-form constant, not the average', () => {
  // س ش ص ض (U+0633..U+0636) — a name of "all widest forms" is made of these —
  // must estimate far wider than the alphabet average, or such a name is
  // accepted and then clipped (the defect the render caught).
  for (const cp of ['س', 'ش', 'ص', 'ض']) {
    const perCent = estimateTextWidthMm(cp, { fontSizeMm: 100 });
    assert.ok(
      perCent >= 140,
      `${JSON.stringify(cp)} estimates ${perCent}% of em; the widest measured form is ~142% and the alphabet average ~65%`,
    );
  }
  // …while the rest of the alphabet keeps the measured average.
  assert.ok(estimateTextWidthMm('ا', { fontSizeMm: 100 }) < 100, 'ا keeps the averaged width');
  assert.ok(GLYPH_EM.arabicWide > GLYPH_EM.arabic, 'the widest-form constant must exceed the average');
});

// ---------------------------------------------------------------------------
// The SKU: printed as its own labelled line ONLY when it differs from the
// barcode, and never allowed to move the barcode or the encoded code.
// ---------------------------------------------------------------------------

test('a variant whose SKU differs from its barcode prints a labelled internal-code line', () => {
  const svg = variantLabelSvg({ ...BASE, sku: 'INT-9999' });
  const line = textContent(svg, 'label-internal');
  assert.match(line, /كود داخلي/, 'the line is labelled in Arabic as the internal code');
  assert.match(line, /INT-9999/, 'the line carries the SKU value');
  assert.equal(internalCodeLine('INT-9999', 'AB-0012'), 'كود داخلي: INT-9999');
  // NOT a second naked code: it is italic, smaller and prefixed, and RTL like
  // the other Arabic runs — so it cannot be mistaken for the encoded value.
  assert.match(svg, /class="label-internal"[^>]*font-style="italic"/);
  assert.match(svg, /class="label-internal"[^>]*direction="rtl"/);
  assert.match(svg, /class="label-internal"[^>]*font-size="2.2"/);
  // The single machine-read code line is unchanged.
  assert.equal(textContent(svg, 'label-sku'), 'AB-0012');
});

test('the internal-code line is ABSENT when the SKU equals the barcode', () => {
  for (const sku of ['AB-0012', 'ab-0012', ' AB-0012 ', null, undefined]) {
    const svg = variantLabelSvg({ ...BASE, sku });
    assert.ok(
      !svg.includes('label-internal'),
      `no internal line should print for sku ${JSON.stringify(sku)} — it is the same code as the barcode`,
    );
  }
  assert.equal(internalCodeLine(null, 'AB-0012'), null);
  assert.equal(internalCodeLine('', 'AB-0012'), null);
  assert.equal(internalCodeLine('ab-0012', 'AB-0012'), null);
});

test('adding the internal-code line never moves the barcode or the encoded code', () => {
  const base = { ...BASE, nameAr: 'كرتونة كبيرة', size: 'L', colour: 'أحمر' };
  const without = variantLabelSvg(base);
  const withSku = variantLabelSvg({ ...base, sku: 'INT-9999' });

  // The with-SKU render is the without-SKU render PLUS exactly one internal line
  // — nothing else changed. Removing that line reproduces the other byte for
  // byte, so the barcode rect, the name/attrs bands and the code line are
  // provably in the same place.
  const stripped = withSku.replace(/<text class="label-internal"[^>]*>[^<]*<\/text>/, '');
  assert.equal(stripped, without, 'the internal line must not disturb any other band');
  assert.deepEqual(barcodeRect(withSku), barcodeRect(without), 'the barcode block must not move');

  const codeY = (s: string) => /<text class="label-sku"[^>]*y="([\d.]+)"/.exec(s)![1];
  assert.equal(codeY(withSku), codeY(without), 'the encoded code must keep its baseline');
  assert.equal(textContent(withSku, 'label-sku'), textContent(without, 'label-sku'));
});

test('an internal code too wide to show in full is refused, not clipped', () => {
  const long = 'INTERNAL-PREFIX-000000000000';
  assert.ok(
    estimateTextWidthMm(`كود داخلي: ${long}`, { fontSizeMm: 2.2 }) > 46,
    'the fixture must genuinely overflow the 46 mm band',
  );
  assert.throws(
    () => variantLabelSvg({ ...BASE, sku: long }),
    (err: Error) => /internal code/.test(err.message) && err.message.includes(long),
    'an internal code that will not fit must refuse the label, naming the code',
  );
});

test('a long LOCATION name is truncated by width too', () => {
  const long = 'الرف الجيزة الرئيسي الطويل جدا للاختبار والقياس';
  const svg = locationLabelSvg({ nameAr: long, code: 'BIN-A1' });
  const shown = textContent(svg, 'label-name');

  assert.ok(shown.endsWith('…'), `a long location name must be ellipsised (got ${shown})`);
  assert.ok(
    estimateTextWidthMm(shown, { fontSizeMm: 4.2 }) <= 46,
    'the shown location name must fit the band',
  );
  assert.ok(!svg.includes(long), 'the untruncated location name must never reach the SVG');

  // The mm Chromium drew for this exact shown run at 4.2 mm, from the SAME
  // bottom-up sweep as the fuzz fixture (see label-fuzz.fixture.ts).
  const LOCATION_RENDER_PX_AT_100: Record<string, number> = { 'الرف الجيزة ا…': 690.875 };
  const px = LOCATION_RENDER_PX_AT_100[shown];
  assert.ok(px !== undefined, `unmeasured location render ${JSON.stringify(shown)}`);
  assert.ok(
    (px! / 100) * 4.2 <= 46,
    `Chromium drew the location name at ${((px! / 100) * 4.2).toFixed(3)}mm, over the band`,
  );
});

// ---------------------------------------------------------------------------
// The TRUE longest code each shape can print — re-derived, and pinned.
// ---------------------------------------------------------------------------

test('the longest code each shape can print is accepted, one more is refused', () => {
  const band = 46;
  const opts = { fontSizeMm: 3, letterSpacingMm: 0.3 };

  // DIGITS-ONLY: 19 digits is the longest that fits BOTH the 46 mm text band
  // (44.460 mm) and the 0.25 mm module floor (0.261364 mm/module); the 20th
  // digit overruns the band (46.800 mm).
  const digits19 = '0'.repeat(19);
  const digits20 = '0'.repeat(20);
  assert.ok(estimateTextWidthMm(digits19, opts) <= band, '19 digits fit the text band');
  assert.ok(code128Geometry(digits19, band).moduleMm >= MIN_MODULE_MM, '19 digits clear the module floor');
  assert.doesNotThrow(
    () => variantLabelSvg({ ...BASE, barcode: digits19 }),
    '19 digits is the longest digits-only code that prints',
  );
  assert.ok(estimateTextWidthMm(digits20, opts) > band, '20 digits overflow the text band');
  assert.throws(() => variantLabelSvg({ ...BASE, barcode: digits20 }), /band/);

  // PREFIX-SEQ: with a two-letter prefix the longest accepted is 17 characters
  // ('AB-' + 14 digits, 0.261364 mm/module) — the 18th character overflows the
  // MODULE floor. The previous report's "19 chars" was the DIGITS figure, not
  // this shape's; a 19-character `PRODUCTPREFIX-…` never even reaches the band.
  const seq17 = 'AB-' + '0'.repeat(14);
  const seq18 = 'AB-' + '0'.repeat(15);
  assert.equal(seq17.length, 17);
  assert.doesNotThrow(
    () => variantLabelSvg({ ...BASE, barcode: seq17 }),
    'the longest PREFIX-SEQ code prints',
  );
  assert.throws(
    () => code128Geometry(seq18, band),
    /module/,
    'one more character overflows the module floor',
  );

  // The named `PRODUCTPREFIX-…` shape is refused at EVERY length: its 14-module
  // prefix already blows the module floor before the width guard is reached.
  assert.throws(() => variantLabelSvg({ ...BASE, barcode: 'PRODUCTPREFIX-0000' }), /module/);
});
