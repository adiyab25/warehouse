import arJson from './ar.json';
import enJson from './en.json';

/**
 * Internationalisation — Arabic-first.
 *
 * One flat key → string dictionary per language, loaded from JSON so a
 * translator (or a later tool) edits strings, not code. The app is Arabic-first
 * and right-to-left: Arabic is the DEFAULT language AND the FALLBACK. English
 * is secondary.
 *
 * The single rule that keeps screens from showing `undefined`: {@link t} NEVER
 * returns `undefined` and NEVER returns an empty string. If a key is missing in
 * the requested language it falls back to Arabic; if it is missing there too it
 * returns the KEY itself — a visible, greppable token beats a blank label or
 * the literal word "undefined" on screen. {@link hasKey} is how to ask whether a
 * key really exists (used by tests, and available as a dev assertion), because
 * `t` answers a question about a missing key by echoing it back.
 *
 * ---- FOUR DECISIONS THIS MODULE OWNS ----------------------------------------
 * They are made here, rather than in each screen, because four screens are
 * about to copy this layer and changing it later means touching all of them.
 *
 *   (1) NUMERALS ARE LATIN, ALWAYS. {@link formatNumber},
 *       {@link formatCurrency} and {@link formatDate} all format through ONE
 *       locale per language, and the Arabic one pins the numbering system to
 *       Latin (`ar-EG-u-nu-latn`). `Intl.NumberFormat('ar')` renders Latin
 *       digits while `'ar-EG'` renders Arabic-Indic ones (`١٬٢٣٤٫٥`), so
 *       leaving the locale to chance puts TWO numeral systems in one app — and
 *       Arabic-Indic digits never match a printed barcode, an SKU or a paper
 *       receipt, which is what this warehouse's screens are read against.
 *       Formatting through these helpers, never through a bare
 *       `new Intl.…Format`, is what keeps that true.
 *
 *   (2) PLURALS ARE CATEGORIES, NOT A COUNT. Arabic has SIX CLDR plural forms
 *       (zero, one, two, few, many, other) and a flat `t()` cannot express them,
 *       so a screen that tried would show one string for "two items" and for
 *       "eleven items". {@link plural} selects the category with
 *       `Intl.PluralRules` and looks up `<keyBase>.<category>`.
 *
 *   (3) INTERPOLATION IS NAMED. `t(key, { params })` replaces `{name}`
 *       placeholders BY NAME, so adding a value to a sentence does not add
 *       another positional argument to a signature every call site shares.
 *
 *   (4) THE OLD SIGNATURE STILL WORKS. `t(key)` and `t(key, 'en')` are
 *       unchanged, so no existing screen had to be rewritten to get (1)-(3).
 *
 * The shared RTL/LTR direction rule lives in src/app/globals.css; {@link
 * DIRECTION} exposes the per-language direction for markup (`<html dir=…>`).
 */

/** Every language the app ships. Arabic FIRST — index 0 is the default. */
export const LANGS = ['ar', 'en'] as const;

/** A supported language tag. */
export type Lang = (typeof LANGS)[number];

/** A flat key → string dictionary. */
export type Dictionary = Record<string, string>;

/** Values a template can be given for its `{placeholders}`. */
export type Params = Record<string, string | number>;

/** `t`'s second argument: a language, or a language plus named values. */
export interface TranslateOptions {
  lang?: Lang;
  params?: Params;
}

// Typed as a plain `Record<string, string>` rather than the JSON literal's
// inferred shape, so a look-up by an arbitrary key type-checks (and so a
// missing key is a runtime concern, handled below — not a compile error).
export const ar: Dictionary = arJson;
export const en: Dictionary = enJson;

/** The dictionaries, keyed by language. */
export const dictionaries: Record<Lang, Dictionary> = { ar, en };

/** The default (and fallback) language. */
export const DEFAULT_LANG: Lang = 'ar';

/** The writing direction each language renders in. */
export const DIRECTION: Record<Lang, 'rtl' | 'ltr'> = { ar: 'rtl', en: 'ltr' };

/**
 * The ONE locale per language every number and date goes through.
 *
 * The `-u-nu-latn` extension on the Arabic tag is the whole point: it keeps
 * Arabic month names, the Arabic currency symbol and `ar-EG` conventions while
 * pinning the DIGITS to 0-9. The bare `ar` tag also happens to render Latin
 * digits, but that is ICU's default for the tag rather than a promise — pinning
 * it makes the decision explicit and stable (see decision (1) above).
 */
