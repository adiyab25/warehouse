import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from './schema.ts';
import { refusalCodeOf } from './guard.ts';
import { configuredTenantId } from '@/modules/auth/db.ts';
import { getAppPool, withTenant, type Queryable } from '@/modules/platform/index';

/**
 * THE FORM-ACTION RUNNER — the one wrapper every `<form action={…}>` screen
 * uses, so the plumbing (session cookie, ONE tenant boundary, refusal handling)
 * is written once and cannot be forgotten per screen.
 *
 * Why a wrapper at all: `<form action>` takes a function returning `void`, so an
 * action cannot hand a refusal back to the screen the way a JSON action can. It
 * therefore redirects to the SAME screen with `?refused=<code>` (or `?ok=1`),
 * and the page renders that as a banner. The code is short and fixed — never a
 * message from the server — so a crafted link cannot put words in the app's
 * mouth.
 *
 * The session cookie is read INSIDE the try, so a failure to read it is a
 * refusal and not a rejected action that strands the form.
 */
export async function runGatedAction(
  returnPath: string,
  body: (db: Queryable, cookie: string | undefined) => Promise<void>,
): Promise<void> {
  let outcome = 'ok';
  try {
    const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
    await withTenant(await getAppPool(), configuredTenantId(), (db) => body(db, cookie));
  } catch (err) {
    const code = refusalCodeOf(err);
    if (!code) throw err;
    outcome = code;
  }
  redirect(`${returnPath}?${outcome === 'ok' ? 'ok=1' : `refused=${outcome}`}`);
}
