import type { ReactNode } from 'react';

import { SidebarProvider } from '@/components/ui/sidebar';
import { DirectionProvider } from '@/components/ui/direction';
import { DIRECTION } from '@/i18n';
import { getRequestLang } from '@/i18n/request';
import { loadCurrentUser } from '@/modules/auth/server/current-user';
import { AppSidebar } from '@/modules/shell/ui/AppSidebar';
import { TopBar } from '@/modules/shell/ui/TopBar';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const lang = await getRequestLang();
  const user = await loadCurrentUser();
  return (
    <DirectionProvider dir={DIRECTION[lang]}>
      <SidebarProvider>
        <AppSidebar role={user?.role} lang={lang} />
        <main className="flex-1">
          <TopBar lang={lang} />
          {children}
          <footer>©</footer>
        </main>
      </SidebarProvider>
    </DirectionProvider>
  );
}
