import { can } from './keys.ts';
import { currentUser, type CurrentUser } from './db.ts';
import type { Queryable } from '@/modules/platform/index';

/**
 * THE SERVER-ACTION GUARD — one place a write decides who may make it.
 *
 * A server action is an HTTP endpoint. It looks like a button handler, so it is
 * easy to write one that trusts the form and forgets to ask who is calling —
 * and that is exactly what happened to the first-cut screens: they opened a
 * pool, set the tenant, and wrote, with no session and no permission check at
 * all. Anything that could POST could create items, post returns and open count
 * sessions in the tenant.
 *
 * So every write calls {@link requirePermission} (or {@link requireSession} when
 * the act is not permissioned) BEFORE it validates its own form, and the ACTOR
 * is the session's user — never a field the form supplied. A refusal is an
 * {@link ActionRefusal} carrying a code, so the caller can send the person back
 * to the screen with a message instead of a 500.
 */

/** Why an action was refused — a named condition, never a bare throw. */
export type RefusalCode = 'unauthenticated' | 'forbidden' | 'invalid' | 'conflict';

/** A refusal the action boundary can recognise and report. */
export class ActionRefusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = 'ActionRefusal';
    this.code = code;
  }
}

/** The refusal code on an error, or `null` when it is a real fault. */
export function refusalCodeOf(err: unknown): RefusalCode | null {
  if (err instanceof ActionRefusal) return err.code;
  const code = (err as { code?: unknown })?.code;
  const name = (err as { name?: unknown })?.name;
  if (name === 'AdminError' && typeof code === 'string') {
    return ['unauthenticated', 'forbidden', 'invalid', 'conflict'].includes(code)
      ? (code as RefusalCode)
      : null;
  }
  return null;
}

/** The caller, or an `unauthenticated` refusal. */
export async function requireSession(
  db: Queryable,
  cookie: string | undefined | null,
): Promise<CurrentUser> {
  const user = await currentUser(db, cookie);
  if (!user) {
    throw new ActionRefusal('unauthenticated', 'This action needs a signed-in session.');
  }
  return user;
}

/** The caller, if their role holds `key` — otherwise `forbidden`. */
export async function requirePermission(
  db: Queryable,
  cookie: string | undefined | null,
  key: string,
): Promise<CurrentUser> {
  const user = await requireSession(db, cookie);
  if (!can(user.permissions, key)) {
    throw new ActionRefusal(
      'forbidden',
      `This action needs "${key}", which this account's role does not hold.`,
    );
  }
  return user;
}

/**
 * Reads a required text field, trimmed — an `invalid` refusal when it is empty.
 *
 * The FIELD NAME goes in the message, because "invalid" alone sends a person
 * hunting through a form with four inputs.
 */
export function requiredField(form: FormData, name: string): string {
  const value = form.get(name);
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') {
    throw new ActionRefusal('invalid', `The field "${name}" is required.`);
  }
  return text;
}
