'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { approveRequisition, confirmLines, issueLines } from '../app/requisitions/actions';
import type { RequisitionLineView } from '../app/requisitions/handler';
import type { RequisitionStatus } from '../domain/requisition';
import { REFUSAL_MESSAGE_KEYS, type RequisitionRefusal } from '../domain/requisition-ui';
import { formatDate, formatNumber, t } from '../i18n';

/**
 * THE REQUISITION DETAIL — the state machine's desk.
 *
 * Four decisions shape it:
 *
 *   1. ONLY THE ACTS THE CURRENT STATE AND THE VIEWER'S ROLE PERMIT ARE RENDERED,
 *      and which those are comes from `availableActions` (a pure rule), never
 *      from a guess in the markup. A `requested` document shows Approve to the
 *      warehouse and nothing to the branch; an `issued` or `partially_issued` one
 *      shows Issue to the warehouse and Confirm to the branch.
 *
 *   2. PARTIAL IS DRIVABLE FROM HERE, NOT ONLY FROM THE SEAM. An
 *      `approved`/`partially_issued` document puts an editable "release" quantity
 *      on every line with something left to release, and an
 *      `issued`/`partially_issued` one puts a "received" quantity on every line
 *      with stock on the road — so the rest can be released and what arrived can
 *      be acknowledged, per line, without leaving the screen.
 *
 *   3. A PARTIAL OUTCOME IS SAID PLAINLY. The action answers with the state the
 *      flow LANDED IN, so landing in `partially_issued` renders "issued in part —
 *      the rest is still to release" rather than a flat success.
 *
 *   4. A REFUSAL IS ITS OWN MESSAGE. The action answers with a CODE
 *      (`wrong_state`, `forbidden`, …) and this screen renders that code's own
 *      string — never one blanket "something went wrong".
 *
 * Every action's in-flight flag is cleared in a `finally`, so a failure can
 * never leave a button permanently disabled. A machine-read SKU keeps
 * `.ltr-value`; every number and date goes through the Task 11 formatters, so
 * `ar` never renders Arabic-Indic digits.
 */

export type RequisitionLineItem = RequisitionLineView;

export interface RequisitionDetailScreenProps {
  id: string;
  status: RequisitionStatus;
  branchNameAr: string;
  branchCode: string;
  requestedAt: string;
  requestedByName: string;
  notes: string | null;
  lines: RequisitionLineItem[];
  /** The acts the CURRENT state and THIS viewer's role permit. */
  actions: { canApprove: boolean; canIssue: boolean; canConfirm: boolean };
}

/** A uuid v4 for a form's key (with a hand-rolled fallback, as the intake door has). */
function randomUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const value = Math.floor(Math.random() * 16);
    return (ch === 'x' ? value : (value % 4) + 8).toString(16);
  });
}

/**
 * The translated label for a requisition state — a SWITCH of LITERAL keys, so the
 * i18n guard that walks this file sees every status key it must have.
 */
export function statusLabel(status: RequisitionStatus): string {
  switch (status) {
    case 'requested':
      return t('requisitions.status.requested');
    case 'approved':
      return t('requisitions.status.approved');
    case 'partially_issued':
      return t('requisitions.status.partially_issued');
    case 'issued':
      return t('requisitions.status.issued');
    case 'received':
      return t('requisitions.status.received');
    case 'closed':
      return t('requisitions.status.closed');
    case 'rejected':
      return t('requisitions.status.rejected');
    case 'returned':
      return t('requisitions.status.returned');
  }
}

/** The translated label for a LINE's own status. */
export function lineStatusLabel(status: string): string {
  switch (status) {
    case 'fulfilled':
      return t('requisitions.line_status.fulfilled');
    case 'short':
      return t('requisitions.line_status.short');
    case 'rejected':
      return t('requisitions.line_status.rejected');
    default:
      return t('requisitions.line_status.open');
  }
}

/**
 * The message for a flow that has just landed, said honestly.
 *
 * `partially_issued` is NOT a success sentence: more is still to come.
 */
