'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { loadCurrentUser } from '../auth/current-user';
import { configuredTenantId } from '../auth/tenant';
import { getAppPool } from '../db/app-pool';
import { withTenant } from '../db/client';
import { LANG_COOKIE, langCookieOptions } from '../i18n/request';

/**
 * The language toggle: writes the choice to the `lang` cookie (the transport
 * every screen reads) and, when signed in, to `app_users.preferred_lang` so it
 * sticks for that person on every device.
 *
 * SECURITY: the `path` the form echoes back is only ever an internal redirect
 * — anything that is not a single `/`-prefixed, non-`//` path falls back to
 * `/`, so a crafted hidden field cannot turn the toggle into an open redirect.
 */
export async function setLanguage(formData: FormData): Promise<void> {
  const lang = formData.get('lang') === 'en' ? 'en' : 'ar';
  const rawPath = String(formData.get('path') ?? '/');
  const path = rawPath.startsWith('/') && !rawPath.startsWith('//') ? rawPath : '/';

  const store = await cookies();
  store.set(LANG_COOKIE, lang, langCookieOptions());

  const user = await loadCurrentUser();
  if (user) {
    await withTenant(await getAppPool(), configuredTenantId(), (db) =>
      db.query('update app_users set preferred_lang = $1 where id = $2', [lang, user.userId]),
    );
  }

  redirect(path);
}