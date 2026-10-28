/**
 * PRINTABLE LABEL GEOMETRY — pure functions, no database, no request.
 *
 * Two labels, both rendered to a standalone SVG a thermal printer can print on
 * a 50 x 30 mm sticker:
 *
 *   * {@link variantLabelSvg} — a barcode, the item's ARABIC name, its
 *     size/colour, and the SKU; stuck on the shelf edge facing the product.
 *   * {@link locationLabelSvg} — a barcode, the location's ARABIC name, and its
 *     code; stuck on the bin/shelf it names.
 *
 * ---- THE RULES THAT KEEP A THERMAL LABEL HONEST AND PRINTABLE --------------
 *
 * (1) GEOMETRY IS FIXED. The root `<svg>` is `width="50mm" height="30mm"` (or a
 *     caller's override) with a matching `viewBox`. NOTHING a caller passes —
 *     least of all a long Arabic name — may change those numbers, or one label
 *     prints at a different physical size from the next. {@link BARCODE_HEIGHT}
 *     is the same: the barcode block occupies a constant rect whose height is a
 *     property of the label, never of the text beside it.
 *
 * (2) THE PRINTED CODE AND THE ENCODED CODE ARE ONE STRING. The value handed to
 *     bwip-js is the very value drawn in the `.label-sku` / `.label-code` text
 *     node — there is no second, human-only spelling that could drift from the
 *     bars. And if that string cannot be shown IN FULL at the label's width the
 *     label is REFUSED (the domain throws, the route answers 400) rather than
 *     abbreviated: a sticker whose trailing digits are clipped by the viewport
 *     would send a person to the wrong record — worse than no sticker at all.
 *
 * (3) THE MODULE (bar) WIDTH IS A PHYSICAL CONSTANT, NOT A FUNCTION OF THE DATA.
 *     Each module is printed at a FIXED millimetre size
 *     ({@link PREFERRED_MODULE_MM}), so the code's WIDTH follows from its length
 *     and the code is CENTRED in the block. It is never scaled to fill the
 *     block — that made a 7-character code print at 0.46 mm/module and a
 *     22-character one at 0.17 mm, below what a cheap handheld reads. When a
 *     long code would need a module narrower than {@link MIN_MODULE_MM} the
 *     label is REFUSED (thrown here, 400 from the route).
 *
 * (4) THE QUIET ZONE IS REAL. ISO/IEC 15417 asks for >= 10 modules of white
 *     either side of a Code128 symbol, and bwip-js emits none of its own (its
 *     first bar starts at x=0 of its viewBox). The block is therefore inset so
 *     at least {@link QUIET_ZONE_MODULES} modules of blank label sit on each
 *     side; {@link code128Geometry} proves the inset fits.
 *
 * (5) TEXT NEVER OVERFLOWS ITS BAND — and truncation is by ESTIMATED WIDTH, not
 *     by a code-point count. A code-point budget tuned for Arabic (~0.55 em) let
 *     22 Latin capitals print ~50 mm across a 46 mm band, clipped by the SVG
 *     root with no ellipsis. {@link truncateToWidth} estimates each character's
 *     width (Arabic vs Latin vs digit vs space, at the run's font size), cuts
 *     until the estimate fits, and appends `…`. SVG cannot measure text without
 *     a layout engine, so this is a deliberate ESTIMATE — {@link GLYPH_EM} is set
 *     CONSERVATIVELY (wider than measured), so a name it accepts does not
 *     overflow when a browser finally measures it. Truncation counts CODE POINTS
 *     (`Array.from`), so a surrogate pair is never split.
 *
 * (6) MACHINE-READ VALUES ARE ISOLATED FROM ARABIC. Arabic is right-to-left; an
 *     SKU (`AB-0012`) is not. The Arabic runs therefore carry `direction="rtl"`
 *     with `text-anchor="start"` — for an RTL run the START is the RIGHT edge,
 *     so the run is pinned to the right margin and grows leftward (an `end`
 *     anchor pins the LEFT edge there and lets the run overflow, the exact bug a
 *     render caught). Every machine-read value sits in its OWN `<text>` with
 *     `direction:ltr;unicode-bidi:isolate`.
 *
 * The barcode itself is bwip-js (`code128`) — never a hand-rolled encoder: a
 * subtly wrong module pattern scans as a DIFFERENT code. bwip-js emits a whole
 * `<svg>`; {@link barcodeBlock} lifts its viewBox and body out and re-homes them
 * inside the fixed block, so the code keeps its own module geometry while the
 * BLOCK stays a constant rect.
 */

