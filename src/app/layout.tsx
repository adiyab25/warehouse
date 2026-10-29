import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { DIRECTION, t } from '../i18n';
import { getRequestLang } from '../i18n/request';

import './globals.css';
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});


/**
 * The root layout — Arabic-first, with a per-user language override.
 *
 * The language is resolved ONCE per request by `getRequestLang` (the `lang`
 * cookie set to the user's preference, then the browser's `Accept-Language`,
 * then Arabic), and everything — the `<html lang dir>`, the title, and every
 * screen's `t()` call — follows it. `dir` flips the whole shell between
 * right-to-left (Arabic) and left-to-right (English); the single
 * LTR-inside-RTL exception (barcode entry) opts out with `.ltr-value`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const lang = await getRequestLang();
  return {
    title: t('app.title', lang),
    description: t('app.description', lang),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = await getRequestLang();
  return (
    <html lang={lang} dir={DIRECTION[lang]} className={cn("font-sans", geist.variable)}>
      <body>
        <header>
          <LanguageSwitcher lang={lang} />
        </header>
        {children}
      </body>
    </html>
  );
}