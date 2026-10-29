'use client';

import { SidebarTrigger } from '@/components/ui/sidebar';
import { LanguageSwitcher } from '@/modules/shell/ui/LanguageSwitcher';

export function TopBar({ lang }: { lang: "ar" | "en" }) {
  return (
    <header className="flex items-center gap-2 border-b p-2">
      <SidebarTrigger />
      <div className="flex-1" />
      <LanguageSwitcher lang={lang} />
      <a href="/sign-out">Sign out</a>
    </header>
  );
}
