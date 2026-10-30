'use client';

import { createContext, useContext } from 'react';

interface PermissionsContextValue {
  permissions: Set<string>;
  has: (key: string) => boolean;
}

const PermissionsContext = createContext<PermissionsContextValue>({
  permissions: new Set(),
  has: () => false,
});

export function PermissionsProvider({
  permissions,
  children,
}: {
  permissions: string[];
  children: React.ReactNode;
}) {
  const set = new Set(permissions);
  return (
    <PermissionsContext.Provider value={{ permissions: set, has: (key) => set.has(key) }}>
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissions() {
  return useContext(PermissionsContext);
}

export function PermissionGate({
  permission,
  children,
  fallback = null,
}: {
  permission: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { has } = usePermissions();
  if (!has(permission)) return <>{fallback}</>;
  return <>{children}</>;
}
