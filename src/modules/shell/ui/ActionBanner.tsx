import { t, type Lang } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * The banner a form screen shows after a submission.
 *
 * A server action on a `<form action>` cannot return a value to the screen, so
 * `runGatedAction` redirects back with a SHORT CODE (`?ok=1` or
 * `?refused=forbidden`) and this turns that code into a sentence. The code is
 * never a message from the server: a crafted link can change which sentence
 * appears, never what it says.
 */
const MESSAGES: Record<string, string> = {
  unauthenticated: 'action.error.unauthenticated',
  forbidden: 'action.error.forbidden',
  invalid: 'action.error.invalid',
  conflict: 'action.error.conflict',
};

export function ActionBanner({
  lang,
  ok,
  refused,
}: {
  lang: Lang;
  ok?: boolean;
  refused?: string | undefined;
}) {
  const key = refused !== undefined ? MESSAGES[refused] : ok ? 'action.saved' : undefined;
  if (!key) return null;

  const bad = refused !== undefined;
  return (
    <p
      role="status"
      className={cn(
        'mb-4 rounded-md border px-3 py-2 text-sm',
        bad ? 'border-destructive/40 text-destructive' : 'text-muted-foreground',
      )}
    >
      {t(key, lang)}
    </p>
  );
}
