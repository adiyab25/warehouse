'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { approveRequisition, confirmLines, issueLines } from '@/app/requisitions/actions';
import type { RequisitionLineView } from '@/app/requisitions/handler';
import type { RequisitionStatus } from '../domain/requisition';
import { REFUSAL_MESSAGE_KEYS, type RequisitionRefusal } from '../domain/requisition-ui';
import { formatDate, formatNumber, t, type Lang } from '@/i18n';
import { EmptyState } from '@/modules/shell/ui/EmptyState';
import { PageHeader } from '@/modules/shell/ui/PageHeader';
import { StatusBadge } from '@/modules/shell/ui/StatusBadge';

/**
 * THE REQUISITION DETAIL — the state machine's desk.
 *
 * `lang` is the request's resolved language, passed down from the server page,
 * so every label, date and number follows the app's language and direction.
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
  /** The request's resolved language. */
  lang: Lang;
}

/** The translated label for a requisition state — a SWITCH of LITERAL keys. */
export function statusLabel(status: RequisitionStatus, lang: Lang): string {
  switch (status) {
    case 'requested':
      return t('requisitions.status.requested', lang);
    case 'approved':
      return t('requisitions.status.approved', lang);
    case 'partially_issued':
      return t('requisitions.status.partially_issued', lang);
    case 'issued':
      return t('requisitions.status.issued', lang);
    case 'received':
      return t('requisitions.status.received', lang);
    case 'closed':
      return t('requisitions.status.closed', lang);
    case 'rejected':
      return t('requisitions.status.rejected', lang);
    case 'returned':
      return t('requisitions.status.returned', lang);
  }
}

/** The translated label for a LINE's own status. */
export function lineStatusLabel(status: string, lang: Lang): string {
  switch (status) {
    case 'fulfilled':
      return t('requisitions.line_status.fulfilled', lang);
    case 'short':
      return t('requisitions.line_status.short', lang);
    case 'rejected':
      return t('requisitions.line_status.rejected', lang);
    default:
      return t('requisitions.line_status.open', lang);
  }
}

