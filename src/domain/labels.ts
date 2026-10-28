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
 *     a layout engine, so this is a deliberate ESTIMATE — the per-character
 *     widths are MEASURED across the label's whole font stack and kept per code
 *     point in {@link MEASURED_EM}, over a per-class fallback that is itself at
 *     or above the widest measurement of its class ({@link GLYPH_EM}), so a name
 *     it accepts does not overflow when a browser finally measures it.
 *     Truncation counts CODE POINTS (`Array.from`), so a surrogate pair is never
 *     split.
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
 * Per-character width as a fraction of the font size (`em`), by script class —
 * the FALLBACK for a code point whose own width was not measured. Every
 * constant here is at or ABOVE the widest measurement of its class, because the
 * estimate must be conservative (rule (5)): a run this function accepts must
 * not overflow when a browser finally measures it.
 *
 * MEASURED ACROSS THE WHOLE CHARACTER SET, NOT PER LETTER. The widths were
 * taken with Chromium's `getComputedTextLength` / canvas `measureText` at
 * 100 px, at BOTH weights 400 and 700, over EVERY font of {@link
 * ARABIC_FONT_STACK} that resolves on the measurement box (Tahoma, Segoe UI,
 * Arial — `Noto Naskh Arabic` and `Amiri` are not installed there, so the stack
 * falls through to Tahoma for Arabic and the widest of the three for Latin),
 * and the MAXIMUM of all of them was kept per code point. Enumerating a handful
 * of letters is exactly how a width bug survived two rounds: `W` measures 1.028
 * em and `M` 0.958 em on Tahoma at weight 700 (Segoe UI: 1.005 / 0.958; Arial:
 * 0.944 / 0.833), and several further capitals (`N` 0.790, `G/H/K/O/Q` 0.778,
 * `D` 0.757) and symbols (`%` 1.199, `@` 1.016, `&` 0.850) exceed the old 0.75
 * / 0.66 / 0.80 constants too. Every measured code point above its class floor
 * now lives in {@link MEASURED_EM}, so nothing measured is under-read and the
 * per-class constants below only ever serve a code point that was NOT measured.
 *
 * THE FOUR WIDEST ARABIC LETTERS ARE MEASURED AS WIDEST FORMS, NOT AVERAGED.
 * Connected Arabic has no single glyph width, so a per-run average is right for
 * a mixed name — but the four letters `س ش ص ض` are wide EVEN WHEN CONNECTED.
 * Measured in the label's font stack, /100px: an isolated `س`/`ش` is 1.402 em
 * and an isolated `ص`/`ض` is 1.421 em; a fully connected run `سشصض` still
 * averages 1.178 em per character. Averaging them into the 0.647 em alphabet
 * figure under-read a name built from them by more than a factor of two — such
 * a name rendered ~15 mm off a 46 mm band, i.e. CLIPPED. They therefore take
 * their own constant, {@link GLYPH_EM.arabicWide}: 1.45 em, the widest measured
 * form (1.421 em) rounded up with ~2% of head-room. Every other Arabic letter
 * keeps the alphabet AVERAGE (0.75 em), which is what a real (mixed, CONNECTED)
 * name resembles; the widest measured connected run of any other letter
 * (`ج/ح/خ`) averages 0.754 em, inside the 0.97 truncation head-room.
 *
 * OVER-ESTIMATION IS DELIBERATE. `arabic` deliberately stays a connected-run
 * AVERAGE rather than each letter's (much wider) isolated width: a lone letter
 * can never fill a 46 mm band, only a long connected run can, so the average is
 * conservative where it matters and ordinary Arabic is estimated ~20-30% early.
 * That is the SAFE direction — a name cut short is readable; a name clipped off
 * the label is not — and the constants are NOT relaxed to win characters back.
 */