import { toSVG } from 'bwip-js/node';

/** Default label width in millimetres — the physical sticker, not a suggestion. */
export const LABEL_WIDTH_MM = 50;

/** Default label height in millimetres. */
export const LABEL_HEIGHT_MM = 30;

/**
 * The barcode block's height, in millimetres, at the DEFAULT label size.
 *
 * A fixed number on purpose (rule (1)): the bars may be rescanned by a handheld
 * across a whole pallet, and a barcode that changed height with the length of
 * the item's name would scan differently label to label. It scales WITH the
 * label so an override keeps the same proportions, but it never depends on the
 * name.
 */
export const BARCODE_HEIGHT_MM = 12;

/**
 * The narrowest module (bar / narrow space) width a label may be printed at, in
 * millimetres. Below roughly this a cheap handheld stops resolving the bars
 * reliably, so a code that would need less is REFUSED rather than printed
 * unscannable (rule (3)).
 */
export const MIN_MODULE_MM = 0.25;

/**
 * The module width a label is PRINTED at whenever the code fits, in
 * millimetres — inside the ~0.33-0.4 mm sweet spot for a thermal sticker. The
 * X-dimension is fixed at this value, so a short code prints at exactly the same
 * bar size as another short code (rule (3)); only a code long enough to overflow
 * the block shrinks it, and never below {@link MIN_MODULE_MM}.
 */
export const PREFERRED_MODULE_MM = 0.33;

/** Modules of blank label required either side of the symbol (ISO/IEC 15417). */
export const QUIET_ZONE_MODULES = 10;

/**
 * bwip-js draws one module as this many viewBox units (its default `scale` of
 * 2). Code128 for `AB-0012` comes back with `viewBox="0 0 202 …"` — 101 modules
 * — and its widest bar is `stroke-width="4"` = 2 modules.
 */
const BWIP_UNITS_PER_MODULE = 2;

/**
 * Per-character width as a fraction of the font size (`em`), by script class.
 *
 * MEASURED, THEN ROUNDED UP. `getComputedTextLength` in Chromium, drawing in
 * this exact font stack at weight 700, reports a 26-capital run at 0.693 em, a
 * lowercase run at 0.571 em, a digit run at 0.637 em, an Arabic alphabet at
 * 0.647 em, and a deliberately mixed Arabic/Latin run at 0.710 em. Every
 * constant here is at or ABOVE its measurement, because the estimate must be
 * conservative (rule (5)): a run this function accepts must not overflow when a
 * browser finally measures it.
 *
 * NOTE ON ARABIC: connected Arabic script has no single glyph width — an
 * isolated final `س` measures ~1.2 em where a medial `ا` is ~0.31 em — so the
 * constant is the measured AVERAGE across words, which is what a real name
 * resembles. A name built entirely from the widest `س ش ص ض` forms is the one
 * case an average-width estimate can under-read.
 */
export const GLYPH_EM = {
  /** Arabic letters (both names are Arabic). */
  arabic: 0.75,
  /** Latin capitals `A-Z` (bold). */
  latinUpper: 0.75,
  /** Latin lowercase `a-z`. */
  latinLower: 0.66,
  /** Digits `0-9` (bold). */
  digit: 0.68,
  /** The ASCII hyphen in a `PREFIX-SEQ`. */
  hyphen: 0.47,
  /** A space or a non-breaking space. */
  space: 0.33,
  /** The `…` a truncated run is closed with. */
  ellipsis: 1.05,
  /** Anything else — punctuation, `·`, an astral character. */
  other: 0.8,
} as const;

