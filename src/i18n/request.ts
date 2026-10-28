import { cache } from 'react';

import { cookies, headers } from 'next/headers';

import { DEFAULT_LANG, type Lang } from './index';

/**
 * The language a browser prefers, when it says English or Arabic. Anything else
 * (French, an empty header, a malformed value) is `null` — Arabic, the app's
 * default, is never guessed for a browser that said something else; the caller
 * decides the fallback.
 */
export function langFromAcceptLanguage(value: string | null | undefined): Lang | null {
  if (!value) return null;
  for (const part of value.split(',')) {
    // "en-GB,en;q=0.9,ar;q=0.8" -> tags, in order, quality params dropped.
    const tag = part.split(';')[0].trim().toLowerCase();
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
    if (tag === 'ar' || tag.startsWith('ar-')) return 'ar';
  }
  return null;
}

/**
 * The language this request renders in, resolved ONCE per request (memoised by
 * React's `cache`):
 *
 *   1. the `lang` cookie, set on sign-in to the user's preference (or by the
 *      language toggle) — the per-user override;
 *   2. the browser's `Accept-Language`;
 *   3. Arabic, the app default.
 *
 * `cookies()`/`headers()` are async in this Next version, so every caller must
 * `await` it — the reason a component cannot just call `t(key)` and hope.
 */
export const getRequestLang = cache(async (): Promise<Lang> => {
  const jar = await cookies();
  const fromCookie = jar.get('lang')?.value;
  if (fromCookie === 'ar' || fromCookie === 'en') return fromCookie;
  const h = await headers();
  return langFromAcceptLanguage(h.get('accept-language')) ?? DEFAULT_LANG;
});

/** The cookie the resolved preference is carried in. */
export const LANG_COOKIE = 'lang';

/** Cookie attributes for the language cookie: a plain preference, server-read,
 * path-wide, persists across sessions (a language choice should stick). */
export function langCookieOptions() {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, maxAge: 60 * 60 * 24 * 365 };
}