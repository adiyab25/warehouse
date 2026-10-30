"use client";

import * as React from "react";

const PermissionsContext = React.createContext<Set<string>>(new Set());

export function PermissionsProvider({
  permissions,
  children,
}: {
  permissions: string[];
  children: React.ReactNode;
}) {
  return (
    <PermissionsContext.Provider value={new Set(permissions)}>
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissions() {
  const perms = React.useContext(PermissionsContext);
  return {
    can: (key: string) => perms.has(key),
    permissions: perms,
  };
}

export function PermissionGate({
  permission,
  children,
}: {
  permission: string;
  children: React.ReactNode;
}) {
  const { can } = usePermissions();
  if (!can(permission)) return null;
  return <>{children}</>;
}