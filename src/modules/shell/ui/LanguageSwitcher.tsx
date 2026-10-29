'use client';

import { usePathname } from 'next/navigation';

import { setLanguage } from '@/app/actions';

/**
 * The global language toggle. It shows the OTHER language and flips to it: the
 * server action sets the `lang` cookie (and, when signed in, the user's stored
 * preference), then redirects back to the current path so the whole page
 * re-renders in the new language and direction.
 */
export function LanguageSwitcher({ lang }: { lang: 'ar' | 'en' }) {
  const pathname = usePathname();
  const target = lang === 'ar' ? 'en' : 'ar';
  const label = lang === 'ar' ? 'English' : 'عربي';
  return (
    <form action={setLanguage}>
      <input type="hidden" name="lang" value={target} />
      <input type="hidden" name="path" value={pathname} />
      <button type="submit">{label}</button>
    </form>
  );
}