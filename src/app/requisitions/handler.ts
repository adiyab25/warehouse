import { currentUser, type CurrentUser } from '../../auth/current-user.ts';
import type { Queryable } from '../../db/client.ts';
import {
  approve,
  confirmReceipt,
  createRequisition,
  issue,
  type RequisitionStatus,
} from '../../db/requisitions.ts';
import {
  availableActions,
  canApproveOrIssue,
  canRequest,
  confirmAnchor,
  confirmProblem,
  issueAnchor,
  issueProblem,
  round3,
  type RequisitionActionSet,
  type RequisitionRefusal,
} from '../../domain/requisition-ui.ts';

/**
 * The REQUISITION SCREENS' LOGIC, with the request boundary left OUT.
 *
 * Same seam as `src/app/intake/handler.ts`, for the same three reasons: a
 * `'use server'` module may export only async functions, it reads `next/headers`
 * (which no `node --test` process has), and it opens the tenant scope. So:
 *
 *   * every function here takes an ALREADY tenant-scoped `db` plus the raw
 *     session cookie value, so a test drives it against a real database on a
 *     real tenant with no HTTP layer at all;
 *   * `src/app/requisitions/actions.ts` is the REQUEST path: it reads the
 *     cookie, opens EXACTLY ONE `withTenant` and delegates.
 *
 * `withTenant` is NOT re-entrant, which is why the scope is opened at the
 * boundary and never here.
 *
 * EVERY WRITE GOES THROUGH TASK 7. `createRequisition`, `approve`, `issue` and
 * `confirmReceipt` own the ledger; nothing here inserts a movement, re-implements
 * a transition or recomputes a quantity. The screen is a ledger DRIVER, so it
 * uses the ledger's writers and re-implements none of their rules — it only
 * refuses EARLIER, with the same precision, so a refusal reaches the desk as its
 * own message instead of a masked exception.
 *
 * THE DOUBLE SUBMIT. Task 7 derives each leg's ledger key from the CUMULATIVE
 * quantity it produces (`requisition:<id>:issue:<variant>:<after>`), so a retry
 * of ONE leg lands on the same movement — but a second tap of a PARTIAL issue
 * would compute a NEW cumulative quantity and post a second leg. The caller
 * therefore hands in the state it acted FROM (`from`), this module derives the
 * ledger key that leg would use ({@link issueAnchor}/{@link confirmAnchor}), and
 * checks the ledger for it FIRST: an intent that has already posted is answered,
 * not re-posted. Task 7 offers no idempotency PARAMETER for these two writes, so
 * this is the shape used instead of `CreateReceiptInput.id`.
 */

export type { RequisitionActionSet, RequisitionRefusal };

/**
 * What a SCREEN receives back from one of the four actions.
 *
 * A server action cannot throw a useful message at a production client — Next
 * masks it — and a refusal a person must read (goods on the road, a permission
 * they do not hold) is not an exception, it is an ANSWER. So the request
 * boundary catches {@link RequisitionError} and hands back this plain,
 * serialisable outcome: `ok` — with the new document's id or the state the flow
 * landed in — or the refusal CODE, which the UI switches on to render its OWN
 * message. It lives here, not in the `'use server'` module, so a client
 * component can import the TYPE without pulling server code into its bundle.
 */
export type ActionResult =
  | { ok: true; requisitionId?: string; status?: RequisitionStatus }
  | { ok: false; error: RequisitionRefusal };

/**
 * Turns a thrown failure into the ANSWER a screen receives.
 *
 * A {@link RequisitionError} already names its condition. Anything ELSE — a
 * database failure, a bug — is logged here and reported as `invalid`, so no raw
 * error text reaches the browser and no unexpected throw escapes an action.
 *
 * Exported so the REQUEST BOUNDARY and a test produce the SAME bytes: the seam
 * below throws, {@link answered} turns a throw into a coded answer, and a test
 * can assert the exact answer a person would see rather than a message the
 * action invented.
 */
export function refusalOutcome(err: unknown): ActionResult {
  if (err instanceof RequisitionError) return { ok: false, error: err.code };
  console.error('requisitions: unexpected failure in a requisition action', err);
  return { ok: false, error: 'invalid' };
}

