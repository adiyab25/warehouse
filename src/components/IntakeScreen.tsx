'use client';

import { useState } from 'react';

import { checkNote, scan, submitReceipt } from '../app/intake/actions';
import type { SubmitOutcome } from '../app/intake/handler';
import { REFUSAL_MESSAGE_KEYS, type IntakeRefusal, type ReceiptForm } from '../domain/intake';
import { formatDate, formatNumber, t, type Lang } from '../i18n';
import { ExpectedVsReceived, type ExpectedVsReceivedLine } from './ExpectedVsReceived';
import { ScanField } from './ScanField';

/**
 * THE INTAKE DOOR — the screen the warehouse manager stands in front of with a
 * lorry, a delivery note and a scanner.
 *
 * It WRITES THE LEDGER (through the actions, which go through Task 6), so it is
 * not a form: it is the place stock is counted in. `lang` is the request's
 * resolved language, passed down from the server page, so every label and
 * number follows the app's language and direction.
 */

/** One option in the "from" list, flattened for the client boundary. */
export interface IntakeSource {
  id: string;
  label: string;
}

export interface IntakeScreenProps {
  /** The locations goods may arrive FROM (the tenant's active vendors). */
  sources: IntakeSource[];
  /** The warehouse the goods will arrive at, or `null` if there is none yet. */
  destName: string | null;
  /** The request's resolved language. */
  lang: Lang;
}

/** One scanned line as the screen holds it — the quantities are TYPED text. */
interface ScreenLine {
  variantId: string;
  /** The item's Arabic name — WHAT resolved, so the person can confirm it. */
  nameAr: string;
  /** The scannable code, shown left-to-right. */
  code: string;
  /** Size / colour / any attribute that tells two variants apart, if any. */
  detail: string;
  expected: string;
  received: string;
  /** Once the person edits `received` by hand, it stops following `expected`. */
  receivedEdited: boolean;
}

/** What the field last said: a resolved scan is cleared, a miss is shown. */
interface ScanMessage {
  kind: 'unknown' | 'already' | 'error';
  code: string;
  refusal?: IntakeRefusal;
}

function randomUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const value = Math.floor(Math.random() * 16);
    return (ch === 'x' ? value : (value % 4) + 8).toString(16);
  });
}

function parseQty(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function detailOf(attrs: unknown): string {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return '';
  const record = attrs as Record<string, unknown>;
  return [record.size, record.colour]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' · ');
}