export const FORMAT_LOCALE: Record<Lang, string> = {
  ar: 'ar-EG-u-nu-latn',
  en: 'en-GB',
};

/** The currency this deployment prices in. */
export const CURRENCY = 'EGP';

/**
 * The CLDR plural categories, in the order a translator reads them. Arabic uses
 * all six; English uses `one` and `other`.
 */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

/** A CLDR plural category. */
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/** Replaces `{name}` placeholders from `params`, leaving unknown ones visible. */
function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** The stored string for `key` in `lang`, or `undefined` if it is absent/empty. */
function lookup(key: string, lang: Lang): string | undefined {
  const value = dictionaries[lang]?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Is `key` really in the dictionary for `lang`? (The question `t` cannot answer.) */
export function hasKey(key: string, lang: Lang = DEFAULT_LANG): boolean {
  return lookup(key, lang) !== undefined;
}

/**
 * Translates `key` into `lang` (default: Arabic), interpolating `params`.
 *
 * Resolution order: the requested language, then Arabic (the fallback), then
 * the KEY itself. Always a non-empty string — never `undefined`.
 */
export function t(key: string, lang?: Lang): string;
export function t(key: string, opts: TranslateOptions): string;
export function t(key: string, second?: Lang | TranslateOptions): string {
  const opts: TranslateOptions = typeof second === 'string' ? { lang: second } : (second ?? {});
  const lang = opts.lang ?? DEFAULT_LANG;

  const template = lookup(key, lang) ?? lookup(key, DEFAULT_LANG) ?? key;
  return interpolate(template, opts.params);
}

/**
 * The plural-aware translation of `<keyBase>.<category>`.
 *
 * The category comes from `Intl.PluralRules(lang)` — the same CLDR rules the
 * dictionaries are written against — so `plural('cart.items', 2)` reads
 * `cart.items.two` in Arabic (صنفان, a form English has no word for) and
 * `cart.items.other` in English.
 *
 * Fallback order: the exact category in the requested language, then that
 * language's `other` (so a dictionary that supplies only the two English forms
 * still works for every count), then {@link t}'s normal fallback (Arabic, then
 * the key). `count` is always offered to the template as `{count}`.
 */
export function plural(keyBase: string, count: number, opts: TranslateOptions = {}): string {
  const lang = opts.lang ?? DEFAULT_LANG;
  const category = new Intl.PluralRules(lang).select(count);
  const params: Params = { count, ...opts.params };

  const exact = lookup(`${keyBase}.${category}`, lang);
  if (exact !== undefined) return interpolate(exact, params);

  const other = lookup(`${keyBase}.other`, lang);
  if (other !== undefined) return interpolate(other, params);

  return t(`${keyBase}.${category}`, { lang, params });
}

/**
 * A number as text, digits ALWAYS 0-9 (see decision (1)).
 *
 * `1234.5` → `"1,234.5"` — never `"١٬٢٣٤٫٥"`, because an operator reads it
 * against a printed barcode, an SKU or a delivery note.
 */
export function formatNumber(value: number, lang: Lang = DEFAULT_LANG): string {
  return new Intl.NumberFormat(FORMAT_LOCALE[lang]).format(value);
}

/** A money amount in EGP, digits always 0-9 (see {@link formatNumber}). */
export function formatCurrency(value: number, lang: Lang = DEFAULT_LANG): string {
  return new Intl.NumberFormat(FORMAT_LOCALE[lang], {
    style: 'currency',
    currency: CURRENCY,
  }).format(value);
}

/**
 * A date as text, digits always 0-9 (see {@link formatNumber}).
 *
 * Accepts a `Date` or epoch milliseconds, and defaults to the medium date style
 * (a day, a month and a year — what a stock count or a receipt is stamped
 * with). An invalid date THROWS rather than rendering "Invalid Date" on a
 * screen.
 */
export function formatDate(
  value: Date | number,
  lang: Lang = DEFAULT_LANG,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`formatDate: not a valid date (got ${JSON.stringify(value)})`);
  }
  return new Intl.DateTimeFormat(FORMAT_LOCALE[lang], options).format(date);
}