/**
 * Runs one action body and ANSWERS — `ok` with what the body returned, or a
 * coded refusal. NEVER throws at the caller.
 *
 * The body is where the request's cookie is read, so a failure to read it lands
 * here too and cannot reject the action and leave a button disabled forever.
 */
export async function answered(body: () => Promise<{ requisitionId?: string; status?: RequisitionStatus }>): Promise<ActionResult> {
  try {
    const result = await body();
    return { ok: true, ...result };
  } catch (err) {
    return refusalOutcome(err);
  }
}


/** The one place `app.tenant_id` is read for a write, so it is written once. */
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/**
 * A refusal the screen can render, carrying a machine-readable `code` AND a
 * message that names the problem. The code is what the UI switches on; the
 * message is what a developer reads in a log.
 */
export class RequisitionError extends Error {
  readonly code: RequisitionRefusal;

  constructor(code: RequisitionRefusal, message: string) {
    super(message);
    this.name = 'RequisitionError';
    this.code = code;
  }
}

/** Who is asking, resolved the app's way — or `unauthenticated`, never a throw. */
async function requireUser(db: Queryable, cookie: string | undefined | null): Promise<CurrentUser> {
  const user = await currentUser(db, cookie);
  if (!user) {
    throw new RequisitionError(
      'unauthenticated',
      'Requisitions: you are not signed in (or the session has ended) — sign in again.',
    );
  }
  return user;
}

/** The ONE warehouse gate: approve and issue. Everything that approves asks this. */
async function requireWarehouse(db: Queryable, cookie: string | undefined | null): Promise<CurrentUser> {
  const user = await requireUser(db, cookie);
  if (!canApproveOrIssue(user.role)) {
    throw new RequisitionError(
      'forbidden',
      `Requisitions: approving and issuing are warehouse functions — role "${user.role}" may not do either.`,
    );
  }
  return user;
}

/**
 * The ONE branch gate: request and confirm. Resolves the caller's OWN branch
 * from `app_users.branch_location_id` — never from the request — so a branch
 * user cannot name a branch that is not theirs.
 */
async function requireBranch(
  db: Queryable,
  cookie: string | undefined | null,
): Promise<{ user: CurrentUser; branchLocationId: string }> {
  const user = await requireUser(db, cookie);
  if (!canRequest(user.role)) {
    throw new RequisitionError(
      'forbidden',
      `Requisitions: requesting and confirming are branch functions — role "${user.role}" may not do either.`,
    );
  }
  const { rows } = await db.query<{ branch_location_id: string | null }>(
    `select branch_location_id from app_users where id = $1 and tenant_id = ${TENANT}`,
    [user.userId],
  );
  const branchLocationId = rows[0]?.branch_location_id ?? null;
  if (!branchLocationId) {
    throw new RequisitionError(
      'invalid',
      `Requisitions: the account "${user.username}" is not assigned to a branch, so it cannot request or confirm stock.`,
    );
  }
  return { user, branchLocationId };
}

/** A requisition as the LIST shows it. */
export interface RequisitionSummary {
  id: string;
  status: RequisitionStatus;
  branchLocationId: string;
  branchNameAr: string;
  branchCode: string;
  /** When it was asked for, ISO-8601 (the screen formats it). */
  requestedAt: string;
  lineCount: number;
}

/** A catalogue variant the request form may name. */
export interface CatalogueVariant {
  id: string;
  sku: string;
  nameAr: string;
}

/** Everything the list screen needs, read in ONE pass inside the caller's scope. */
export interface RequisitionListResult {
  user: CurrentUser | null;
  role: string | null;
  /** May this viewer ask for stock (and so see the request form)? */
  mayRequest: boolean;
  /** May this viewer approve/issue (and so see every branch)? */
  mayApprove: boolean;
  /** The viewer's own branch, or `null` for the warehouse. */
  branchLocationId: string | null;
  /** The viewer's own branch label ("فرع أ (BR-UA)"), or `null`. */
  branchLabel: string | null;
  /** The requisitions this viewer may see, newest first. */
  requisitions: RequisitionSummary[];
  /** The catalogue the request form offers — EMPTY for a viewer who may not request. */
  variants: CatalogueVariant[];
}

