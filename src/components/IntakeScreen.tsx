'use client';

import { useState } from 'react';

import { checkNote, scan, submitReceipt } from '../app/intake/actions';
import type { SubmitOutcome } from '../app/intake/handler';
import { REFUSAL_MESSAGE_KEYS, type IntakeRefusal, type ReceiptForm } from '../domain/intake';
import { formatDate, formatNumber, t } from '../i18n';
import { ExpectedVsReceived, type ExpectedVsReceivedLine } from './ExpectedVsReceived';
import { ScanField } from './ScanField';

/**
 * THE INTAKE DOOR — the screen the warehouse manager stands in front of with a
 * lorry, a delivery note and a scanner.
 *
 * It WRITES THE LEDGER (through the actions, which go through Task 6), so it is
 * not a form: it is the place stock is counted in. Three decisions shape it.
 *
 *   1. IT IS USED STANDING UP, ONE-HANDED, ON A PHONE. One narrow column, one
 *      field at a time, generous tap targets, no desktop-only affordances. The
 *      document is Arabic and RTL (dir is inherited from the root layout and
 *      re-stated on the page); only the scanned code opts out (ScanField).
 *
 *   2. ONE FIELD TAKES THE SCANNER. A scanner types a code and sends ENTER; the
 *      Enter adds the line and must never submit the form (see ScanField). The
 *      line then carries an expected quantity (what the note says) and a
 *      received quantity that DEFAULTS to the expected one and is editable —
 *      leaving it EMPTY means "not arrived yet", which is how a delivery in
 *      parts stays expressible: an unreceived line is not posted at all.
 *
 *   3. THE FORM'S KEY IS MINTED WHEN THE FORM OPENS (`formId`) and kept across
 *      retries. It becomes the receipt's id, so a double-tap or a lost response
 *      collapses to ONE movement (Task 6's per-line idempotency key), while a
 *      genuinely second delivery — after a successful post, a NEW form and a
 *      new id — posts normally. Nothing here re-posts on a refresh: posting is
 *      only ever the result of a person pressing the button.
 *
 * Everything the system already knows is auto-filled and never typed: who
 * received (the session), when (the clock, server-side) and where the goods
 * arrive (the tenant's one warehouse). The things only the person at the door
 * can know — the note number, the sender, and what actually arrived — are asked
 * for at the moment of entry.
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
  /** Why the scan was refused — the field shows THIS code's message, not a guess. */
  refusal?: IntakeRefusal;
}

/**
 * A uuid v4 for the form's key.
 *
 * `crypto.randomUUID` is available in every browser this screen runs on and in
 * the Node runtime that prerenders it; the hand-rolled fallback exists so a
 * hostile or very old runtime produces a KEY (of the right SHAPE — the id
 * column is a uuid) rather than a crash.
 */
function randomUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const value = Math.floor(Math.random() * 16);
    return (ch === 'x' ? value : (value % 4) + 8).toString(16);
  });
}

/** A typed quantity, or `null` when the field is empty or not a number. */
function parseQty(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The attribute line under a scanned code: "L · أبيض", or nothing. */
function detailOf(attrs: unknown): string {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return '';
  const record = attrs as Record<string, unknown>;
  return [record.size, record.colour]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' · ');
}

