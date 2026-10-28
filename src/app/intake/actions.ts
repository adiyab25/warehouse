'use server';

import { cookies } from 'next/headers';

import { SESSION_COOKIE } from '../../auth/cookie.ts';
import { configuredTenantId } from '../../auth/tenant.ts';
import { getAppPool } from '../../db/app-pool.ts';
import { withTenant } from '../../db/client.ts';
import type { ReceiptDuplicate } from '../../db/receipts.ts';
import type { ReceiptForm, ScanResult } from '../../domain/intake.ts';
import {
  IntakeError,
  checkNoteIn,
  scanIn,
  submitIn,
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
 * Resolves one scanned (or typed) barcode to a variant of THIS tenant.
 *
 * Answers `{ kind: 'unknown', code }` for a code that matches nothing — echoing
 * what was scanned — and never creates an item. A caller who is not signed in,
 * or whose role may not receive goods, is refused (an `IntakeError`); the field
 * is only reachable from a signed-in screen, so that path is defensive.
 */
export async function scan(code: string): Promise<ScanResult> {
  const cookie = await sessionCookieValue();
  return withTenant(await getAppPool(), configuredTenantId(), (db) => scanIn(db, cookie, code));
}

/**
 * Surfaces an already-posted receipt under the same delivery-note number, so the
 * screen can warn the manager BEFORE the goods are accepted.
 *
 * A WARNING, never a refusal: the second delivery still posts. Returns `null`
 * when nothing has been posted under that number yet.
 */
export async function checkNote(refNo: string): Promise<ReceiptDuplicate | null> {
  const cookie = await sessionCookieValue();
  return withTenant(await getAppPool(), configuredTenantId(), (db) => checkNoteIn(db, cookie, refNo));
}

/**
 * Posts the delivery: creates the receipt for this form and records what
 * arrived, then answers with the variances and any duplicate-note warning.
 *
 * NEVER THROWS AT THE SCREEN. A refusal the manager must read while a lorry is
 * waiting is an ANSWER, not an exception — and Next masks a thrown error's
 * message on a production client — so a refusal comes back as
 * `{ ok: false, error: { code, message } }` and the UI switches on the code.
 * Anything unexpected is logged here and reported as `invalid`, so no raw
 * database text reaches the browser.
 *
 * IDEMPOTENT ON THE FORM: `form.formId` is the receipt's own id, so a
 * double-tap or a lost response collapses to ONE movement.
 */
export async function submitReceipt(form: ReceiptForm): Promise<SubmitOutcome> {
  const cookie = await sessionCookieValue();
  try {
    const result = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
      submitIn(db, cookie, form),
    );
    return {
      ok: true,
      receiptId: result.receiptId,
      shortfalls: result.shortfalls,
      duplicateOf: result.duplicateOf,
      error: null,
    };
  } catch (err) {
    if (err instanceof IntakeError) {
      return {
        ok: false,
        receiptId: null,
        shortfalls: [],
        duplicateOf: null,
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
      error: { code: 'invalid', message: 'unexpected failure' },
    };
  }
}
