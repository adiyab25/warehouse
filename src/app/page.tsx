import { t } from '../i18n';

/**
 * The home page — the post-sign-in landing. Deliberately minimal: Task 11
 * builds the shell, not the screens. Tasks 12-16 add the real, role-aware
 * content here.
 */
export default function HomePage() {
  return (
    <main>
      <h1>{t('home.title')}</h1>
      <p>{t('home.tagline')}</p>
    </main>
  );
}
