import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '../../auth/cookie';
import { configuredTenantId } from '../../auth/tenant';
import { IntakeScreen } from '../../components/IntakeScreen';
import { getAppPool } from '../../db/app-pool';
import { withTenant } from '../../db/client';
import { canReceive } from '../../domain/intake';
import { t } from '../../i18n';
import { SIGN_IN_PATH } from '../sign-in/contract';
import { frontDoor } from './handler';

export const metadata = { title: t('intake.title') };

/**
 * THE INTAKE DOOR — where a lorry's goods are counted in.
 *
 * THE GATE IS HERE, AND IT IS THE SAME GATE AS EVERYWHERE ELSE. The session
 * cookie is resolved by `frontDoor` inside ONE `withTenant` boundary — the app's
 * own pool (`await getAppPool()`, which refuses to serve as a superuser) scoped
 * to the deployment's tenant — and that one pass also answers what the screen
 * needs (who is asking, the locations goods may come from, and the warehouse
 * they arrive at), so the page never opens a second boundary. `withTenant` is
 * not re-entrant; it is opened exactly once, here.
 *
 * TWO REFUSALS, BOTH SERVER-SIDE:
 *
 *   * not signed in → the sign-in page (the same redirect the home page uses,
 *     and the second half of the gate `src/proxy.ts` starts);
 *   * signed in but not a warehouse role → the screen is NOT RENDERED AT ALL.
 *     That is a courtesy, not the control: {@link canReceive} is re-asserted
 *     here so a `branch_user` never sees a form, and the ACTION asserts it
 *     again, so nothing is written even if the screen were shown. A hidden
 *     button is not a permission.
 *
 * The page is Arabic and RIGHT-TO-LEFT (`dir="rtl"`, inherited from the root
 * layout and stated here so the screen stands alone); the only LTR exception is
 * inside the scan field, where a machine-read code must not be reversed.
 *
 * Reading a cookie makes this page DYNAMIC, which is the point: a static intake
 * door is a page that cannot tell who is asking.
 */
export default async function IntakePage() {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;

  const door = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
    frontDoor(db, cookie),
  );

  if (!door.user) redirect(SIGN_IN_PATH);

  // Belt and braces: the door already refused a role that may not receive, and
  // the rule is asserted again on the person it actually resolved.
  const mayReceive = door.mayReceive && canReceive(door.user.role);

  const destName = door.dest ? `${door.dest.name_ar} (${door.dest.code})` : null;

  return (
    <main dir="rtl">
      <h1>{t('intake.title')}</h1>
      {mayReceive ? (
        <>
          <p>{t('intake.subtitle')}</p>
          <IntakeScreen
            sources={door.sources.map((source) => ({
              id: source.id,
              label: `${source.name_ar} (${source.code})`,
            }))}
            destName={destName}
          />
        </>
      ) : (
        <p role="alert">{t('intake.error.forbidden')}</p>
      )}
      <p>
        <a href="/">{t('intake.back')}</a>
      </p>
    </main>
  );
}
