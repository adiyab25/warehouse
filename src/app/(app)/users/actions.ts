'use server';

import { cookies } from 'next/headers';

import { SESSION_COOKIE } from '@/modules/auth/schema';
import { configuredTenantId } from '@/modules/auth/index';
import { getAppPool, withTenant } from '@/modules/platform/index';
import {
  asAnswer,
  createUserIn,
  resetPasswordIn,
  setUserActiveIn,
  setUserRoleIn,
  type AdminAnswer,
} from '@/modules/admin/index';

/**
 * The users screen's SERVER ACTIONS — the request boundary and nothing else.
 *
 * A password crosses this boundary in ONE direction only: into `hashPassword`.
 * It is never returned, never logged, and never sent back to the screen.
 */

async function sessionCookieValue(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

/** Creates a person with a role and, optionally, a branch. */
export async function createUserAction(input: {
  name: string;
  username: string;
  password: string;
  roleId: string;
  branchLocationId?: string | null;
}): Promise<AdminAnswer<{ userId: string }>> {
  return asAnswer(async () => {
    const cookie = await sessionCookieValue();
    return withTenant(await getAppPool(), configuredTenantId(), (db) =>
      createUserIn(db, cookie, input),
    );
  });
}

/** Moves a person to another role. */
export async function setUserRoleAction(input: {
  userId: string;
  roleId: string;
}): Promise<AdminAnswer<{ roleId: string }>> {
  return asAnswer(async () => {
    const cookie = await sessionCookieValue();
    return withTenant(await getAppPool(), configuredTenantId(), (db) =>
      setUserRoleIn(db, cookie, input),
    );
  });
}

/** Enables or disables an account. */
export async function setUserActiveAction(input: {
  userId: string;
  active: boolean;
}): Promise<AdminAnswer<{ active: boolean }>> {
  return asAnswer(async () => {
    const cookie = await sessionCookieValue();
    return withTenant(await getAppPool(), configuredTenantId(), (db) =>
      setUserActiveIn(db, cookie, input),
    );
  });
}

/** Resets a password and ends that person's live sessions. */
export async function resetPasswordAction(input: {
  userId: string;
  password: string;
}): Promise<AdminAnswer<{ userId: string }>> {
  return asAnswer(async () => {
    const cookie = await sessionCookieValue();
    return withTenant(await getAppPool(), configuredTenantId(), (db) =>
      resetPasswordIn(db, cookie, input),
    );
  });
}