export function IntakeScreen({ sources, destName }: IntakeScreenProps) {
  // Minted ONCE, when the form opens, and kept until a delivery is posted —
  // this is the key that makes a double-tap land on one receipt.
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

  /** Adds a scanned line, or tops up the one already there. */
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
      // Scanning the same label again is a COUNT, not a duplicate line: two
      // lines for one variant would be refused by Task 6's per-receipt unique
      // index anyway, so the screen never builds one.
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

  /** ENTER on the scan field — resolve the code, add it, or say it is unknown. */
  async function handleScan(code: string) {
    setScanning(true);
    setScanMessage(null);
    try {
      const outcome = await scan(code);
      if (!outcome.ok) {
        // A refusal is an ANSWER carrying its own code: show THAT message, not
        // a blanket "you are not signed in".
        setScanMessage({ kind: 'error', code: '', refusal: outcome.code });
        return;
      }
      const result = outcome.scan;
      if (result.kind === 'unknown') {
        // NEVER silent: the person is told exactly what was read, in Latin
        // digits, so they can compare it with the label on the box.
        setScanMessage({ kind: 'unknown', code: result.code });
        return;
      }
      setScanValue('');
      addOrBumpLine(result);
      setScanMessage({ kind: 'already', code: result.variant.barcode });
    } catch {
      // The action answers rather than throws, but if anything escapes, still
      // report it as a problem rather than a silent no-op.
      setScanMessage({ kind: 'error', code: '', refusal: 'invalid' });
    } finally {
      setScanning(false);
    }
  }

  /**
   * Leaving the note field: warn about a note already booked, before we accept.
   *
   * ON FAILURE IT SAYS SO. The check returning a refusal is NOT the same as the
   * check finding nothing: a failed lookup is surfaced with its own message
   * rather than being swallowed into "no duplicate warning" (which would let a
   * manager wave through a note that may already have been booked).
   */
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

  /** Post the delivery. The ONLY thing that writes the ledger. */
  async function handleSubmit() {
    setOutcome(null);
    setProblem(null);
    if (!ready) {
      setProblem('invalid');
      return;
    }
    setPosting(true);
    // The in-flight flag is cleared in `finally`, so a throw anywhere — even
    // reading the session cookie before the action's own try — can NEVER leave
    // the submit button permanently disabled.
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
        // A PART DELIVERY. KEEP the form key and the lines whose goods have not
        // arrived, so the remainder is posted against the SAME receipt (their
        // `received` is cleared — they have not arrived yet). The banner says
        // "partly received … outstanding", never "posted".
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
        // Fully posted. Start a GENUINELY new form: a new key, so the next
        // lorry gets its own receipt.
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

  // The codes still outstanding after a PART post, so the banner can name them.
  const outstandingCodes = (outcome?.ok ? outcome.outstanding : [])
    .map((variantId) => parsed.find((line) => line.variantId === variantId)?.code)
    .filter((code): code is string => code != null);

  return (
    <div className="intake">
      <form onSubmit={(event) => event.preventDefault()}>
        <div className="intake-section">
          <label htmlFor="intake-note">{t('intake.note')}</label>
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
          <small className="field-hint">{t('common.ltr_hint')}</small>
          {duplicate ? (
            <p role="alert" className="duplicate-warning">
              {t('intake.duplicate', { params: { date: formatDate(new Date(duplicate.postedAt)) } })}
            </p>
          ) : null}
          {noteError ? (
            <p role="alert" className="intake-problem">
              {t(REFUSAL_MESSAGE_KEYS[noteError])}
            </p>
          ) : null}
        </div>

        <div className="intake-section">
          <label htmlFor="intake-source">{t('intake.source')}</label>
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
              {t('intake.no_source')}
            </p>
          )}
        </div>

        <div className="intake-section">
          <p className="intake-dest">{t('intake.dest', { params: { name: destName ?? '—' } })}</p>
          {destName == null ? (
            <p role="alert" className="intake-problem">
              {t('intake.no_dest')}
            </p>
          ) : null}
        </div>

        <div className="intake-section">
          <ScanField
            label={t('intake.scan')}
            hint={t('intake.scan_hint')}
            placeholder={t('intake.scan_placeholder')}
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
                ? t('intake.unknown', { params: { code: scanMessage.code } })
                : scanMessage.kind === 'already'
                  ? t('intake.already', { params: { code: scanMessage.code } })
                  : t(REFUSAL_MESSAGE_KEYS[scanMessage.refusal ?? 'invalid'])}
            </p>
          ) : null}
        </div>

        <div className="intake-section">
          <h2>{t('intake.lines')}</h2>
          {parsed.length === 0 ? (
            <p className="field-hint">{t('intake.no_lines')}</p>
          ) : (
            <ul className="intake-lines">
              {parsed.map((line) => (
                <li key={line.variantId} className="intake-line">
                  <div className="intake-line-head">
                    {/* WHAT resolved, in Arabic, right-aligned by the RTL document. */}
                    <span className="intake-line-name">{line.nameAr}</span>
                    {/* The machine-read code, kept left-to-right (.ltr-value). */}
                    <span className="ltr-value intake-line-code">{line.code}</span>
                    {line.detail ? <span className="intake-line-detail">{line.detail}</span> : null}
                  </div>
                  <div className="intake-line-quantities">
                    <label className="intake-qty">
                      {t('intake.expected')}
                      <input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        step="1"
                        value={line.expected}
                        aria-label={`${t('intake.expected')} — ${line.code}`}
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
                      {t('intake.received')}
                      <input
                        type="number"
                        inputMode="numeric"
                        min="0"
                        step="1"
                        value={line.received}
                        aria-label={`${t('intake.received')} — ${line.code}`}
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
                    {t('intake.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ExpectedVsReceived lines={varianceLines} />

        {problem ? (
          <p role="alert" className="intake-problem">
            {t(REFUSAL_MESSAGE_KEYS[problem])}
          </p>
        ) : null}

        {outcome?.ok ? (
          <div className="intake-posted" aria-live="polite">
            {outcome.status === 'receiving' ? (
              <>
                <p>
                  {t('intake.posted.partial', {
                    params: { count: formatNumber(outcome.outstanding.length) },
                  })}
                </p>
                {outstandingCodes.length > 0 ? (
                  <p className="ltr-value">
                    {t('intake.posted.still_outstanding')}: {outstandingCodes.join(', ')}
                  </p>
                ) : null}
              </>
            ) : (
              <p>{t('intake.posted')}</p>
            )}
            {outcome.duplicateOf ? (
              <p role="alert" className="duplicate-warning">
                {t('intake.duplicate', {
                  params: { date: formatDate(new Date(outcome.duplicateOf.postedAt)) },
                })}
              </p>
            ) : null}
            {outcome.shortfalls.length > 0 ? (
              <p>
                {t('intake.posted.shortfalls', {
                  params: { count: formatNumber(outcome.shortfalls.length) },
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        <button type="button" className="intake-submit" onClick={handleSubmit} disabled={posting}>
          {posting ? t('intake.posting') : t('intake.submit')}
        </button>
      </form>
    </div>
  );
}
