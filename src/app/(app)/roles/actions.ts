'use server';

import { cookies } from 'next/headers';

import { SESSION_COOKIE } from '@/modules/auth/schema';
import { configuredTenantId } from '@/modules/auth/index';
import { getAppPool, withTenant } from '@/modules/platform/index';
import {
  asAnswer,
  createRoleIn,
  setRolePermissionsIn,
  type AdminAnswer,
} from '@/modules/admin/index';

/**
 * The roles screen's SERVER ACTIONS — the request boundary and nothing else.
 *
 * Same shape as `src/app/requisitions/actions.ts`: read THIS request's session
 * cookie, open EXACTLY ONE `withTenant` boundary, delegate to
 * `src/modules/admin/service.ts`. The gate, the rules and the SQL live there, so
 * `node --test` drives them with no HTTP layer.
 *
 * NOTHING IS TRUSTED FROM THE FORM BUT THE INTENT: the actor is the session, the
 * tenant is deployment configuration. The screen never sends "as whom".
 */

async function sessionCookieValue(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

/** Creates a role and grants the ticked permissions. */
export async function createRoleAction(input: {
  name: string;
  description?: string;
  keys?: string[];
}): Promise<AdminAnswer<{ roleId: string }>> {
  return asAnswer(async () => {
    const cookie = await sessionCookieValue();
    return withTenant(await getAppPool(), configuredTenantId(), (db) =>
      createRoleIn(db, cookie, input),
    );
  });
}

/** Replaces a role's permission set. */
export async function saveRolePermissionsAction(input: {
  roleId: string;
  keys: string[];
}): Promise<AdminAnswer<{ keys: string[] }>> {
  return asAnswer(async () => {
    const cookie = await sessionCookieValue();
    return withTenant(await getAppPool(), configuredTenantId(), (db) =>
      setRolePermissionsIn(db, cookie, input),
    );
  });
}