export const GLYPH_EM = {
  /** Arabic letters (both names are Arabic) in their connected-run average. */
  arabic: 0.75,
  /**
   * The four widest Arabic letters — `س` (U+0633), `ش` (U+0634), `ص` (U+0635),
   * `ض` (U+0636) — in their WIDEST connected form. Their isolated form measures
   * 1.402-1.421 em and their connected run 1.178 em; 1.45 em covers both.
   */
  arabicWide: 1.45,
  /**
   * Arabic PRESENTATION FORMS (`U+FB50-U+FDFF`, `U+FE70-U+FEFF`) — single
   * glyphs that stand for a letter or a whole word. Measured up to 1.905 em for
   * a two-letter ligature and 6.881 em for `U+FDFD` (the Bismillah ligature),
   * so a letter-level constant cannot cover them; 2.0 em clears every one but
   * the one phrase-ligature kept in {@link MEASURED_EM}.
   */
  arabicPresentation: 2.0,
  /** Latin capitals `A-Z` (bold) — the floor for one NOT in {@link MEASURED_EM}. */
  latinUpper: 0.75,
  /** Latin lowercase `a-z` — the floor for one NOT in {@link MEASURED_EM}. */
  latinLower: 0.66,
  /** Digits `0-9` (bold) — measured 0.637 em. */
  digit: 0.68,
  /** The ASCII hyphen in a `PREFIX-SEQ` — measured 0.431 em. */
  hyphen: 0.47,
  /** A space or a non-breaking space — measured 0.313 em. */
  space: 0.33,
  /** The `…` a truncated run is closed with — measured 1.000 em. */
  ellipsis: 1.05,
  /** Anything else — an astral character, an unmeasured symbol. */
  other: 0.8,
} as const;

/**
 * Measured per-character widths that EXCEED their class fallback above, keyed by
 * code point, as a fraction of the font size (`em`).
 *
 * Every value is the MAXIMUM Chromium reported for that code point across the
 * label's resolving font stack at weights 400 and 700 (see the {@link GLYPH_EM}
 * note), rounded UP to three decimals. The whole printable-ASCII range, the
 * digits, the punctuation the label prints (`· - : …`), the Arabic base block
 * and its supplements, and the Arabic presentation forms were all measured; only
 * the code points below came out wider than the fallback, so only they need an
 * entry — the fallbacks already cover everything else. Raw maxima, /100 px:
 *
 *   `W` 102.783 · `M` 95.703 · `N` 79.004 · `G/H/K/O/Q` 77.783 · `D` 75.732
 *   `m` 95.361 · `w` 88.965 · `%` 119.873 · `@` 101.514 · `&` 84.961
 *   `# + < = > ^ ~` 81.836 · `×` (U+00D7) 81.836 · `—` (U+2014) 100.0
 *   (nearest value left on the class floor: `B/V/X/Y` 72.217 · `h/n/u` 64.014 · digits 63.672)
 *
 * `U+FDFD` is the one Arabic presentation-form glyph wider than {@link
 * GLYPH_EM.arabicPresentation}; it is a single glyph for a whole phrase.
 */
export const MEASURED_EM: Readonly<Record<number, number>> = {
  0x23: 0.819, // '#'
  0x25: 1.199, // '%'
  0x26: 0.85, // '&'
  0x2b: 0.819, // '+'
  0x3c: 0.819, // '<'
  0x3d: 0.819, // '='
  0x3e: 0.819, // '>'
  0x40: 1.016, // '@'
  0x44: 0.757, // 'D'
  0x47: 0.778, // 'G'
  0x48: 0.778, // 'H'
  0x4b: 0.778, // 'K'
  0x4d: 0.958, // 'M'
  0x4e: 0.79, // 'N'
  0x4f: 0.778, // 'O'
  0x51: 0.778, // 'Q'
  0x57: 1.028, // 'W'
  0x5e: 0.819, // '^'
  0x6d: 0.954, // 'm'
  0x77: 0.89, // 'w'
  0x7e: 0.819, // '~'
  0xd7: 0.819, // '×'
  0x2014: 1.0, // '—'
  0xfdfd: 6.881, // the Bismillah ligature
};

/**
 * The widest Arabic letters, whose CONNECTED forms are still far wider than the
 * alphabet average, mapped to {@link GLYPH_EM.arabicWide}. See the GLYPH_EM
 * note: these are the letters a name of "all widest forms" is built from, and
 * the only ones an averaged estimate measurably under-read.
 */
const WIDE_ARABIC_CODEPOINTS = new Set([0x0633, 0x0634, 0x0635, 0x0636]);

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

/** The `em` width of one code point from its script class alone (no measurement). */
function charBlockEm(cp: number): number {
  if (cp >= 48 && cp <= 57) return GLYPH_EM.digit;
  if (cp >= 65 && cp <= 90) return GLYPH_EM.latinUpper;
  if (cp >= 97 && cp <= 122) return GLYPH_EM.latinLower;
  if (cp === 32 || cp === 0x00a0) return GLYPH_EM.space;
  if (cp === 45) return GLYPH_EM.hyphen;
  if (cp === 0x2026) return GLYPH_EM.ellipsis;
  // The four widest Arabic letters keep their WIDEST connected form; every
  // other Arabic letter uses the alphabet average.
  if (WIDE_ARABIC_CODEPOINTS.has(cp)) return GLYPH_EM.arabicWide;
  if (isArabic(cp)) return GLYPH_EM.arabic;
  return GLYPH_EM.other;
}

