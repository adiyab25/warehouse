'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { requestLines } from '../app/requisitions/actions';
import type { RequisitionRefusal } from '../domain/requisition-ui';
import { REFUSAL_MESSAGE_KEYS } from '../domain/requisition-ui';
import type { RequisitionStatus } from '../domain/requisition';
import { formatDate, formatNumber, t } from '../i18n';

/**
 * THE REQUISITION LIST — what a branch user or the warehouse opens first.
 *
 * Two decisions shape it:
 *
 *   1. IT IS USED STANDING UP, ON A PHONE. One narrow column, generous tap
 *      targets, no desktop-only affordances, and NO local field styling — the
 *      shared rules in globals.css paint every input and button. The document is
 *      Arabic and RTL (dir is inherited from the root layout); the only LTR
 *      exception is a machine-read SKU, which keeps `.ltr-value`.
 *
 *   2. A DUPLICATE REQUEST IS GUARDED BY THE IN-FLIGHT FLAG, NOT BY A KEY. The
 *      form carries no idempotency key: `createRequisition` takes no id and the
 *      table has no place to store one, so a replayed form cannot be
 *      de-duplicated at the database. The submit button is therefore DISABLED
 *      until the action answers and cleared in a `finally`, and that guard is
 *      what stops a double tap — which is why it is not optional.
 *
 * Everything the system already knows is resolved SERVER-SIDE and never sent
 * from here: the branch the stock is for is the branch the session belongs to,
 * and `requested_by` is the session's user. Only what the person at the desk
 * knows — which items, and how many — is typed.
 */

/** One option in the request form's item list, flattened for the client boundary. */
export interface CatalogueOption {
  id: string;
  sku: string;
  nameAr: string;
}

/** One requisition as the list shows it — already flattened by the page. */
export interface RequisitionListItem {
  id: string;
  status: RequisitionStatus;
  branchNameAr: string;
  branchCode: string;
  requestedAt: string;
  lineCount: number;
}

export interface RequisitionListScreenProps {
  /** May the viewer ask for stock (and so see the request form)? */
  mayRequest: boolean;
  /** The viewer's own branch label ("فرع أ (BR-UA)"), or `null`. */
  branchLabel: string | null;
  /** The catalogue the request form may name. */
  variants: CatalogueOption[];
  requisitions: RequisitionListItem[];
}