/**
 * Everything the list screen needs, in ONE read.
 *
 * THE SCOPE IS THE SERVER'S, NOT THE UI'S. A `branch_user` is filtered to
 * `branch_location_id = their own branch` in the QUERY, so a requisition from
 * another branch never leaves the database — hiding a row in the markup would
 * not be a permission. A warehouse role sees every branch. A viewer in neither
 * role gets nothing at all and no catalogue read.
 */
export async function listRequisitions(
  db: Queryable,
  cookie: string | undefined | null,
): Promise<RequisitionListResult> {
  const user = await currentUser(db, cookie);
  const empty = {
    user,
    role: user?.role ?? null,
    mayRequest: false,
    mayApprove: false,
    branchLocationId: null,
    branchLabel: null,
    requisitions: [] as RequisitionSummary[],
    variants: [] as CatalogueVariant[],
  };
  if (!user) return empty;

  const mayRequest = canRequest(user.role);
  const mayApprove = canApproveOrIssue(user.role);
  if (!mayRequest && !mayApprove) return empty;

  let branchLocationId: string | null = null;
  let branchLabel: string | null = null;
  if (mayRequest) {
    const { rows } = await db.query<{ branch_location_id: string | null }>(
      `select branch_location_id from app_users where id = $1 and tenant_id = ${TENANT}`,
      [user.userId],
    );
    branchLocationId = rows[0]?.branch_location_id ?? null;
    if (branchLocationId) {
      const { rows: branches } = await db.query<{ name_ar: string; code: string }>(
        `select name_ar, code from locations where id = $1 and tenant_id = ${TENANT}`,
        [branchLocationId],
      );
      if (branches[0]) branchLabel = `${branches[0].name_ar} (${branches[0].code})`;
    }
  }

  const params: unknown[] = [];
  let filter = '';
  // A BRANCH VIEWER SEES ONLY THEIR OWN BRANCH — enforced in SQL. A branch user
  // with no branch sees nothing (the filter would compare against NULL).
  if (mayRequest && !mayApprove) {
    params.push(branchLocationId);
    filter = ' and r.branch_location_id = $1';
  }

  const { rows: requisitions } = await db.query<{
    id: string;
    status: RequisitionStatus;
    branch_location_id: string;
    branch_name_ar: string;
    branch_code: string;
    requested_at: Date;
    line_count: number;
  }>(
    `select r.id,
            r.status,
            r.branch_location_id,
            l.name_ar as branch_name_ar,
            l.code as branch_code,
            r.requested_at,
            (select count(*)::int from requisition_lines rl
              where rl.tenant_id = r.tenant_id and rl.requisition_id = r.id) as line_count
       from requisitions r
       join locations l on l.id = r.branch_location_id and l.tenant_id = r.tenant_id
      where r.tenant_id = ${TENANT}${filter}
      order by r.requested_at desc, r.id`,
    params,
  );

  let variants: CatalogueVariant[] = [];
  if (mayRequest) {
    const { rows } = await db.query<CatalogueVariant>(
      `select v.id, v.sku, i.name_ar
         from item_variants v
         join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
        where v.tenant_id = ${TENANT} and v.active and i.active
        order by v.sku`,
    );
    variants = rows;
  }

  return {
    user,
    role: user.role,
    mayRequest,
    mayApprove,
    branchLocationId,
    branchLabel,
    requisitions: requisitions.map((row) => ({
      id: row.id,
      status: row.status,
      branchLocationId: row.branch_location_id,
      branchNameAr: row.branch_name_ar,
      branchCode: row.branch_code,
      requestedAt: new Date(row.requested_at).toISOString(),
      lineCount: row.line_count,
    })),
    variants,
  };
}

/** One requisition line, with every quantity the screen reasons about. */
export interface RequisitionLineView {
  variantId: string;
  /** The stock-keeping code, rendered left-to-right (`.ltr-value`). */
  sku: string;
  nameAr: string;
  requestedQty: number;
  approvedQty: number | null;
  issuedQty: number;
  receivedQty: number;
  /** The line's own status: `open` | `fulfilled` | `short` | `rejected`. */
  lineStatus: string;
  /** `approved_qty` when set, else `requested_qty` — what the line aims at. */
  target: number;
  /** `issued - received`: what is on the road RIGHT NOW. */
  inTransit: number;
  /** `target - issued`: what the warehouse may still release. */
  remainingToIssue: number;
}