/**
 * The `em` width of one code point: its class fallback, or its own measured
 * maximum when that is wider (see {@link MEASURED_EM}). Keyed by code point and
 * deliberately never below the fallback, so measuring MORE can only ever make
 * the estimate wider — conservative, never a regression.
 */
function charEm(cp: number): number {
  // Arabic presentation forms get a wide constant (they are whole-glyph
  // ligatures, not letters) unless the one measured phrase-ligature is wider.
  if ((cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) {
    return Math.max(GLYPH_EM.arabicPresentation, MEASURED_EM[cp] ?? 0);
  }
  const measured = MEASURED_EM[cp];
  const fallback = charBlockEm(cp);
  return measured === undefined ? fallback : Math.max(fallback, measured);
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

/**
 * The fraction of a text band a truncated run may actually fill.
 *
 * A second safety margin, on top of the rounded-up {@link GLYPH_EM} constants
 * (rule (5)): per-character summing ignores kerning and the join-forming
 * ligatures of connected Arabic, so a real browser can draw a run a hair wider
 * than the sum. Holding back 3% of every TRUNCATED band means even that
 * second-order under-read stays inside the printable area. The machine-read
 * CODE band does NOT use it — a code is shown in full or the label is refused
 * (rule (2)), so it can never be clipped, and its constants already carry
 * ~7-8% of head-room.
 */
const TRUNCATE_SAFETY = 0.97;

/**
 * The Arabic prefix printed before the variant's INTERNAL code (its `sku`) when
 * that code differs from the barcode. "Internal code" — literally `sku` — is
 * deliberately distinct from the encoded value's own wording, so the two can
 * never be mistaken for each other on the sticker. Arabic-first, with the code
 * itself in Latin digits like every other machine-read value.
 */
const INTERNAL_CODE_LABEL = 'كود داخلي:';

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
 * Guards a machine-read string against being clipped: if it cannot be shown in
 * full at `bandMm` the label is refused (rule (2)) rather than abbreviated — a
 * truncated internal code would be as dangerous as a truncated barcode. `what`
 * names the thing refused (`code`, `internal code`) for the error message.
 */
function assertFitsBand(text: string, bandMm: number, opts: TextWidthOpts, what: string): void {
  const widthMm = estimateTextWidthMm(text, opts);
  if (widthMm > bandMm) {
    throw new Error(
      `labels: ${what} ${JSON.stringify(text)} needs about ${n(widthMm)}mm at a ` +
        `${opts.fontSizeMm}mm font but the printable band is only ${n(bandMm)}mm — ` +
        `refusing rather than printing a clipped ${what}`,
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
  /**
   * The variant's INTERNAL code (`item_variants.sku`), which the schema stores
   * separately from — and can differ from — {@link barcode}. When it differs
   * the label prints it on its OWN, clearly labelled line, so the product's
   * internal identity survives a barcode that has been scratched or worn off;
   * when it equals the barcode the line is omitted (the very same code is
   * already on the sticker, so a duplicate would only waste label space).
   *
   * It is NEVER handed to bwip-js: the scannable symbol encodes {@link barcode},
   * and only that value is drawn as the machine-read `.label-sku` line.
   */
  sku?: string | null;
  /** Label width in mm; a test-only seam — {@link LABEL_WIDTH_MM} in the app. */
  widthMm?: number;
  /** Label height in mm; a test-only seam — {@link LABEL_HEIGHT_MM} in the app. */
  heightMm?: number;
}

/** Vertical placement (reference mm) the variant layout is authored against. */
const VARIANT_LINES = {
  name: 6,
  attrs: 9.6,
  barcode: 10.5,
  internal: 25.1,
  code: 28.9,
} as const;

/**
 * Renders the VARIANT label: barcode + Arabic item name + size/colour + the
 * encoded code, plus — only when it differs — the internal code.
 *
 * Throws when the code is blank, when it cannot be shown in full at the label's
 * width, or when it cannot be printed at the module floor — the caller (the
 * label route) turns each into a 400 rather than serving a sticker nobody can
 * trust. The optional internal-code line is refused the same way if it cannot
 * be shown in full: a clipped identity code is as dangerous as a clipped
 * barcode.
 *
 * GEOMETRY IS INDEPENDENT OF THE INTERNAL LINE. The barcode block and the
 * name/attrs/code bands sit at FIXED positions whether or not the internal line
 * is present, so adding it can never push the encoded code off the label.
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
  // Truncated text bands hold back {@link TRUNCATE_SAFETY}; the code band does
  // not (it refuses rather than clips).
  const textBandW = contentW * TRUNCATE_SAFETY;

  const name = escapeXml(truncateToWidth(input.nameAr, textBandW, { fontSizeMm: Y(3.4) }));

  const attrsParts = [input.size, input.colour]
    .map((v) => (v ?? '').trim())
    .filter((v) => v !== '');
  const attrs = truncateToWidth(attrsParts.join(' · '), textBandW, { fontSizeMm: Y(2.6) });

  const codeFontMm = Y(3);
  assertFitsBand(input.barcode, contentW, {
    fontSizeMm: codeFontMm,
    letterSpacingMm: X(0.3),
  }, 'code');

  // The internal code: printed on its own labelled line ONLY when it differs
  // from the barcode. Comparing upper-cased (the schema stores both columns
  // canonicalised) means a mere case difference does not waste a line, and the
  // code printed is the value as stored.
  const skuLine = internalCodeLine(input.sku, input.barcode);
  if (skuLine !== null) {
    assertFitsBand(skuLine, contentW, { fontSizeMm: Y(2.2) }, 'internal code');
  }

  const parts: string[] = [
    svgOpen(widthMm, heightMm),
    // The Arabic headline — its own RTL run, anchored to the RIGHT edge.
    //
    // ANCHOR SUBTLETY: for an RTL run the text's START is its RIGHT edge, so
    // `text-anchor="start"` pins the right edge at `x` and the run grows
    // leftward. `end` would pin the LEFT edge there and let the run overflow
    // off the label — the exact bug a render caught.
    `<text class="label-name" x="${n(widthMm - margin)}" y="${n(Y(VARIANT_LINES.name))}" ` +
      `direction="rtl" text-anchor="start" font-size="${n(Y(3.4))}" font-weight="700">${name}</text>`,
  ];

  if (attrs !== '') {
    parts.push(
      `<text class="label-attrs" x="${n(widthMm - margin)}" y="${n(Y(VARIANT_LINES.attrs))}" ` +
        `direction="rtl" text-anchor="start" font-size="${n(Y(2.6))}">${escapeXml(attrs)}</text>`,
    );
  }

  // The barcode BLOCK: fixed rect, independent of the name above it AND of the
  // internal line below it.
  parts.push(barcodeBlock(input.barcode, margin, Y(VARIANT_LINES.barcode), contentW, Y(BARCODE_HEIGHT_MM)));

  // The INTERNAL code line — its own labelled row, above the encoded code and
  // visually distinct from it (smaller, italic, prefixed), so the two can never
  // be confused. RTL-anchored to the right like the Arabic runs; the Latin code
  // inside bides left of its Arabic label.
  if (skuLine !== null) {
    parts.push(
      `<text class="label-internal" x="${n(widthMm - margin)}" y="${n(Y(VARIANT_LINES.internal))}" ` +
        `direction="rtl" text-anchor="start" font-size="${n(Y(2.2))}" ` +
        `font-weight="400" font-style="italic">${escapeXml(skuLine)}</text>`,
    );
  }

  // The code: the SAME string the bars encode, isolated LTR from the Arabic.
  parts.push(
    `<text class="label-sku" x="${n(margin)}" y="${n(Y(VARIANT_LINES.code))}" ` +
      `style="${LTR_STYLE}" direction="ltr" text-anchor="start" ` +
      `font-size="${n(codeFontMm)}" font-weight="700" letter-spacing="${n(X(0.3))}">${escapeXml(input.barcode)}</text>`,
  );

  parts.push('</svg>');
  return parts.join('');
}

/**
 * The internal-code line to print, or `null` when there is nothing to print.
 *
 * `null` when the SKU is absent/blank, or when it equals the barcode (compared
 * upper-cased, matching the schema's canonical storage) — the identical case
 * keeps the single `.label-sku` line and does not waste space. Otherwise the
 * line is the Arabic label {@link INTERNAL_CODE_LABEL} followed by the code.
 * Exported so a test can assert the wording and the presence rule directly.
 */
export function internalCodeLine(sku: string | null | undefined, barcode: string): string | null {
  const value = (sku ?? '').trim();
  if (value === '') return null;
  if (value.toUpperCase() === barcode.trim().toUpperCase()) return null;
  return `${INTERNAL_CODE_LABEL} ${value}`;
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
  const textBandW = contentW * TRUNCATE_SAFETY;

  const name = escapeXml(truncateToWidth(input.nameAr, textBandW, { fontSizeMm: Y(4.2) }));

  const codeFontMm = Y(3.2);
  assertFitsBand(input.code, contentW, {
    fontSizeMm: codeFontMm,
    letterSpacingMm: X(0.3),
  }, 'code');

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
