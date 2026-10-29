import { t } from '../../../i18n';
import { getRequestLang } from '../../../i18n/request';

import { signInAction } from './actions';
import { ERROR_PARAM, USERNAME_FIELD } from './contract';

export async function generateMetadata() {
  const lang = await getRequestLang();
  return { title: t('sign_in.title', lang) };
}

/**
 * The sign-in form, posting to the {@link signInAction} server action, in the
 * request's resolved language (the browser's, until a preference is set).
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ [ERROR_PARAM]?: string; [USERNAME_FIELD]?: string }>;
}) {
  const lang = await getRequestLang();
  const { error, username } = await searchParams;
  const message =
    error === 'locked'
      ? t('sign_in.error.locked', lang)
      : error === 'invalid'
        ? t('sign_in.error.invalid', lang)
        : null;

  return (
    <main>
      <h1>{t('sign_in.title', lang)}</h1>
      {message ? <p role="alert">{message}</p> : null}
      <form action={signInAction}>
        <label>
          {t('sign_in.username', lang)}
          <input
            name={USERNAME_FIELD}
            autoComplete="username"
            defaultValue={username ?? ''}
            required
          />
        </label>
        <label>
          {t('sign_in.password', lang)}
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">{t('sign_in.submit', lang)}</button>
      </form>
    </main>
  );
}