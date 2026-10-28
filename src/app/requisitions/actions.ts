'use server';

import { cookies } from 'next/headers';

import { SESSION_COOKIE } from '../../auth/cookie.ts';
import { configuredTenantId } from '../../auth/tenant.ts';
import { getAppPool } from '../../db/app-pool.ts';
import { withTenant } from '../../db/client.ts';
import {
  answered,
  approveIn,
  confirmIn,
  issueIn,
  requestIn,
  type ActionResult,
  type ApproveForm,
  type FlowForm,
  type RequestForm,
} from './handler.ts';

/**
 * The requisition screens' SERVER ACTIONS — the request boundary, and nothing
 * else.
 *
 * Each one is three lines of plumbing: read THIS request's session cookie, open
 * EXACTLY ONE `withTenant` boundary, and delegate to the logic in
 * `./handler.ts`. The gate, the rules and the SQL all live there, which is what
 * lets `node --test` drive them against a real database with no HTTP layer — the
 * same seam as `src/app/intake/actions.ts` and `src/auth/current-user.ts`.
 *
 * `withTenant` is NOT re-entrant: the boundary is opened HERE, once, with the
 * app's own pool (`await getAppPool()`, which refuses to serve as a superuser)
 * and the deployment's tenant, and the scoped `db` is passed inward.
 *
 * EVERY ACTION ANSWERS, NONE THROWS. A refusal is a coded ANSWER — never a
 * blanket catch that would tell a warehouse manager they were "not signed in"
 * when the real refusal was a permission check. The cookie is read INSIDE the
 * `try`, so a failure to read it cannot reject the action and strand the
 * screen's in-flight flag.
 */

/** This request's session cookie value, or `undefined` when there is none. */
async function sessionCookieValue(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

/**
 * Asks for stock on behalf of the caller's OWN branch, and answers with the new
 * document's id.
 *
 * The branch and the asker come from the SESSION, server-side; only the lines
 * and their quantities come from the form.
 */
export async function requestLines(form: RequestForm): Promise<ActionResult> {
  return answered(async () => {
    const cookie = await sessionCookieValue();
    const result = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
      requestIn(db, cookie, form),
    );
    return { requisitionId: result.requisitionId };
  });
}

/** Approves a `requested` requisition — the warehouse's decision. */
export async function approveRequisition(form: ApproveForm): Promise<ActionResult> {
  return answered(async () => {
    const cookie = await sessionCookieValue();
    const result = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
      approveIn(db, cookie, form),
    );
    return { status: result.status };
  });
}

/**
 * Releases stock against an approved (or partly-issued) requisition.
 *
 * Answers with the state the flow LANDED IN, so the screen can say "issued in
 * part — the rest is still to release" rather than a flat success: a
 * `partially_issued` document is not a finished one (rule 4).
 */
export async function issueLines(form: FlowForm): Promise<ActionResult> {
  return answered(async () => {
    const cookie = await sessionCookieValue();
    const result = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
      issueIn(db, cookie, form),
    );
    return { status: result.status };
  });
}

/**
 * Acknowledges what actually arrived at the branch — per line, limited to what
 * is still in transit — and answers with the state the flow landed in.
 */
export async function confirmLines(form: FlowForm): Promise<ActionResult> {
  return answered(async () => {
    const cookie = await sessionCookieValue();
    const result = await withTenant(await getAppPool(), configuredTenantId(), (db) =>
      confirmIn(db, cookie, form),
    );
    return { status: result.status };
  });
}
