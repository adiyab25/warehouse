import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { DEFAULT_LANG, DIRECTION, t } from '../i18n';

import './globals.css';

/**
 * The root layout — Arabic-first and RIGHT-TO-LEFT.
 *
 * `<html lang="ar" dir="rtl">` is the whole shell's direction: everything
 * inherits RTL from here, and the single LTR exception (barcode entry, a later
 * task) opts out with the `.ltr-value` class defined in globals.css. The
 * (Arabic) title and description come from the i18n dictionary, so even the
 * document chrome is translated.
 */
export const metadata: Metadata = {
  title: t('app.title'),
  description: t('app.description'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={DEFAULT_LANG} dir={DIRECTION[DEFAULT_LANG]}>
      <body>{children}</body>
    </html>
  );
}
