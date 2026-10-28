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
 * ---- THE THREE RULES THAT KEEP A THERMAL LABEL PRINTABLE --------------------
 *
 * (1) GEOMETRY IS FIXED. The root `<svg>` is `width="50mm" height="30mm"` (or a
 *     caller's override) with a matching `viewBox`. NOTHING a caller passes —
 *     least of all a long Arabic name — may change those numbers, or one label
 *     prints at a different physical size from the next. {@link BARCODE_HEIGHT}
 *     is the same: the barcode block occupies a constant rect whose height is a
 *     property of the label, never of the text beside it. Both are asserted by
 *     tests that render a short name and an 80-character one and compare the
 *     geometry byte for byte.
 *
 * (2) TEXT NEVER OVERFLOWS ITS BAND. A name longer than its band is truncated by
 *     a defined, named budget ({@link VARIANT_NAME_BUDGET} / {@link
 *     LOCATION_NAME_BUDGET}) and closed with a single ellipsis — so a long name
 *     is READABLE-AS-TRUNCATED rather than drawn under the barcode. Truncation
 *     counts CODE POINTS (`Array.from`), never UTF-16 units, so a surrogate pair
 *     (or any astral character) is never split into two broken halves.
 *
 * (3) MACHINE-READ VALUES ARE ISOLATED FROM ARABIC. Arabic is right-to-left; an
 *     SKU (`AB-0012`) is not, and letting a Latin run sit inside an RTL
 *     paragraph is how it renders reversed or with its hyphen parked on the
 *     wrong side. The Arabic runs therefore carry `direction="rtl"`, and every
 *     machine-read value (the SKU, the location code) sits in its OWN `<text>`
 *     with `direction:ltr;unicode-bidi:isolate` — the SVG equivalent of the
 *     app's `.ltr-value` class. The barcode is drawn from the raw value, not the
 *     displayed text, so what is printed is what is encoded.
 *
 * The barcode itself is bwip-js (`code128`) — never a hand-rolled encoder: a
 * subtly wrong module pattern scans as a DIFFERENT code, which is worse than no
 * label at all. bwip-js emits a whole `<svg>`; {@link barcodeBlock} lifts its
 * viewBox and body out and re-homes them inside the fixed block, so the code
 * keeps its own module geometry while the BLOCK stays a constant rect.
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
 * label (see {@link scale}) so an override keeps the same proportions, but it
 * never depends on the name.
 */
export const BARCODE_HEIGHT_MM = 12;

/**
 * How many characters of a VARIANT (item) name fit the default label width.
 *
 * The item name is the largest text on the sticker, on one line; at ~3.4 mm the
 * usable 46 mm band holds roughly two dozen Arabic characters. Longer input is
 * truncated to this budget and closed with `…`. A named constant rather than a
 * magic number so the budget is a label decision, reviewable in one place.
 */
export const VARIANT_NAME_BUDGET = 22;

/**
 * How many characters of a LOCATION name fit its (slightly larger) band.
 *
 * The location name is set larger than the item name, so its budget is smaller.
 */
export const LOCATION_NAME_BUDGET = 18;

/**
 * The font stack every Arabic run is drawn with.
 *
 * Named, Arabic-capable families FIRST — `Noto Naskh Arabic` and `Amiri` are the
 * shape a printed label is expected to carry — with `Tahoma` (present on
 * Windows, the deployment target) as the pragmatic fallback. The stack is
 * declared on the ROOT `<svg>` so it is a property of the document, not of one
 * text node, and a test asserts it names an Arabic face.
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

/**
 * Truncates `name` to at most `budget` CODE POINTS, appending `…` when it had to
 * cut. Whitespace is trimmed first so a padded name does not waste the budget.
 *
 * Iterates code points (`Array.from`) rather than UTF-16 units so a character
 * outside the Basic Multilingual Plane is never sliced in half. Returns the name
 * unchanged when it already fits — no ellipsis on a name that was not cut.
 */
export function truncateName(name: string, budget: number): string {
  const trimmed = name.trim();
  const codePoints = Array.from(trimmed);
  if (codePoints.length <= budget) return trimmed;
  return `${codePoints.slice(0, budget).join('')}…`;
}

/**
 * The barcode BLOCK: a constant rect (the block's own geometry — the thing the
 * fixed-height test reads) with the bwip-js bar pattern fitted inside it.
 *
 * SCALED TO WIDTH, CLIPPED TO HEIGHT. The block is wide and short (46 x 12 mm);
 * a Code128 for a 7-character code is nearly 2:1 as tall as it is wide, so
 * "contain" fitting would shrink it to ~17 mm wide and leave a ~0.15 mm module —
 * below what a handheld reliably reads. Instead the code is scaled to the FULL
 * block width (a ~0.4 mm module) and what overflows the block's height is
 * CLIPPED by a clip path rather than squeezed: the bars are vertical lines, so
 * clipping their length leaves the code perfectly scannable — the scan line only
 * needs the bars to be present across its path, not their full nominal height.
 *
 * `barcode` is validated by the callers ({@link variantLabelSvg}), so an empty
 * value never reaches bwip-js; a genuinely invalid value makes bwip-js throw,
 * which is the correct, loud outcome.
 */
function barcodeBlock(barcode: string, x: number, y: number, w: number, h: number): string {
  // bwip-js emits a complete `<svg viewBox="0 0 W H" …>…</svg>`.
  const rendered = toSVG({ bcid: 'code128', text: barcode, includetext: false });

  const viewBox = /viewBox="0 0 ([0-9.]+) ([0-9.]+)"/.exec(rendered);
  if (!viewBox) {
    throw new Error(`labels: bwip-js produced no viewBox for barcode ${JSON.stringify(barcode)}`);
  }
  const boxW = Number(viewBox[1]);
  const body = rendered.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

  const scale = w / boxW;
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
    // scaled group directly would clip it in barcode units (2..48 ≈ the first
    // few mm). The untransformed outer `<g>` clips in LABEL millimetres; the
    // inner `<g>` does the scaling.
    `<g clip-path="url(#${clipId})">` +
    `<g transform="translate(${n(x)},${n(y)}) scale(${n(scale)})">${body}</g>` +
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

/** The input {@link variantLabelSvg} accepts. */
export interface VariantLabelInput {
  /** The item's Arabic display name — the human-readable headline. */
  nameAr: string;
  /** The variant's size, if it has one. */
  size?: string | null;
  /** The variant's colour, if it has one. */
  colour?: string | null;
  /** The stock-keeping code, printed as a machine-read value. */
  sku: string;
  /** The value actually ENCODED in the barcode (usually the same as the SKU). */
  barcode: string;
  /** Label width; defaults to {@link LABEL_WIDTH_MM} (50 mm). */
  widthMm?: number;
  /** Label height; defaults to {@link LABEL_HEIGHT_MM} (30 mm). */
  heightMm?: number;
}

/**
 * Renders the VARIANT label: barcode + Arabic item name + size/colour + SKU.
 *
 * Throws when `barcode` is blank: an empty barcode is not a label with a missing
 * code, it is a sticker that scans as nothing — the caller (the label route)
 * turns this into a 400 rather than serving a blank SVG.
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

  const name = escapeXml(truncateName(input.nameAr, VARIANT_NAME_BUDGET));

  const attrsParts = [input.size, input.colour]
    .map((v) => (v ?? '').trim())
    .filter((v) => v !== '');
  const attrs = attrsParts.join(' · ');

  const parts: string[] = [
    svgOpen(widthMm, heightMm),
    // The Arabic headline — its own RTL run, anchored to the RIGHT edge.
    //
    // ANCHOR SUBTLETY: for an RTL run the text's START is its RIGHT edge, so
    // `text-anchor="start"` pins the right edge at `x` and the run grows
    // leftward. `text-anchor="end"` would pin the LEFT edge there and let the
    // run overflow off the label — the exact bug a render caught.
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

  // The SKU: a machine-read value, isolated LTR from the Arabic above.
  parts.push(
    `<text class="label-sku" x="${n(margin)}" y="${n(Y(27.5))}" ` +
      `style="${LTR_STYLE}" direction="ltr" text-anchor="start" ` +
      `font-size="${n(Y(3))}" font-weight="700" letter-spacing="0.3">${escapeXml(input.sku)}</text>`,
  );

  parts.push('</svg>');
  return parts.join('');
}

/** The input {@link locationLabelSvg} accepts. */
export interface LocationLabelInput {
  /** The location's Arabic name — "الرف أ", "الفرع الجيزة". */
  nameAr: string;
  /** The location code, printed as a machine-read value and encoded in the code. */
  code: string;
  /** Label width; defaults to {@link LABEL_WIDTH_MM} (50 mm). */
  widthMm?: number;
  /** Label height; defaults to {@link LABEL_HEIGHT_MM} (30 mm). */
  heightMm?: number;
}

/**
 * Renders the LOCATION label: barcode + Arabic location name + its code.
 *
 * Throws when `code` is blank, for the same reason {@link variantLabelSvg} throws
 * on a blank barcode — a label that encodes nothing is not a label.
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

  const name = escapeXml(truncateName(input.nameAr, LOCATION_NAME_BUDGET));

  return (
    svgOpen(widthMm, heightMm) +
    // Barcode on top for a location — the sticker's whole job is to be scanned.
    barcodeBlock(input.code, margin, Y(3), contentW, Y(BARCODE_HEIGHT_MM)) +
    // The Arabic name — its own RTL run, anchored to the right edge (see the
    // anchor subtlety in variantLabelSvg).
    `<text class="label-name" x="${n(widthMm - margin)}" y="${n(Y(20.5))}" ` +
    `direction="rtl" text-anchor="start" font-size="${n(Y(4.2))}" font-weight="700">${name}</text>` +
    // The code — isolated LTR machine-read value.
    `<text class="label-code" x="${n(margin)}" y="${n(Y(27))}" ` +
    `style="${LTR_STYLE}" direction="ltr" text-anchor="start" ` +
    `font-size="${n(Y(3.2))}" font-weight="700" letter-spacing="0.3">${escapeXml(input.code)}</text>` +
    '</svg>'
  );
}