/** Everything the detail screen needs. */
export interface RequisitionDetail {
  id: string;
  status: RequisitionStatus;
  branchLocationId: string;
  branchNameAr: string;
  branchCode: string;
  requestedAt: string;
  requestedByName: string;
  notes: string | null;
  lines: RequisitionLineView[];
  /** The acts the CURRENT state and THIS viewer's role permit. */
  actions: RequisitionActionSet;
}

/**
 * What the detail read answers: the document, or a refusal CODE.
 *
 * A requisition this viewer may not see is answered with `invalid` — the SAME
 * code a missing id gets, so the response is not an existence oracle for
 * another branch's document.
 */
export type RequisitionDetailOutcome =
  | ({ ok: true } & RequisitionDetail)
  | { ok: false; error: RequisitionRefusal };

/**
 * Everything the detail screen needs, in ONE read — role- and branch-scoped.
 *
 * The gate is HERE, not in the markup: a `branch_user` may open only a
 * requisition FOR THEIR OWN BRANCH, and a role that is neither branch nor
 * warehouse may open nothing. The viewer's branch is resolved from the session,
 * never from the request.
 */
export async function getRequisition(
  db: Queryable,
  cookie: string | undefined | null,
  id: string,
): Promise<RequisitionDetailOutcome> {
  const user = await currentUser(db, cookie);
  if (!user) return { ok: false, error: 'unauthenticated' };
  if (!canRequest(user.role) && !canApproveOrIssue(user.role)) return { ok: false, error: 'forbidden' };
  if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'invalid' };

  const { rows } = await db.query<{
    id: string;
    status: RequisitionStatus;
    branch_location_id: string;
    branch_name_ar: string;
    branch_code: string;
    requested_at: Date;
    requested_by_name: string;
    notes: string | null;
  }>(
    `select r.id,
            r.status,
            r.branch_location_id,
            l.name_ar as branch_name_ar,
            l.code as branch_code,
            r.requested_at,
            u.name as requested_by_name,
            r.notes
       from requisitions r
       join locations l on l.id = r.branch_location_id and l.tenant_id = r.tenant_id
       join app_users u on u.id = r.requested_by and u.tenant_id = r.tenant_id
      where r.id = $1 and r.tenant_id = ${TENANT}`,
    [id],
  );
  const header = rows[0];
  // Not found and not-yours are the SAME answer, deliberately: one code for
  // both, so this cannot be used to probe what another branch has asked for.
  if (!header) return { ok: false, error: 'invalid' };

  if (canRequest(user.role)) {
    const { rows: mine } = await db.query<{ branch_location_id: string | null }>(
      `select branch_location_id from app_users where id = $1 and tenant_id = ${TENANT}`,
      [user.userId],
    );
    if (mine[0]?.branch_location_id !== header.branch_location_id) {
      return { ok: false, error: 'invalid' };
    }
  }

  const { rows: lineRows } = await db.query<{
    variant_id: string;
    requested_qty: string;
    approved_qty: string | null;
    issued_qty: string;
    received_qty: string;
    status: string;
    sku: string;
    name_ar: string;
  }>(
    `select rl.variant_id,
            rl.requested_qty,
            rl.approved_qty,
            rl.issued_qty,
            rl.received_qty,
            rl.status,
            v.sku,
            i.name_ar
       from requisition_lines rl
       join item_variants v on v.id = rl.variant_id and v.tenant_id = rl.tenant_id
       join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
      where rl.requisition_id = $1 and rl.tenant_id = ${TENANT}
      order by v.sku`,
    [id],
  );

  const lines: RequisitionLineView[] = lineRows.map((row) => {
    const requestedQty = Number(row.requested_qty);
    const approvedQty = row.approved_qty == null ? null : Number(row.approved_qty);
    const issuedQty = Number(row.issued_qty);
    const receivedQty = Number(row.received_qty);
    const target = approvedQty ?? requestedQty;
    return {
      variantId: row.variant_id,
      sku: row.sku,
      nameAr: row.name_ar,
      requestedQty,
      approvedQty,
      issuedQty,
      receivedQty,
      lineStatus: row.status,
      target,
      inTransit: round3(issuedQty - receivedQty),
      remainingToIssue: round3(target - issuedQty),
    };
  });

  return {
    ok: true,
    id: header.id,
    status: header.status,
    branchLocationId: header.branch_location_id,
    branchNameAr: header.branch_name_ar,
    branchCode: header.branch_code,
    requestedAt: new Date(header.requested_at).toISOString(),
    requestedByName: header.requested_by_name,
    notes: header.notes,
    lines,
    actions: availableActions(header.status, user.role),
  };
}

