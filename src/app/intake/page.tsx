import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/modules/auth/schema';
import { configuredTenantId } from '@/modules/auth/index';
import { IntakeScreen } from '@/modules/receiving/ui/IntakeScreen';
import { getAppPool } from '@/modules/platform/index';
import { withTenant } from '@/modules/platform/index';
import { can, PERMISSION } from '@/modules/auth/keys';
import { t } from '../../i18n';
import { getRequestLang } from '../../i18n/request';
import { SIGN_IN_PATH } from '../(auth)/sign-in/contract';
import { frontDoor } from './handler';

export async function generateMetadata() {
  const lang = await getRequestLang();
  return { title: t('intake.title', lang) };
}

/**
 * THE INTAKE DOOR — where a lorry's goods are counted in.
 *
 * THE GATE IS HERE, AND IT IS THE SAME GATE AS EVERYWHERE ELSE. The session
 * cookie is resolved by `frontDoor` inside ONE `withTenant` boundary, and that
 * one pass also answers what the screen needs, so the page never opens a second
 * boundary. `withTenant` is not re-entrant; it is opened exactly once, here.
 *
 * TWO REFUSALS, BOTH SERVER-SIDE: not signed in → the sign-in page; signed in
 * but not a warehouse role → the screen is NOT RENDERED AT ALL (`canReceive` is
 * also re-asserted in the action, so nothing is written even if it were shown).
 */
export default async function IntakePage() {
  const lang = await getRequestLang();
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const door = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    frontDoor(db, cookie),
  );

  if (!door.user) redirect(SIGN_IN_PATH);

  // Belt and braces: the door already checked the permission, and it is
  // asserted again on the person it actually resolved — against the SAME key
  // the server action will check, so the screen and the write cannot disagree.
  const mayReceive = door.mayReceive && can(door.user.permissions, PERMISSION.intakeCreate);

  const destName = door.dest ? `${door.dest.name_ar} (${door.dest.code})` : null;

  return (
    <main>
      <h1>{t('intake.title', lang)}</h1>
      {mayReceive ? (
        <>
          <p>{t('intake.subtitle', lang)}</p>
          <IntakeScreen
            lang={lang}
            sources={door.sources.map((source) => ({
              id: source.id,
              label: `${source.name_ar} (${source.code})`,
            }))}
            destName={destName}
          />
        </>
      ) : (
        <p role="alert">{t('intake.error.forbidden', lang)}</p>
      )}
      <p>
        <a href="/">{t('intake.back', lang)}</a>
      </p>
    </main>
  );
}