/**
 * The translated label for a requisition state.
 *
 * A SWITCH of LITERAL keys on purpose: it keeps every status key visible to the
 * i18n guard that walks this file for translation-call literals, so a state
 * whose string was never added fails the suite instead of rendering its key on
 * screen.
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

export function RequisitionListScreen({
  mayRequest,
  branchLabel,
  variants,
  requisitions,
}: RequisitionListScreenProps) {
  const router = useRouter();

  const [pickedVariant, setPickedVariant] = useState(variants[0]?.id ?? '');
  const [pickedQty, setPickedQty] = useState('1');
  const [draft, setDraft] = useState<Array<{ id: string; sku: string; nameAr: string; qty: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<RequisitionRefusal | null>(null);
  const [sent, setSent] = useState(false);

  const parsed = draft.map((line) => ({ ...line, qtyNum: Number(line.qty) }));
  const ready =
    parsed.length > 0 &&
    parsed.every((line) => Number.isFinite(line.qtyNum) && line.qtyNum > 0) &&
    !busy;

  /** Adds the picked item to the draft, or tops up the line already there. */
  function addLine() {
    const variant = variants.find((v) => v.id === pickedVariant);
    const qty = Number(pickedQty);
    if (!variant || !Number.isFinite(qty) || qty <= 0) return;
    setDraft((prev) => {
      const existing = prev.find((line) => line.id === variant.id);
      if (existing) {
        return prev.map((line) =>
          line.id === variant.id ? { ...line, qty: String(Number(line.qty) + qty) } : line,
        );
      }
      return [...prev, { id: variant.id, sku: variant.sku, nameAr: variant.nameAr, qty: String(qty) }];
    });
    setPickedQty('1');
  }

  /**
   * Sends the request. The ONLY thing here that writes.
   *
   * The in-flight flag is cleared in `finally`, and the action ANSWERS with a
   * coded outcome — a refusal reaches the desk as ITS OWN message, never as
   * "you are not signed in".
   */
  async function submit() {
    setProblem(null);
    setSent(false);
    if (!ready) {
      setProblem('invalid');
      return;
    }
    setBusy(true);
    try {
      const result = await requestLines({
        lines: parsed.map((line) => ({ variantId: line.id, requestedQty: line.qtyNum })),
      });
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      setSent(true);
      setDraft([]);
      router.refresh();
    } catch {
      setProblem('invalid');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="req">
      {requisitions.length === 0 ? (
        <p className="field-hint">{t('requisitions.list.empty')}</p>
      ) : (
        <ul className="req-list">
          {requisitions.map((req) => (
            <li key={req.id} className="req-item">
              <a className="req-link" href={`/requisitions/${req.id}`}>
                <span className="req-summary">
                  {/* The branch, a right-to-left catalogue string in a flex
                      item: allowed to shrink and to break (see globals.css). */}
                  <span className="req-branch-name">
                    {req.branchNameAr} ({req.branchCode})
                  </span>
                  <span className="req-status">{statusLabel(req.status)}</span>
                </span>
                <span className="req-meta">
                  {t('requisitions.list.lines', { params: { count: formatNumber(req.lineCount) } })}
                  {' · '}
                  {formatDate(new Date(req.requestedAt))}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {mayRequest ? (
        <section className="req-section">
          <h2>{t('requisitions.new.heading')}</h2>
          {branchLabel ? (
            <p className="req-meta">{t('requisitions.new.for', { params: { branch: branchLabel } })}</p>
          ) : null}

          {variants.length === 0 ? (
            <p role="alert" className="req-problem">
              {t('requisitions.new.no_variants')}
            </p>
          ) : (
            <>
              <label htmlFor="req-variant">{t('requisitions.new.variant')}</label>
              <select
                id="req-variant"
                name="variant"
                value={pickedVariant}
                onChange={(event) => setPickedVariant(event.target.value)}
              >
                {variants.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {variant.nameAr} — {variant.sku}
                  </option>
                ))}
              </select>

              <label htmlFor="req-qty">{t('requisitions.new.qty')}</label>
              <input
                id="req-qty"
                name="qty"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={pickedQty}
                onChange={(event) => setPickedQty(event.target.value)}
              />

              <button type="button" className="req-add" onClick={addLine} disabled={busy}>
                {t('requisitions.new.add')}
              </button>

              {draft.length === 0 ? (
                <p className="field-hint">{t('requisitions.new.no_lines')}</p>
              ) : (
                <ul className="req-lines">
                  {draft.map((line) => (
                    <li key={line.id} className="req-line">
                      <div className="req-line-head">
                        <span className="req-line-name">{line.nameAr}</span>
                        <span className="ltr-value req-line-code">{line.sku}</span>
                        <span className="req-meta">
                          {t('requisitions.line.requested')}: {formatNumber(Number(line.qty))}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="req-remove"
                        onClick={() => setDraft((prev) => prev.filter((row) => row.id !== line.id))}
                      >
                        {t('requisitions.new.remove')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {problem ? (
                <p role="alert" className="req-problem">
                  {t(REFUSAL_MESSAGE_KEYS[problem])}
                </p>
              ) : null}
              {sent ? (
                <p className="req-ok" aria-live="polite">
                  {t('requisitions.ok.requested')}
                </p>
              ) : null}

              <button type="button" className="req-primary" onClick={submit} disabled={busy}>
                {busy ? t('requisitions.new.submitting') : t('requisitions.new.submit')}
              </button>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
