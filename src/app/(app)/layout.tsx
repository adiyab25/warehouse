import type { ReactNode } from 'react';

import { SidebarProvider } from '@/components/ui/sidebar';
import { DirectionProvider } from '@/components/ui/direction';
import { DIRECTION } from '@/i18n';
import { getRequestLang } from '@/i18n/request';
import { loadCurrentUser } from '@/modules/auth/db';
import { PermissionsProvider } from '@/modules/shell/ui/PermissionGate';
import { AppSidebar } from '@/modules/shell/ui/AppSidebar';
import { TopBar } from '@/modules/shell/ui/TopBar';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const lang = await getRequestLang();
  const user = await loadCurrentUser();
  return (
    <DirectionProvider dir={DIRECTION[lang]}>
      <SidebarProvider>
        <AppSidebar permissions={user?.permissions ?? []} lang={lang} />
        {/* The permission set is handed to the client ONCE, here, so a client
            component can hide an affordance with the SAME keys the server
            checks. It is display only: the server never trusts it. */}
        <PermissionsProvider permissions={[...(user?.permissions ?? [])]}>
          <main className="flex-1">
            <TopBar lang={lang} />
            {children}
            <footer>©</footer>
          </main>
        </PermissionsProvider>
      </SidebarProvider>
    </DirectionProvider>
  );
}
