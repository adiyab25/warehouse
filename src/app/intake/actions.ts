'use server';

import { cookies } from 'next/headers';

import { SESSION_COOKIE } from '@/modules/auth/domain/cookie';
import { configuredTenantId } from '@/modules/auth/index';
import { getAppPool } from '@/modules/platform/index';
import { withTenant } from '@/modules/platform/index';
import type { ReceiptForm } from '@/modules/receiving/domain/intake';
import {
  IntakeError,
  checkNoteIn,
  scanIn,
  submitIn,
  type IntakeRefusal,
  type NoteOutcome,
  type ScanOutcome,
  type SubmitOutcome,
} from './handler.ts';

/**
 * The intake screen's SERVER ACTIONS — the request boundary, and nothing else.
 *
 * Each one is three lines of plumbing: read THIS request's session cookie, open
 * EXACTLY ONE `withTenant` boundary, and delegate to the logic in
 * `./handler.ts`. The gate, the rules and the SQL all live there, which is what
 * lets `node --test` drive them against a real database with no HTTP layer —
 * the same seam as `src/auth/current-user.ts` (`currentUser` vs. the request
 * path) and `src/app/api/labels/handler.ts`.
 *
 * `withTenant` is NOT re-entrant: the boundary is opened HERE, once, with the
 * app's own pool (`await getAppPool()`, which refuses to serve as a superuser)
 * and the deployment's tenant, and the scoped `db` is passed inward. Nothing
 * below opens a second one.
 *
 * THE CALLER IS RESOLVED THE APP'S WAY: the session cookie via
 * {@link SESSION_COOKIE}, turned into a person by `currentUser` inside the
 * scoped transaction. There is no second session mechanism on this screen.
 */

/** This request's session cookie value, or `undefined` when there is none. */
async function sessionCookieValue(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

/**
 * Turns a thrown failure into a refusal CODE the screen can render.
 *
 * An {@link IntakeError} already names its condition. Anything ELSE — a
 * database failure, a bug — is logged here and reported as `invalid`, so no raw
 * error text reaches the browser and no unexpected throw escapes an action.
 */
function refusalCode(err: unknown): IntakeRefusal {
  if (err instanceof IntakeError) return err.code;
  console.error('intake: unexpected failure in an intake action', err);
  return 'invalid';
}

/**
 * Resolves one scanned (or typed) barcode to a variant of THIS tenant.
 *
 * ANSWERS, NEVER THROWS. Returns `{ ok: true, scan }` where `scan` is
 * `{ kind: 'unknown', code }` (echoing what was scanned, never creating an
 * item) or `{ kind: 'variant', … }`; a refusal comes back as
 * `{ ok: false, code }` so the field can show the RIGHT reason — a `forbidden`
 * is not "you are not signed in". The cookie is read INSIDE the `try`, so a
 * failure to read it cannot reject the action and strand the screen.
 */
export async function scan(code: string): Promise<ScanOutcome> {
  try {
    const cookie = await sessionCookieValue();
    const result = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
      scanIn(db, cookie, code),
    );
    return { ok: true, scan: result };
  } catch (err) {
    return { ok: false, code: refusalCode(err) };
  }
}

/**
 * Surfaces an already-posted receipt under the same delivery-note number, so the
 * screen can warn the manager BEFORE the goods are accepted.
 *
 * A WARNING, never a refusal: the second delivery still posts. Returns
 * `{ ok: true, duplicate: null }` when nothing has been posted under that
 * number yet, and `{ ok: false, code }` when the CHECK itself was refused — a
 * failure to check must not masquerade as "nothing found".
 */
export async function checkNote(refNo: string): Promise<NoteOutcome> {
  try {
    const cookie = await sessionCookieValue();
    const duplicate = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
      checkNoteIn(db, cookie, refNo),
    );
    return { ok: true, duplicate };
  } catch (err) {
    return { ok: false, code: refusalCode(err) };
  }
}

/**
 * Posts the delivery: creates the receipt for this form and records what
 * arrived, then answers with the variances and any duplicate-note warning.
 *
 * NEVER THROWS AT THE SCREEN. A refusal the manager must read while a lorry is
 * waiting is an ANSWER, not an exception — and Next masks a thrown error's
 * message on a production client — so a refusal comes back as
 * `{ ok: false, error: { code, message } }` and the UI switches on the code.
 * The cookie is read INSIDE the `try`, so a throw while reading it cannot
 * reject the action and leave the submit button disabled.
 *
 * IDEMPOTENT ON THE FORM: `form.formId` is the receipt's own id, so a
 * double-tap or a lost response collapses to ONE movement. When the receipt is
 * still `receiving`, `status`/`outstanding` tell the screen to keep the form key
 * so the remainder is posted against the SAME receipt.
 */
export async function submitReceipt(form: ReceiptForm): Promise<SubmitOutcome> {
  try {
    const cookie = await sessionCookieValue();
    const result = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
      submitIn(db, cookie, form),
    );
    return {
      ok: true,
      receiptId: result.receiptId,
      shortfalls: result.shortfalls,
      duplicateOf: result.duplicateOf,
      status: result.status,
      outstanding: result.outstanding,
      error: null,
    };
  } catch (err) {
    if (err instanceof IntakeError) {
      return {
        ok: false,
        receiptId: null,
        shortfalls: [],
        duplicateOf: null,
        status: null,
        outstanding: [],
        error: { code: err.code, message: err.message },
      };
    }
    // Something the app did not plan for. Keep the detail in the SERVER log and
    // hand the screen a code it can render, never a raw error string.
    console.error('intake: unexpected failure posting a receipt', err);
    return {
      ok: false,
      receiptId: null,
      shortfalls: [],
      duplicateOf: null,
      status: null,
      outstanding: [],
      error: { code: 'invalid', message: 'unexpected failure' },
    };
  }
}
