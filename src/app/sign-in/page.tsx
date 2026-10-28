import { t } from '../../i18n';

import { signInAction } from './actions';
import { ERROR_PARAM, USERNAME_FIELD } from './contract';

export const metadata = { title: t('sign_in.title') };

/**
 * The sign-in form. Arabic, RTL (inherited from the root layout), posting to
 * the {@link signInAction} server action.
 *
 * THE FIELD IS THE USERNAME. Identity is the short assigned username
 * (`app_users.username`, unique per tenant), NOT the person's name — two
 * colleagues may share a name, and a name is not something the app can match
 * exactly. `autoComplete="username"` tells a password manager which field this
 * is, so the pair it saves is the one the person actually signs in with.
 *
 * The reason for a failure rides back as a query parameter and is turned into a
 * translated message; the typed username rides back too, so a mistyped PASSWORD
 * does not cost the person their username as well. The password is never
 * echoed, never stored in the URL, and never logged.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ [ERROR_PARAM]?: string; [USERNAME_FIELD]?: string }>;
}) {
  const { error, username } = await searchParams;
  const message =
    error === 'locked'
      ? t('sign_in.error.locked')
      : error === 'invalid'
        ? t('sign_in.error.invalid')
        : null;

  return (
    <main>
      <h1>{t('sign_in.title')}</h1>
      {message ? <p role="alert">{message}</p> : null}
      <form action={signInAction}>
        <label>
          {t('sign_in.username')}
          <input
            name={USERNAME_FIELD}
            autoComplete="username"
            defaultValue={username ?? ''}
            required
          />
        </label>
        <label>
          {t('sign_in.password')}
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">{t('sign_in.submit')}</button>
      </form>
    </main>
  );
}
