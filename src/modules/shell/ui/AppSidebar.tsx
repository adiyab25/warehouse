'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarHeader, SidebarFooter } from '@/components/ui/sidebar';
import { t, type Lang } from '@/i18n';
import { navLinksForPermissions } from '@/modules/shell/schema';

export function AppSidebar({
  permissions,
  lang,
}: {
  permissions: readonly string[];
  lang: Lang;
}) {
  const links = navLinksForPermissions(permissions);
  return (
    <Sidebar>
      <SidebarHeader>
        <span className="font-semibold">Warehouse</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Nav</SidebarGroupLabel>
          <SidebarMenu>
            {links.map((l) => (
              <SidebarMenuItem key={l.href}>
                <SidebarMenuButton asChild>
                  <Link href={l.href}>{t(l.key, lang)}</Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}