/** The message for a flow that has just landed, said honestly. */
function landedMessage(status: RequisitionStatus, action: 'issue' | 'confirm', outstanding: number, lang: Lang): string {
  if (action === 'issue') {
    if (status === 'partially_issued') {
      return t('requisitions.ok.issued_partial', { lang, params: { count: formatNumber(outstanding, lang) } });
    }
    return t('requisitions.ok.issued', lang);
  }
  if (status === 'partially_issued') {
    return t('requisitions.ok.confirmed_partial', { lang, params: { count: formatNumber(outstanding, lang) } });
  }
  return t('requisitions.ok.confirmed', lang);
}

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
  lang,
}: RequisitionDetailScreenProps) {
  const router = useRouter();

  const [approving, setApproving] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<RequisitionRefusal | null>(null);
  const [landed, setLanded] = useState<string | null>(null);

  const [issueQty, setIssueQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.variantId, String(line.remainingToIssue)])),
  );
  const [confirmQty, setConfirmQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.variantId, String(line.inTransit)])),
  );

  // RE-SEED WHEN THE STATE MOVES, WITHOUT REMOUNTING.
  const signature = lines.map((line) => `${line.variantId}:${line.issuedQty}:${line.receivedQty}`).join('|');
  const [seenSignature, setSeenSignature] = useState(signature);
  if (signature !== seenSignature) {
    setSeenSignature(signature);
    setIssueQty(Object.fromEntries(lines.map((line) => [line.variantId, String(line.remainingToIssue)])));
    setConfirmQty(Object.fromEntries(lines.map((line) => [line.variantId, String(line.inTransit)])));
  }

  const issueable = lines.filter((line) => line.remainingToIssue > 0);
  const confirmable = lines.filter((line) => line.inTransit > 0);

  function typedLines(qty: Record<string, string>, only: RequisitionLineView[]) {
    return only
      .map((line) => ({ line, qty: parseQty(qty[line.variantId] ?? '') }))
      .filter((row): row is { line: RequisitionLineView; qty: number } => row.qty != null && row.qty > 0);
  }

  async function doApprove() {
    setProblem(null);
    setLanded(null);
    setApproving(true);
    try {
      const result = await approveRequisition({ id });
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      setLanded(t('requisitions.ok.approved', lang));
      router.refresh();
    } catch {
      setProblem('invalid');
    } finally {
      setApproving(false);
    }
  }

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
        id,
        lines: chosen.map(({ line, qty }) => ({ variantId: line.variantId, qty, from: line.issuedQty })),
      });
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      const outstanding = lines.filter((line) => line.target - line.issuedQty > 0).length;
      setLanded(landedMessage(result.status ?? status, 'issue', outstanding, lang));
      router.refresh();
    } catch {
      setProblem('invalid');
    } finally {
      setIssuing(false);
    }
  }

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
        id,
        lines: chosen.map(({ line, qty }) => ({ variantId: line.variantId, qty, from: line.receivedQty })),
      });
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      const outstanding = lines.filter((line) => line.target - line.issuedQty > 0 || line.inTransit > 0).length;
      setLanded(landedMessage(result.status ?? status, 'confirm', outstanding, lang));
      router.refresh();
    } catch {
      setProblem('invalid');
    } finally {
      setConfirming(false);
    }
  }

  const busy = approving || issuing || confirming;

  return (
    <div className="space-y-4">
      <PageHeader title={t('requisitions.title', lang)} />
      <p className="req-detail-branch">
        {t('requisitions.detail.branch', { lang, params: { name: `${branchNameAr} (${branchCode})` } })}
      </p>
      <p className="req-status-line">
        <StatusBadge status={status} />
      </p>
      <p className="req-meta">
        {t('requisitions.detail.requested_at', { lang, params: { date: formatDate(new Date(requestedAt), lang) } })}
      </p>
      <p className="req-meta">
        {t('requisitions.detail.requested_by', { lang, params: { name: requestedByName } })}
      </p>
      {notes ? (
        <p className="req-meta">{t('requisitions.detail.notes', { lang, params: { notes } })}</p>
      ) : null}

      <section className="req-section">
        <h2>{t('requisitions.detail.lines', lang)}</h2>
        <ul className="req-lines">
          {lines.map((line) => (
            <li key={line.variantId} className="req-line">
              <div className="req-line-head">
                <span className="req-line-name">{line.nameAr}</span>
                <span className="ltr-value req-line-code">{line.sku}</span>
                <span className="req-meta req-line-status">{lineStatusLabel(line.lineStatus, lang)}</span>
              </div>

              <dl className="req-quantities">
                <div className="req-quantity">
                  <dt>{t('requisitions.line.requested', lang)}</dt>
                  <dd>{formatNumber(line.requestedQty, lang)}</dd>
                </div>
                <div className="req-quantity">
                  <dt>{t('requisitions.line.approved', lang)}</dt>
                  <dd>{line.approvedQty == null ? '—' : formatNumber(line.approvedQty, lang)}</dd>
                </div>
                <div className="req-quantity">
                  <dt>{t('requisitions.line.issued', lang)}</dt>
                  <dd>{formatNumber(line.issuedQty, lang)}</dd>
                </div>
                <div className="req-quantity">
                  <dt>{t('requisitions.line.received', lang)}</dt>
                  <dd>{formatNumber(line.receivedQty, lang)}</dd>
                </div>
              </dl>

              {line.inTransit > 0 ? (
                <p className="req-meta">
                  {t('requisitions.line.in_transit', { lang, params: { count: formatNumber(line.inTransit, lang) } })}
                </p>
              ) : null}
              {line.remainingToIssue > 0 ? (
                <p className="req-meta">
                  {t('requisitions.line.remaining', {
                    lang,
                    params: { count: formatNumber(line.remainingToIssue, lang) },
                  })}
                </p>
              ) : null}

              {actions.canIssue && line.remainingToIssue > 0 ? (
                <label className="req-qty">
                  {t('requisitions.line.release_qty', lang)}
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    value={issueQty[line.variantId] ?? ''}
                    aria-label={`${t('requisitions.action.issue', lang)} — ${line.sku}`}
                    onChange={(event) =>
                      setIssueQty((prev) => ({ ...prev, [line.variantId]: event.target.value }))
                    }
                  />
                </label>
              ) : null}

              {actions.canConfirm && line.inTransit > 0 ? (
                <label className="req-qty">
                  {t('requisitions.line.receive_qty', lang)}
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    value={confirmQty[line.variantId] ?? ''}
                    aria-label={`${t('requisitions.action.confirm', lang)} — ${line.sku}`}
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
          {t(REFUSAL_MESSAGE_KEYS[problem], lang)}
        </p>
      ) : null}
      {landed ? (
        <p className="req-ok" aria-live="polite">
          {landed}
        </p>
      ) : null}

      <div className="req-actions">
        {actions.canApprove ? (
          <button type="button" className="req-primary" onClick={doApprove} disabled={busy}>
            {approving ? t('requisitions.action.approving', lang) : t('requisitions.action.approve', lang)}
          </button>
        ) : null}

        {actions.canIssue && issueable.length > 0 ? (
          <button type="button" className="req-primary" onClick={doIssue} disabled={busy}>
            {issuing ? t('requisitions.action.issuing', lang) : t('requisitions.action.issue', lang)}
          </button>
        ) : null}

        {actions.canConfirm && confirmable.length > 0 ? (
          <button type="button" className="req-primary" onClick={doConfirm} disabled={busy}>
            {confirming ? t('requisitions.action.confirming', lang) : t('requisitions.action.confirm', lang)}
          </button>
        ) : null}
      </div>
    </div>
  );
}