// ---------------------------------------------------------------------------
// The four writes.
// ---------------------------------------------------------------------------

/** The request form as the screen submits it. */
export interface RequestForm {
  /**
   * The screen-minted key for this form. Carried so a form can be recognised,
   * and REQUIRED — a write with no key is a bug, not a shortcut.
   */
  key: string;
  lines: Array<{ variantId: string; requestedQty: number }>;
  notes?: string;
}

/** The approve form as the screen submits it. */
export interface ApproveForm {
  key: string;
  id: string;
  /** Per-line agreed quantities; omitted ⇒ release exactly what was asked. */
  lines?: Array<{ variantId: string; approvedQty: number }>;
}

/** One line of an issue or confirm form, with the state the caller acted FROM. */
export interface FlowLine {
  variantId: string;
  qty: number;
  /**
   * The quantity the CALLER HELD when it rendered the form — `issued_qty` for
   * an issue, `received_qty` for a confirm. It anchors the intent: the ledger
   * key this leg will use is derived from `from + qty`, so a retry of the same
   * intent collides with the movement the first attempt wrote.
   */
  from: number;
}

/** An issue or confirm form. */
export interface FlowForm {
  key: string;
  id: string;
  lines: FlowLine[];
}

/** Requires a non-empty key and a well-formed line list, or refuses as `invalid`. */
function requireFlowForm(form: FlowForm, fn: string): void {
  if (!form || typeof form.key !== 'string' || form.key.trim() === '') {
    throw new RequisitionError('invalid', `${fn}: the form carries no key — reload the screen and try again.`);
  }
  if (typeof form.id !== 'string' || form.id.trim() === '') {
    throw new RequisitionError('invalid', `${fn}: no requisition id was supplied.`);
  }
  if (!Array.isArray(form.lines) || form.lines.length === 0) {
    throw new RequisitionError('invalid', `${fn}: name at least one line.`);
  }
  for (const line of form.lines) {
    if (typeof line.variantId !== 'string' || line.variantId.trim() === '') {
      throw new RequisitionError('invalid', `${fn}: a line has no variant.`);
    }
    if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) {
      throw new RequisitionError('invalid', `${fn}: the quantity for ${line.variantId} must be a number greater than zero.`);
    }
    if (typeof line.from !== 'number' || !Number.isFinite(line.from) || line.from < 0) {
      throw new RequisitionError('invalid', `${fn}: the starting quantity for ${line.variantId} is missing.`);
    }
  }
}

/** Locks and reads a requisition header, or refuses as `invalid` when invisible. */
async function lockRequisition(
  db: Queryable,
  id: string,
  fn: string,
): Promise<{ id: string; status: RequisitionStatus; branch_location_id: string }> {
  const { rows } = await db.query<{ id: string; status: RequisitionStatus; branch_location_id: string }>(
    `select id, status, branch_location_id from requisitions
      where id = $1 and tenant_id = ${TENANT} for update`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new RequisitionError('invalid', `${fn}: requisition ${id} was not found for this tenant.`);
  }
  return row;
}