/** True for a code point in the Arabic / Arabic-supplement / presentation ranges. */
function isArabic(cp: number): boolean {
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

/** The `em` width of one code point, by its script class. */
function charEm(cp: number): number {
  if (cp >= 48 && cp <= 57) return GLYPH_EM.digit;
  if (cp >= 65 && cp <= 90) return GLYPH_EM.latinUpper;
  if (cp >= 97 && cp <= 122) return GLYPH_EM.latinLower;
  if (cp === 32 || cp === 0x00a0) return GLYPH_EM.space;
  if (cp === 45) return GLYPH_EM.hyphen;
  if (cp === 0x2026) return GLYPH_EM.ellipsis;
  if (isArabic(cp)) return GLYPH_EM.arabic;
  return GLYPH_EM.other;
}

/**
 * The font stack every Arabic run is drawn with.
 *
 * Named, Arabic-capable families FIRST — `Noto Naskh Arabic` and `Amiri` are the
 * shape a printed label is expected to carry — with `Tahoma` (present on
 * Windows, the deployment target) as the pragmatic fallback. Declared on the
 * ROOT `<svg>` so it is a property of the document, not of one text node, and a
 * test asserts it names an Arabic face.
 */
export const ARABIC_FONT_STACK = "'Noto Naskh Arabic','Amiri',Tahoma,'Segoe UI',Arial,sans-serif";

/** The inline direction/isolate style a machine-read (Latin) value carries. */
const LTR_STYLE = 'direction:ltr;unicode-bidi:isolate';

/** The reference geometry the layout is authored against; overrides scale it. */
const REF_WIDTH = 50;
const REF_HEIGHT = 30;

/** Rounds for the SVG source — 3 dp is far finer than a 0.1 mm printer dot. */
function n(value: number): number {
  return Number(value.toFixed(3));
}

/** XML-escapes text destined for a text node or attribute. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** How a text run is sized, for {@link estimateTextWidthMm} / {@link truncateToWidth}. */
export interface TextWidthOpts {
  /** The run's font size in millimetres (the label's own user unit). */
  fontSizeMm: number;
  /** The run's letter spacing in millimetres, if any. */
  letterSpacingMm?: number;
}

/**
 * ESTIMATED width of `text` in millimetres: the sum of per-character `em` widths
 * (see {@link GLYPH_EM}) at the run's font size, plus letter spacing.
 *
 * A deliberate estimate, not a measurement — SVG has no layout engine of its
 * own, so a domain function cannot ask how wide a string really is. {@link
 * GLYPH_EM} is conservative, so the estimate errs WIDE: a run this says fits
 * does not overflow when a browser measures it.
 */
export function estimateTextWidthMm(text: string, opts: TextWidthOpts): number {
  const ls = opts.letterSpacingMm ?? 0;
  let mm = 0;
  for (const cp of Array.from(text)) {
    mm += charEm(cp.codePointAt(0)!) * opts.fontSizeMm + ls;
  }
  return mm;
}

/**
 * Truncates `text` by ESTIMATED WIDTH to at most `maxMm`, appending a single `…`
 * when it had to cut; a run that already fits is returned untouched (rule (5)).
 *
 * Pure and self-contained. Iterates CODE POINTS (`Array.from`) so a character
 * outside the Basic Multilingual Plane is never sliced in half, and reserves the
 * ellipsis's own width before deciding the last kept character. Whitespace is
 * trimmed first so padding cannot masquerade as width.
 */
export function truncateToWidth(text: string, maxMm: number, opts: TextWidthOpts): string {
  const trimmed = text.trim();
  if (estimateTextWidthMm(trimmed, opts) <= maxMm) return trimmed;
  const ellipsis = '…';
  const ellipsisMm = estimateTextWidthMm(ellipsis, opts);
  if (ellipsisMm > maxMm) return '';
  let kept = '';
  for (const cp of Array.from(trimmed)) {
    if (estimateTextWidthMm(kept + cp, opts) + ellipsisMm > maxMm) break;
    kept += cp;
  }
  return kept + ellipsis;
}

/** Renders `code` with bwip-js and returns its module count and inner SVG body. */
function renderCode128(code: string): { modules: number; body: string } {
  const rendered = toSVG({ bcid: 'code128', text: code, includetext: false });
  const viewBox = /viewBox="0 0 ([0-9.]+) ([0-9.]+)"/.exec(rendered);
  if (!viewBox) {
    throw new Error(`labels: bwip-js produced no viewBox for barcode ${JSON.stringify(code)}`);
  }
  const modules = Number(viewBox[1]) / BWIP_UNITS_PER_MODULE;
  const body = rendered.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return { modules, body };
}

/** The Code128 module (bar) count bwip-js produces for `code`. */
export function code128ModuleCount(code: string): number {
  return renderCode128(code).modules;
}

/** The physical geometry a code is drawn with inside a block of `blockWidthMm`. */
export interface Code128Geometry {
  /** Total number of modules (bars + narrow spaces) in the symbol. */
  modules: number;
  /** The module (narrow bar) width actually used, in millimetres. */
  moduleMm: number;
  /** The drawn symbol width (`modules * moduleMm`), in millimetres. */
  codeWidthMm: number;
  /** The blank label on each side once the code is centred, in millimetres. */
  quietZoneMm: number;
}

/**
 * The geometry for printing `code` inside a `blockWidthMm`-wide block.
 *
 * FIXED X-DIMENSION, FLOORED (rule (3)): the module is {@link
 * PREFERRED_MODULE_MM} whenever the code plus its two {@link
 * QUIET_ZONE_MODULES}-module quiet zones fit; otherwise it shrinks to exactly
 * fill the block (`blockWidthMm / (modules + 2 * QUIET_ZONE_MODULES)`), which
 * holds the quiet zone at the 10-module minimum. If even that is below {@link
 * MIN_MODULE_MM} the code cannot be printed legibly and this THROWS — the caller
 * (the label route) turns that into a 400.
 */
export function code128Geometry(code: string, blockWidthMm: number): Code128Geometry {
  const modules = renderCode128(code).modules;
  const fitModuleMm = blockWidthMm / (modules + 2 * QUIET_ZONE_MODULES);
  const moduleMm = Math.min(PREFERRED_MODULE_MM, fitModuleMm);
  if (moduleMm < MIN_MODULE_MM) {
    const neededMm = (modules + 2 * QUIET_ZONE_MODULES) * MIN_MODULE_MM;
    throw new Error(
      `labels: code ${JSON.stringify(code)} is ${modules} modules wide and needs about ` +
        `${n(neededMm)}mm at the ${MIN_MODULE_MM}mm minimum module, but the label only ` +
        `offers ${n(blockWidthMm)}mm`,
    );
  }
  return {
    modules,
    moduleMm,
    codeWidthMm: modules * moduleMm,
    quietZoneMm: (blockWidthMm - modules * moduleMm) / 2,
  };
}

/**
 * The barcode BLOCK: a constant rect (the block's own geometry — the thing the
 * fixed-height test reads) with the bwip-js bar pattern printed at a fixed
 * module width and CENTRED inside it (rules (3), (4)).
 *
 * The bars are drawn at their true module size and clipped in LENGTH by the
 * block height (the bars are vertical lines, so clipping their length leaves the
 * code perfectly scannable). The block's remaining width is quiet zone: at least
 * {@link QUIET_ZONE_MODULES} modules on each side, proven by {@link
 * code128Geometry}.
 */
function barcodeBlock(barcode: string, x: number, y: number, w: number, h: number): string {
  const { modules, moduleMm } = code128Geometry(barcode, w);
  const { body } = renderCode128(barcode);

  const scale = moduleMm / BWIP_UNITS_PER_MODULE;
  // CENTRED: the leftover width is split evenly, so the quiet zone is symmetric.
  const xOffset = x + (w - modules * moduleMm) / 2;

  // A per-geometry clip id, so two labels inlined in one document (a contact
  // sheet, a test harness) do not clip each other.
  const clipId = `barcode-clip-${n(x)}x${n(y)}`;

  // The rect is the block's FIXED geometry (fill/stroke none — it frames, it
  // does not ink). Its width/height are read by the tests that prove the block
  // does not move with the name.
  return (
    `<clipPath id="${clipId}">` +
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/></clipPath>` +
    `<rect class="barcode-area" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ` +
    `fill="none" stroke="none"/>` +
    // The CLIP wraps the SCALED group from OUTSIDE: a `clip-path` is resolved in
    // the coordinate system of the element that REFERENCES it, so clipping the
    // scaled group directly would clip it in barcode units. The untransformed
    // outer `<g>` clips in LABEL millimetres; the inner `<g>` does the scaling.
    `<g clip-path="url(#${clipId})">` +
    `<g transform="translate(${n(xOffset)},${n(y)}) scale(${n(scale)})">${body}</g>` +
    `</g>`
  );
}

/** The shared `<svg>` opener, so both labels agree on namespace and font stack. */
function svgOpen(widthMm: number, heightMm: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${n(widthMm)}mm" height="${n(heightMm)}mm" ` +
    `viewBox="0 0 ${n(widthMm)} ${n(heightMm)}" ` +
    `font-family="${ARABIC_FONT_STACK}">`
  );
}

/**
 * Guards a machine-read code against being clipped: the printed string and the
 * encoded string are the SAME, so if it cannot be shown in full at `bandMm` the
 * label is refused (rule (2)) rather than abbreviated.
 */
function assertCodeFitsBand(code: string, bandMm: number, opts: TextWidthOpts): void {
  const widthMm = estimateTextWidthMm(code, opts);
  if (widthMm > bandMm) {
    throw new Error(
      `labels: code ${JSON.stringify(code)} needs about ${n(widthMm)}mm at a ` +
        `${opts.fontSizeMm}mm font but the printable band is only ${n(bandMm)}mm — ` +
        `refusing rather than printing a clipped code`,
    );
  }
}

/** The input {@link variantLabelSvg} accepts. */
export interface VariantLabelInput {
  /** The item's Arabic display name — the human-readable headline. */
  nameAr: string;
  /** The variant's size, if it has one. */
  size?: string | null;
  /** The variant's colour, if it has one. */
  colour?: string | null;
  /** The code — PRINTED as the machine-read value AND encoded in the barcode. */
  barcode: string;
  /** Label width in mm; a test-only seam — {@link LABEL_WIDTH_MM} in the app. */
  widthMm?: number;
  /** Label height in mm; a test-only seam — {@link LABEL_HEIGHT_MM} in the app. */
  heightMm?: number;
}

/**
 * Renders the VARIANT label: barcode + Arabic item name + size/colour + code.
 *
 * Throws when the code is blank, when it cannot be shown in full at the label's
 * width, or when it cannot be printed at the module floor — the caller (the
 * label route) turns each into a 400 rather than serving a sticker nobody can
 * trust.
 */
export function variantLabelSvg(input: VariantLabelInput): string {
  if (typeof input.barcode !== 'string' || input.barcode.trim() === '') {
    throw new Error('variantLabelSvg: barcode is required and must not be blank');
  }

  const widthMm = input.widthMm ?? LABEL_WIDTH_MM;
  const heightMm = input.heightMm ?? LABEL_HEIGHT_MM;

  // Authored against 50 x 30 and scaled to the requested sticker, so an override
  // preserves the layout's proportions rather than reflowing it.
  const sx = widthMm / REF_WIDTH;
  const sy = heightMm / REF_HEIGHT;
  const X = (v: number) => v * sx;
  const Y = (v: number) => v * sy;

  const margin = X(2);
  const contentW = widthMm - 2 * margin;

  const name = escapeXml(truncateToWidth(input.nameAr, contentW, { fontSizeMm: Y(3.4) }));

  const attrsParts = [input.size, input.colour]
    .map((v) => (v ?? '').trim())
    .filter((v) => v !== '');
  const attrs = truncateToWidth(attrsParts.join(' · '), contentW, { fontSizeMm: Y(2.6) });

  const codeFontMm = Y(3);
  assertCodeFitsBand(input.barcode, contentW, {
    fontSizeMm: codeFontMm,
    letterSpacingMm: X(0.3),
  });

  const parts: string[] = [
    svgOpen(widthMm, heightMm),
    // The Arabic headline — its own RTL run, anchored to the RIGHT edge.
    //
    // ANCHOR SUBTLETY: for an RTL run the text's START is its RIGHT edge, so
    // `text-anchor="start"` pins the right edge at `x` and the run grows
    // leftward. `end` would pin the LEFT edge there and let the run overflow
    // off the label — the exact bug a render caught.
    `<text class="label-name" x="${n(widthMm - margin)}" y="${n(Y(6))}" ` +
      `direction="rtl" text-anchor="start" font-size="${n(Y(3.4))}" font-weight="700">${name}</text>`,
  ];

  if (attrs !== '') {
    parts.push(
      `<text class="label-attrs" x="${n(widthMm - margin)}" y="${n(Y(9.6))}" ` +
        `direction="rtl" text-anchor="start" font-size="${n(Y(2.6))}">${escapeXml(attrs)}</text>`,
    );
  }

  // The barcode BLOCK: fixed rect, independent of the name above it.
  parts.push(barcodeBlock(input.barcode, margin, Y(11.5), contentW, Y(BARCODE_HEIGHT_MM)));

  // The code: the SAME string the bars encode, isolated LTR from the Arabic.
  parts.push(
    `<text class="label-sku" x="${n(margin)}" y="${n(Y(27.5))}" ` +
      `style="${LTR_STYLE}" direction="ltr" text-anchor="start" ` +
      `font-size="${n(codeFontMm)}" font-weight="700" letter-spacing="${n(X(0.3))}">${escapeXml(input.barcode)}</text>`,
  );

  parts.push('</svg>');
  return parts.join('');
}

/** The input {@link locationLabelSvg} accepts. */
export interface LocationLabelInput {
  /** The location's Arabic name — "الرف أ", "الفرع الجيزة". */
  nameAr: string;
  /** The code — printed as a machine-read value AND encoded in the code. */
  code: string;
  /** Label width in mm; a test-only seam — {@link LABEL_WIDTH_MM} in the app. */
  widthMm?: number;
  /** Label height in mm; a test-only seam — {@link LABEL_HEIGHT_MM} in the app. */
  heightMm?: number;
}

/**
 * Renders the LOCATION label: barcode + Arabic location name + its code.
 *
 * Throws when the code is blank, when it cannot be shown in full at the label's
 * width, or when it cannot be printed at the module floor — for the same reasons
 * {@link variantLabelSvg} does.
 */
export function locationLabelSvg(input: LocationLabelInput): string {
  if (typeof input.code !== 'string' || input.code.trim() === '') {
    throw new Error('locationLabelSvg: code is required and must not be blank');
  }

  const widthMm = input.widthMm ?? LABEL_WIDTH_MM;
  const heightMm = input.heightMm ?? LABEL_HEIGHT_MM;

  const sx = widthMm / REF_WIDTH;
  const sy = heightMm / REF_HEIGHT;
  const X = (v: number) => v * sx;
  const Y = (v: number) => v * sy;

  const margin = X(2);
  const contentW = widthMm - 2 * margin;

  const name = escapeXml(truncateToWidth(input.nameAr, contentW, { fontSizeMm: Y(4.2) }));

  const codeFontMm = Y(3.2);
  assertCodeFitsBand(input.code, contentW, {
    fontSizeMm: codeFontMm,
    letterSpacingMm: X(0.3),
  });

  return (
    svgOpen(widthMm, heightMm) +
    // Barcode on top for a location — the sticker's whole job is to be scanned.
    barcodeBlock(input.code, margin, Y(3), contentW, Y(BARCODE_HEIGHT_MM)) +
    // The Arabic name — its own RTL run, anchored to the right edge (see the
    // anchor subtlety in variantLabelSvg).
    `<text class="label-name" x="${n(widthMm - margin)}" y="${n(Y(20.5))}" ` +
    `direction="rtl" text-anchor="start" font-size="${n(Y(4.2))}" font-weight="700">${name}</text>` +
    // The code — the same string the bars encode, isolated LTR.
    `<text class="label-code" x="${n(margin)}" y="${n(Y(27))}" ` +
    `style="${LTR_STYLE}" direction="ltr" text-anchor="start" ` +
    `font-size="${n(codeFontMm)}" font-weight="700" letter-spacing="${n(X(0.3))}">${escapeXml(input.code)}</text>` +
    '</svg>'
  );
}