function landedMessage(status: RequisitionStatus, action: 'issue' | 'confirm', outstanding: number): string {
  if (action === 'issue') {
    if (status === 'partially_issued') {
      return t('requisitions.ok.issued_partial', { params: { count: formatNumber(outstanding) } });
    }
    return t('requisitions.ok.issued');
  }
  if (status === 'partially_issued') {
    return t('requisitions.ok.confirmed_partial', { params: { count: formatNumber(outstanding) } });
  }
  return t('requisitions.ok.confirmed');
}

/** A typed quantity, or `null` when the field is empty or not a number. */
function parseQty(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function RequisitionDetailScreen({
  id,
  status,
  branchNameAr,
  branchCode,
  requestedAt,
  requestedByName,
  notes,
  lines,
  actions,
}: RequisitionDetailScreenProps) {
  const router = useRouter();

  const [approveKey] = useState(randomUuid);
  const [issueKey, setIssueKey] = useState(randomUuid);
  const [confirmKey, setConfirmKey] = useState(randomUuid);

  const [approving, setApproving] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<RequisitionRefusal | null>(null);
  const [landed, setLanded] = useState<string | null>(null);

  // The quantities the desk types, seeded from what the state ACTUALLY shows so
  // the common case is one tap: release the remainder, confirm what is on the road.
  const [issueQty, setIssueQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.variantId, String(line.remainingToIssue)])),
  );
  const [confirmQty, setConfirmQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.variantId, String(line.inTransit)])),
  );

  const issueable = lines.filter((line) => line.remainingToIssue > 0);
  const confirmable = lines.filter((line) => line.inTransit > 0);

  /** The lines whose typed quantity is a real positive number. */
  function typedLines(qty: Record<string, string>, only: RequisitionLineView[]) {
    return only
      .map((line) => ({ line, qty: parseQty(qty[line.variantId] ?? '') }))
      .filter((row): row is { line: RequisitionLineView; qty: number } => row.qty != null && row.qty > 0);
  }

  /** Approve. The in-flight flag is cleared in `finally` on every path. */
  async function doApprove() {
    setProblem(null);
    setLanded(null);
    setApproving(true);
    try {
      const result = await approveRequisition({ key: approveKey, id });
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      setLanded(t('requisitions.ok.approved'));
      router.refresh();
    } catch {
      setProblem('invalid');
    } finally {
      setApproving(false);
    }
  }

  /** Release stock, line by line, for the quantities the desk typed. */
  async function doIssue() {
    setProblem(null);
    setLanded(null);
    const chosen = typedLines(issueQty, issueable);
    if (chosen.length === 0) {
      setProblem('invalid');
      return;
    }
    setIssuing(true);
    try {
      const result = await issueLines({
        key: issueKey,
        id,
        lines: chosen.map(({ line, qty }) => ({ variantId: line.variantId, qty, from: line.issuedQty })),
      });
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      const outstanding = lines.filter((line) => line.target - line.issuedQty > 0).length;
      setLanded(landedMessage(result.status ?? status, 'issue', outstanding));
      setIssueKey(randomUuid());
      router.refresh();
    } catch {
      setProblem('invalid');
    } finally {
      setIssuing(false);
    }
  }

  /** Acknowledge what arrived, line by line, limited to what is on the road. */
  async function doConfirm() {
    setProblem(null);
    setLanded(null);
    const chosen = typedLines(confirmQty, confirmable);
    if (chosen.length === 0) {
      setProblem('invalid');
      return;
    }
    setConfirming(true);
    try {
      const result = await confirmLines({
        key: confirmKey,
        id,
        lines: chosen.map(({ line, qty }) => ({ variantId: line.variantId, qty, from: line.receivedQty })),
      });
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      const outstanding = lines.filter((line) => line.target - line.issuedQty > 0 || line.inTransit > 0).length;
      setLanded(landedMessage(result.status ?? status, 'confirm', outstanding));
      setConfirmKey(randomUuid());
      router.refresh();
    } catch {
      setProblem('invalid');
    } finally {
      setConfirming(false);
    }
  }

  const busy = approving || issuing || confirming;

  return (
    <div className="req">
      <p className="req-detail-branch">
        {t('requisitions.detail.branch', { params: { name: `${branchNameAr} (${branchCode})` } })}
      </p>
      <p className="req-status-line">
        <span className="req-status">{statusLabel(status)}</span>
      </p>
      <p className="req-meta">
        {t('requisitions.detail.requested_at', { params: { date: formatDate(new Date(requestedAt)) } })}
      </p>
      <p className="req-meta">
        {t('requisitions.detail.requested_by', { params: { name: requestedByName } })}
      </p>
      {notes ? (
        <p className="req-meta">{t('requisitions.detail.notes', { params: { notes } })}</p>
      ) : null}

      <section className="req-section">
        <h2>{t('requisitions.detail.lines')}</h2>
        <ul className="req-lines">
          {lines.map((line) => (
            <li key={line.variantId} className="req-line">
              <div className="req-line-head">
                {/* The product: shrinkable and breakable (globals.css). */}
                <span className="req-line-name">{line.nameAr}</span>
                {/* The machine-read code stays left-to-right. */}
                <span className="ltr-value req-line-code">{line.sku}</span>
                <span className="req-meta req-line-status">{lineStatusLabel(line.lineStatus)}</span>
              </div>

              <dl className="req-quantities">
                <div className="req-quantity">
                  <dt>{t('requisitions.line.requested')}</dt>
                  <dd>{formatNumber(line.requestedQty)}</dd>
                </div>
                <div className="req-quantity">
                  <dt>{t('requisitions.line.approved')}</dt>
                  <dd>{line.approvedQty == null ? '—' : formatNumber(line.approvedQty)}</dd>
                </div>
                <div className="req-quantity">
                  <dt>{t('requisitions.line.issued')}</dt>
                  <dd>{formatNumber(line.issuedQty)}</dd>
                </div>
                <div className="req-quantity">
                  <dt>{t('requisitions.line.received')}</dt>
                  <dd>{formatNumber(line.receivedQty)}</dd>
                </div>
              </dl>

              {line.inTransit > 0 ? (
                <p className="req-meta">
                  {t('requisitions.line.in_transit', { params: { count: formatNumber(line.inTransit) } })}
                </p>
              ) : null}
              {line.remainingToIssue > 0 ? (
                <p className="req-meta">
                  {t('requisitions.line.remaining', {
                    params: { count: formatNumber(line.remainingToIssue) },
                  })}
                </p>
              ) : null}

              {actions.canIssue && line.remainingToIssue > 0 ? (
                <label className="req-qty">
                  {t('requisitions.action.issue')}
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    value={issueQty[line.variantId] ?? ''}
                    aria-label={`${t('requisitions.action.issue')} — ${line.sku}`}
                    onChange={(event) =>
                      setIssueQty((prev) => ({ ...prev, [line.variantId]: event.target.value }))
                    }
                  />
                </label>
              ) : null}

              {actions.canConfirm && line.inTransit > 0 ? (
                <label className="req-qty">
                  {t('requisitions.action.confirm')}
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    value={confirmQty[line.variantId] ?? ''}
                    aria-label={`${t('requisitions.action.confirm')} — ${line.sku}`}
                    onChange={(event) =>
                      setConfirmQty((prev) => ({ ...prev, [line.variantId]: event.target.value }))
                    }
                  />
                </label>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {problem ? (
        <p role="alert" className="req-problem">
          {t(REFUSAL_MESSAGE_KEYS[problem])}
        </p>
      ) : null}
      {landed ? (
        <p className="req-ok" aria-live="polite">
          {landed}
        </p>
      ) : null}

      <div className="req-actions">
        {/* APPROVE — only a `requested` document, and only the warehouse. */}
        {actions.canApprove ? (
          <button type="button" className="req-primary" onClick={doApprove} disabled={busy}>
            {approving ? t('requisitions.action.approving') : t('requisitions.action.approve')}
          </button>
        ) : null}

        {/* ISSUE — only `approved`/`partially_issued`, and only the warehouse. */}
        {actions.canIssue && issueable.length > 0 ? (
          <button type="button" className="req-primary" onClick={doIssue} disabled={busy}>
            {issuing ? t('requisitions.action.issuing') : t('requisitions.action.issue')}
          </button>
        ) : null}

        {/* CONFIRM — only where stock is really IN TRANSIT, and only the branch. */}
        {actions.canConfirm && confirmable.length > 0 ? (
          <button type="button" className="req-primary" onClick={doConfirm} disabled={busy}>
            {confirming ? t('requisitions.action.confirming') : t('requisitions.action.confirm')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
