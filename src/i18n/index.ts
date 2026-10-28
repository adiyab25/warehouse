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
 * the literal word "undefined" on screen.
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
 * Translates `key` into `lang` (default: Arabic).
 *
 * Resolution order: the requested language, then Arabic (the fallback), then
 * the KEY itself. Always a non-empty string — never `undefined`.
 */
export function t(key: string, lang: Lang = DEFAULT_LANG): string {
  const requested = dictionaries[lang]?.[key];
  if (typeof requested === 'string' && requested !== '') return requested;

  const fallback = ar[key];
  if (typeof fallback === 'string' && fallback !== '') return fallback;

  return key;
}