export function IntakeScreen({ sources, destName, lang }: IntakeScreenProps) {
  // Minted ONCE, when the form opens, and kept until a delivery is posted.
  const [formId, setFormId] = useState(randomUuid);
  const [refNo, setRefNo] = useState('');
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [lines, setLines] = useState<ScreenLine[]>([]);
  const [scanValue, setScanValue] = useState('');
  const [scanMessage, setScanMessage] = useState<ScanMessage | null>(null);
  const [duplicate, setDuplicate] = useState<{ receiptId: string; postedAt: string } | null>(null);
  const [noteError, setNoteError] = useState<IntakeRefusal | null>(null);
  const [scanning, setScanning] = useState(false);
  const [posting, setPosting] = useState(false);
  const [problem, setProblem] = useState<'invalid' | 'unauthenticated' | 'forbidden' | null>(null);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);

  function addOrBumpLine(resolved: { variant: { id: string; barcode: string; attrs: unknown }; itemNameAr: string }) {
    const variant = resolved.variant;
    setLines((prev) => {
      const existing = prev.find((line) => line.variantId === variant.id);
      if (!existing) {
        const one = '1';
        return [
          ...prev,
          {
            variantId: variant.id,
            nameAr: resolved.itemNameAr,
            code: variant.barcode,
            detail: detailOf(variant.attrs),
            expected: one,
            received: one,
            receivedEdited: false,
          },
        ];
      }
      // Scanning the same label again is a COUNT, not a duplicate line.
      return prev.map((line) =>
        line.variantId === variant.id
          ? {
              ...line,
              expected: String((parseQty(line.expected) ?? 0) + 1),
              received: line.receivedEdited
                ? line.received
                : String((parseQty(line.expected) ?? 0) + 1),
            }
          : line,
      );
    });
  }

  async function handleScan(code: string) {
    setScanning(true);
    setScanMessage(null);
    try {
      const outcome = await scan(code);
      if (!outcome.ok) {
        setScanMessage({ kind: 'error', code: '', refusal: outcome.code });
        return;
      }
      const result = outcome.scan;
      if (result.kind === 'unknown') {
        setScanMessage({ kind: 'unknown', code: result.code });
        return;
      }
      setScanValue('');
      addOrBumpLine(result);
      setScanMessage({ kind: 'already', code: result.variant.barcode });
    } catch {
      setScanMessage({ kind: 'error', code: '', refusal: 'invalid' });
    } finally {
      setScanning(false);
    }
  }

  async function handleNoteBlur() {
    const value = refNo.trim();
    if (value === '') {
      setDuplicate(null);
      setNoteError(null);
      return;
    }
    try {
      const outcome = await checkNote(value);
      if (outcome.ok) {
        setDuplicate(outcome.duplicate);
        setNoteError(null);
      } else {
        setDuplicate(null);
        setNoteError(outcome.code);
      }
    } catch {
      setDuplicate(null);
      setNoteError('invalid');
    }
  }

  const parsed = lines.map((line) => ({
    ...line,
    expectedNum: parseQty(line.expected),
    receivedNum: parseQty(line.received),
  }));
  const everyLineCounted = parsed.every(
    (line) =>
      line.expectedNum != null &&
      line.expectedNum > 0 &&
      (line.receivedNum == null || line.receivedNum >= 0),
  );
  const ready =
    refNo.trim() !== '' &&
    sourceId !== '' &&
    destName != null &&
    parsed.length > 0 &&
    everyLineCounted &&
    !posting;

  async function handleSubmit() {
    setOutcome(null);
    setProblem(null);
    if (!ready) {
      setProblem('invalid');
      return;
    }
    setPosting(true);
    try {
      const form: ReceiptForm = {
        formId,
        refNo: refNo.trim(),
        sourceLocationId: sourceId,
        lines: parsed.map((line) => ({
          variantId: line.variantId,
          expected: line.expectedNum ?? 0,
          received: line.receivedNum,
        })),
      };

      const result = await submitReceipt(form);
      setOutcome(result);
      if (!result.ok) {
        setProblem(result.error?.code ?? 'invalid');
        return;
      }
      if (result.status === 'receiving') {
        const outstanding = new Set(result.outstanding);
        setLines((prev) =>
          prev
            .filter((line) => outstanding.has(line.variantId))
            .map((line) => ({ ...line, received: '', receivedEdited: false })),
        );
        setScanValue('');
        setScanMessage(null);
        setDuplicate(null);
      } else {
        setLines([]);
        setRefNo('');
        setScanValue('');
        setScanMessage(null);
        setDuplicate(null);
        setFormId(randomUuid());
      }
    } finally {
      setPosting(false);
    }
  }

  const varianceLines: ExpectedVsReceivedLine[] = parsed.map((line) => ({
    variantId: line.variantId,
    code: line.code,
    expected: line.expectedNum,
    received: line.receivedNum,
  }));

  const outstandingCodes = (outcome?.ok ? outcome.outstanding : [])
    .map((variantId) => parsed.find((line) => line.variantId === variantId)?.code)
    .filter((code): code is string => code != null);

  return (
    <div className="intake">
      <form onSubmit={(event) => event.preventDefault()}>
        <div className="intake-section">
          <label htmlFor="intake-note">{t('intake.note', lang)}</label>
          <input
            id="intake-note"
            name="refNo"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            enterKeyHint="next"
            value={refNo}
            onChange={(event) => setRefNo(event.target.value)}
            onBlur={handleNoteBlur}
          />
          <small className="field-hint">{t('common.ltr_hint', lang)}</small>
          {duplicate ? (
            <p role="alert" className="duplicate-warning">
              {t('intake.duplicate', { lang, params: { date: formatDate(new Date(duplicate.postedAt), lang) } })}
            </p>
          ) : null}
          {noteError ? (
            <p role="alert" className="intake-problem">
              {t(REFUSAL_MESSAGE_KEYS[noteError], lang)}
            </p>
          ) : null}
        </div>

        <div className="intake-section">
          <label htmlFor="intake-source">{t('intake.source', lang)}</label>
          {sources.length > 0 ? (
            <select
              id="intake-source"
              name="source"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
          ) : (
            <p role="alert" className="intake-problem">
              {t('intake.no_source', lang)}
            </p>
          )}
        </div>

        <div className="intake-section">
          <p className="intake-dest">{t('intake.dest', { lang, params: { name: destName ?? '—' } })}</p>
          {destName == null ? (
            <p role="alert" className="intake-problem">
              {t('intake.no_dest', lang)}
            </p>
          ) : null}
        </div>

        <div className="intake-section">
          <ScanField
            label={t('intake.scan', lang)}
            hint={t('intake.scan_hint', lang)}
            placeholder={t('intake.scan_placeholder', lang)}
            value={scanValue}
            onChange={setScanValue}
            onScan={handleScan}
            busy={scanning}
          />
          {scanMessage ? (
            <p
              role={scanMessage.kind === 'unknown' ? 'alert' : undefined}
              className={
                scanMessage.kind === 'unknown' ? 'intake-problem scan-unknown' : 'field-hint'
              }
            >
              {scanMessage.kind === 'unknown'
                ? t('intake.unknown', { lang, params: { code: scanMessage.code } })
                : scanMessage.kind === 'already'
                  ? t('intake.already', { lang, params: { code: scanMessage.code } })
                  : t(REFUSAL_MESSAGE_KEYS[scanMessage.refusal ?? 'invalid'], lang)}
            </p>
          ) : null}
        </div>

        <div className="intake-section">
          <h2>{t('intake.lines', lang)}</h2>
          {parsed.length === 0 ? (
            <p className="field-hint">{t('intake.no_lines', lang)}</p>
          ) : (
            <ul className="intake-lines">
              {parsed.map((line) => (
                <li key={line.variantId} className="intake-line">
                  <div className="intake-line-head">
                    <span className="intake-line-name">{line.nameAr}</span>
                    <span className="ltr-value intake-line-code">{line.code}</span>
                    {line.detail ? <span className="intake-line-detail">{line.detail}</span> : null}
                  </div>
                  <div className="intake-line-quantities">
                    <label className="intake-qty">
                      {t('intake.expected', lang)}
                      <input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        step="1"
                        value={line.expected}
                        aria-label={`${t('intake.expected', lang)} — ${line.code}`}
                        onChange={(event) => {
                          const value = event.target.value;
                          setLines((prev) =>
                            prev.map((row) =>
                              row.variantId === line.variantId
                                ? {
                                    ...row,
                                    expected: value,
                                    received: row.receivedEdited ? row.received : value,
                                  }
                                : row,
                            ),
                          );
                        }}
                      />
                    </label>
                    <label className="intake-qty">
                      {t('intake.received', lang)}
                      <input
                        type="number"
                        inputMode="numeric"
                        min="0"
                        step="1"
                        value={line.received}
                        aria-label={`${t('intake.received', lang)} — ${line.code}`}
                        onChange={(event) => {
                          const value = event.target.value;
                          setLines((prev) =>
                            prev.map((row) =>
                              row.variantId === line.variantId
                                ? { ...row, received: value, receivedEdited: true }
                                : row,
                            ),
                          );
                        }}
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="intake-remove"
                    onClick={() =>
                      setLines((prev) => prev.filter((row) => row.variantId !== line.variantId))
                    }
                  >
                    {t('intake.remove', lang)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ExpectedVsReceived lines={varianceLines} lang={lang} />

        {problem ? (
          <p role="alert" className="intake-problem">
            {t(REFUSAL_MESSAGE_KEYS[problem], lang)}
          </p>
        ) : null}

        {outcome?.ok ? (
          <div className="intake-posted" aria-live="polite">
            {outcome.status === 'receiving' ? (
              <>
                <p>
                  {t('intake.posted.partial', {
                    lang,
                    params: { count: formatNumber(outcome.outstanding.length, lang) },
                  })}
                </p>
                {outstandingCodes.length > 0 ? (
                  <p className="ltr-value">
                    {t('intake.posted.still_outstanding', lang)}: {outstandingCodes.join(', ')}
                  </p>
                ) : null}
              </>
            ) : (
              <p>{t('intake.posted', lang)}</p>
            )}
            {outcome.duplicateOf ? (
              <p role="alert" className="duplicate-warning">
                {t('intake.duplicate', {
                  lang,
                  params: { date: formatDate(new Date(outcome.duplicateOf.postedAt), lang) },
                })}
              </p>
            ) : null}
            {outcome.shortfalls.length > 0 ? (
              <p>
                {t('intake.posted.shortfalls', {
                  lang,
                  params: { count: formatNumber(outcome.shortfalls.length, lang) },
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        <button type="button" className="intake-submit" onClick={handleSubmit} disabled={posting}>
          {posting ? t('intake.posting', lang) : t('intake.submit', lang)}
        </button>
      </form>
    </div>
  );
}