/** One line's stored quantities as numbers. */
async function readLineState(
  db: Queryable,
  requisitionId: string,
  variantId: string,
): Promise<{ requestedQty: number; approvedQty: number | null; issuedQty: number; receivedQty: number } | null> {
  const { rows } = await db.query<{
    requested_qty: string;
    approved_qty: string | null;
    issued_qty: string;
    received_qty: string;
  }>(
    `select requested_qty, approved_qty, issued_qty, received_qty
       from requisition_lines
      where tenant_id = ${TENANT} and requisition_id = $1 and variant_id = $2`,
    [requisitionId, variantId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    requestedQty: Number(row.requested_qty),
    approvedQty: row.approved_qty == null ? null : Number(row.approved_qty),
    issuedQty: Number(row.issued_qty),
    receivedQty: Number(row.received_qty),
  };
}

/** Has a movement already been posted under this ledger key in this tenant? */
async function movementExists(db: Queryable, key: string): Promise<boolean> {
  const { rows } = await db.query<{ one: number }>(
    `select 1 as one from stock_movements
      where tenant_id = ${TENANT} and idempotency_key = $1
      limit 1`,
    [key],
  );
  return rows.length > 0;
}

/**
 * Creates a requisition for the CALLER'S OWN branch.
 *
 * The branch is resolved from the session (`app_users.branch_location_id`), so a
 * branch user cannot ask on another branch's behalf, and `requested_by` is the
 * session's user id — never a form field. The thing only the person knows — the
 * lines and the quantities — is asked for at entry.
 *
 * `createRequisition` offers no id parameter, so a REPLAY of this form cannot be
 * made idempotent at the database; the screen's in-flight guard (the button is
 * disabled until the action answers, cleared in a `finally`) is what stops a
 * double tap here, and this note is why that guard is not optional.
 */
export async function requestIn(
  db: Queryable,
  cookie: string | undefined | null,
  form: RequestForm,
): Promise<{ requisitionId: string }> {
  const { user, branchLocationId } = await requireBranch(db, cookie);

  if (!form || typeof form.key !== 'string' || form.key.trim() === '') {
    throw new RequisitionError('invalid', 'requestIn: the form carries no key — reload the screen and try again.');
  }
  if (!Array.isArray(form.lines) || form.lines.length === 0) {
    throw new RequisitionError('invalid', 'requestIn: a requisition needs at least one line.');
  }
  for (const line of form.lines) {
    if (typeof line.variantId !== 'string' || line.variantId.trim() === '') {
      throw new RequisitionError('invalid', 'requestIn: a line names no item.');
    }
    if (typeof line.requestedQty !== 'number' || !Number.isFinite(line.requestedQty) || line.requestedQty <= 0) {
      throw new RequisitionError(
        'invalid',
        `requestIn: the quantity for ${line.variantId} must be a number greater than zero.`,
      );
    }
  }

  const created = await createRequisition(db, {
    branchLocationId,
    requestedBy: user.userId,
    lines: form.lines.map((line) => ({ variantId: line.variantId, requestedQty: line.requestedQty })),
    ...(form.notes?.trim() ? { notes: form.notes.trim() } : {}),
  });
  return { requisitionId: created.id };
}

/**
 * Approves a requisition — the warehouse's decision, and nothing else's.
 *
 * The role is checked SERVER-SIDE ({@link requireWarehouse}) before the header
 * is even read, and the state is checked here so a move the state machine
 * refuses is reported as `wrong_state` rather than as a masked throw. Approving
 * with no `lines` releases exactly what was asked for.
 */
export async function approveIn(
  db: Queryable,
  cookie: string | undefined | null,
  form: ApproveForm,
): Promise<{ status: RequisitionStatus }> {
  const user = await requireWarehouse(db, cookie);
  if (!form || typeof form.key !== 'string' || form.key.trim() === '') {
    throw new RequisitionError('invalid', 'approveIn: the form carries no key — reload the screen and try again.');
  }
  if (typeof form.id !== 'string' || form.id.trim() === '') {
    throw new RequisitionError('invalid', 'approveIn: no requisition id was supplied.');
  }

  const requisition = await lockRequisition(db, form.id, 'approveIn');
  if (requisition.status !== 'requested') {
    throw new RequisitionError(
      'wrong_state',
      `approveIn: requisition ${form.id} cannot be approved — its status is '${requisition.status}' (only a 'requested' requisition can be approved).`,
    );
  }

  const approved = await approve(db, form.id, user.userId, form.lines);
  return { status: approved.status };
}

/**
 * Issues stock against an approved (or partly-issued) requisition: warehouse ->
 * transit, through Task 7's `issue`.
 *
 * IDEMPOTENT ON THE INTENT. Each line's ledger key is derived from the CALLER'S
 * `from` plus the quantity ({@link issueAnchor}); if that movement already
 * exists, this exact leg has posted and the call ANSWERS instead of re-posting —
 * which is what makes a double tap land on ONE movement even though a second
 * partial leg would otherwise compute a new cumulative quantity.
 *
 * A QUANTITY THAT WOULD EXCEED THE TARGET IS REFUSED BEFORE ANY WRITE, as
 * `wrong_state`, so a change of mind under an old key is refused rather than
 * answered with the old row as success.
 */
export async function issueIn(
  db: Queryable,
  cookie: string | undefined | null,
  form: FlowForm,
): Promise<{ status: RequisitionStatus }> {
  await requireWarehouse(db, cookie);
  requireFlowForm(form, 'issueIn');

  // Take the header lock FIRST, so the replay check and the write are one
  // critical section: a concurrent second caller waits here, then sees the
  // movement the first one wrote and replays instead of issuing again.
  const requisition = await lockRequisition(db, form.id, 'issueIn');

  let allPosted = true;
  for (const line of form.lines) {
    const anchor = issueAnchor(form.id, line.variantId, round3(line.from + line.qty));
    if (!(await movementExists(db, anchor))) allPosted = false;
  }
  if (allPosted) return { status: requisition.status };

  for (const line of form.lines) {
    const stored = await readLineState(db, form.id, line.variantId);
    if (!stored) {
      throw new RequisitionError('invalid', `issueIn: variant ${line.variantId} is not a line on requisition ${form.id}.`);
    }
    const target = stored.approvedQty ?? stored.requestedQty;
    const problem = issueProblem(requisition.status, { target, issued: stored.issuedQty }, line.qty);
    if (problem) {
      throw new RequisitionError(
        problem,
        `issueIn: line ${line.variantId} on requisition ${form.id} — cannot issue ${line.qty} from '${requisition.status}' (issued ${stored.issuedQty} of ${target}).`,
      );
    }
  }

  const result = await issue(
    db,
    form.id,
    form.lines.map((line) => ({ variantId: line.variantId, qty: line.qty })),
  );
  return { status: result.status };
}

/**
 * Confirms receipt — the branch's act, for its OWN branch, through Task 7's
 * `confirmReceipt` (transit -> branch).
 *
 * THIS IS WHERE STOCK BECOMES THE BRANCH'S. The refusal guards mirror Task 7
 * EXACTLY ({@link confirmProblem}), so confirming more than is still in transit
 * is refused as `wrong_state` before a round trip, and an over-confirm never
 * writes a movement. A `partially_issued` requisition is confirmable PER LINE,
 * limited to `issued - received`, which is what lets the desk acknowledge what
 * has arrived while the rest is still on the road.
 *
 * IDEMPOTENT ON THE INTENT, exactly as {@link issueIn}: the ledger key is
 * derived from the caller's `from` plus the quantity, so a retry of one confirm
 * leg lands on the movement it already wrote.
 */
export async function confirmIn(
  db: Queryable,
  cookie: string | undefined | null,
  form: FlowForm,
): Promise<{ status: RequisitionStatus }> {
  const { branchLocationId } = await requireBranch(db, cookie);
  requireFlowForm(form, 'confirmIn');

  const requisition = await lockRequisition(db, form.id, 'confirmIn');
  if (requisition.branch_location_id !== branchLocationId) {
    throw new RequisitionError(
      'forbidden',
      `confirmIn: requisition ${form.id} is not for your branch — a branch confirms only its own deliveries.`,
    );
  }

  let allPosted = true;
  for (const line of form.lines) {
    const anchor = confirmAnchor(form.id, line.variantId, round3(line.from + line.qty));
    if (!(await movementExists(db, anchor))) allPosted = false;
  }
  if (allPosted) return { status: requisition.status };

  for (const line of form.lines) {
    const stored = await readLineState(db, form.id, line.variantId);
    if (!stored) {
      throw new RequisitionError('invalid', `confirmIn: variant ${line.variantId} is not a line on requisition ${form.id}.`);
    }
    const problem = confirmProblem(
      requisition.status,
      { issued: stored.issuedQty, received: stored.receivedQty },
      line.qty,
    );
    if (problem) {
      throw new RequisitionError(
        problem,
        `confirmIn: line ${line.variantId} on requisition ${form.id} — cannot receive ${line.qty} from '${requisition.status}' (issued ${stored.issuedQty}, already received ${stored.receivedQty}).`,
      );
    }
  }

  const result = await confirmReceipt(
    db,
    form.id,
    form.lines.map((line) => ({ variantId: line.variantId, qty: line.qty })),
  );
  return { status: result.status };
}
