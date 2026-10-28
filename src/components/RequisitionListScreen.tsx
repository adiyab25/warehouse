'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { requestLines } from '../app/requisitions/actions';
import type { RequisitionRefusal } from '../domain/requisition-ui';
import { REFUSAL_MESSAGE_KEYS } from '../domain/requisition-ui';
import type { RequisitionStatus } from '../domain/requisition';
import { formatDate, formatNumber, t, type Lang } from '../i18n';

/**
 * THE REQUISITION LIST — what a branch user or the warehouse opens first.
 *
 * `lang` is the request's resolved language, passed down from the server page,
 * so every label, date and number follows the app's language and direction.
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

export function RequisitionListScreen({
  mayRequest,
  branchLabel,
  variants,
  requisitions,
  lang,
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
        <p className="field-hint">{t('requisitions.list.empty', lang)}</p>
      ) : (
        <ul className="req-list">
          {requisitions.map((req) => (
            <li key={req.id} className="req-item">
              <a className="req-link" href={`/requisitions/${req.id}`}>
                <span className="req-summary">
                  <span className="req-branch-name">
                    {req.branchNameAr} ({req.branchCode})
                  </span>
                  <span className="req-status">{statusLabel(req.status, lang)}</span>
                </span>
                <span className="req-meta">
                  {t('requisitions.list.lines', { lang, params: { count: formatNumber(req.lineCount, lang) } })}
                  {' · '}
                  {formatDate(new Date(req.requestedAt), lang)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {mayRequest ? (
        <section className="req-section">
          <h2>{t('requisitions.new.heading', lang)}</h2>
          {branchLabel ? (
            <p className="req-meta">{t('requisitions.new.for', { lang, params: { branch: branchLabel } })}</p>
          ) : null}

          {variants.length === 0 ? (
            <p role="alert" className="req-problem">
              {t('requisitions.new.no_variants', lang)}
            </p>
          ) : (
            <>
              <label htmlFor="req-variant">{t('requisitions.new.variant', lang)}</label>
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

              <label htmlFor="req-qty">{t('requisitions.new.qty', lang)}</label>
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
                {t('requisitions.new.add', lang)}
              </button>

              {draft.length === 0 ? (
                <p className="field-hint">{t('requisitions.new.no_lines', lang)}</p>
              ) : (
                <ul className="req-lines">
                  {draft.map((line) => (
                    <li key={line.id} className="req-line">
                      <div className="req-line-head">
                        <span className="req-line-name">{line.nameAr}</span>
                        <span className="ltr-value req-line-code">{line.sku}</span>
                        <span className="req-meta">
                          {t('requisitions.line.requested', lang)}: {formatNumber(Number(line.qty), lang)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="req-remove"
                        onClick={() => setDraft((prev) => prev.filter((row) => row.id !== line.id))}
                      >
                        {t('requisitions.new.remove', lang)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {problem ? (
                <p role="alert" className="req-problem">
                  {t(REFUSAL_MESSAGE_KEYS[problem], lang)}
                </p>
              ) : null}
              {sent ? (
                <p className="req-ok" aria-live="polite">
                  {t('requisitions.ok.requested', lang)}
                </p>
              ) : null}

              <button type="button" className="req-primary" onClick={submit} disabled={busy}>
                {busy ? t('requisitions.new.submitting', lang) : t('requisitions.new.submit', lang)}
              </button>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}