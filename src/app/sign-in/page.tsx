import { t } from '../../i18n';

import { signInAction } from './actions';

export const metadata = { title: t('sign_in.title') };

/**
 * The sign-in form. Arabic, RTL (inherited from the root layout), posting to
 * the {@link signInAction} server action. The reason for a failure rides back
 * as a query parameter and is turned into a translated message.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
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
          <input name="userLookup" autoComplete="username" required />
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
