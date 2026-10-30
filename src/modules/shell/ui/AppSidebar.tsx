'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarHeader, SidebarFooter } from '@/components/ui/sidebar';
import { navLinksForRole } from '@/modules/shell/schema';

export function AppSidebar({ role, lang }: { role: string | null | undefined; lang: "ar" | "en" }) {
  const links = navLinksForRole(role);
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
                  <Link href={l.href}>{l.key}</Link>
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
