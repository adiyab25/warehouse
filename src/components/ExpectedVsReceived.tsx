'use client';

import { formatNumber, t } from '../i18n';

/**
 * What the delivery note said against what is actually on the lorry.
 *
 * A receipt exists precisely because those two numbers disagree sometimes, and
 * the disagreement must SURFACE rather than be quietly equalised: this shows
 * every line where the received quantity differs from the expected one, in a
 * warning style, with the signed difference. It is a REPORT — the numbers the
 * person typed are never rewritten to match.
 *
 * IT ALSO SHOWS WHAT HAS NOT ARRIVED. A line with no received quantity yet is
 * not a variance (goods that have not arrived are not a shortage — a delivery
 * in parts must stay expressible), so it is listed separately as "not yet
 * received" rather than folded into a shortfall.
 *
 * Nothing to report ⇒ nothing on screen: when every line matches, this renders
 * no markup at all, so the door does not grow a permanent red banner.
 *
 * Numbers go through the Task 11 formatters, so the digits are LATIN in every
 * language — an Arabic-Indic quantity would not match the paper it was copied
 * from (see src/i18n/index.ts).
 */
export interface ExpectedVsReceivedLine {
  variantId: string;
  /** The scanned code, rendered left-to-right. */
  code: string;
  /** What the note said to expect, or `null` if it is not filled in yet. */
  expected: number | null;
  /** What arrived, or `null` while it has not. */
  received: number | null;
}

export function ExpectedVsReceived({ lines }: { lines: ReadonlyArray<ExpectedVsReceivedLine> }) {
  const notable = lines.filter(
    (line) => line.received == null || (line.expected != null && line.received !== line.expected),
  );
  if (notable.length === 0) return null;

  return (
    <section className="variance-block" aria-live="polite">
      <h2 className="variance-heading">{t('intake.variance.heading')}</h2>
      <ul className="variance-list">
        {notable.map((line) => {
          const pending = line.received == null;
          const expected = line.expected ?? 0;
          return (
            <li
              key={line.variantId}
              className={`variance-line ${pending ? 'variance-line-pending' : 'variance-warning'}`}
            >
              <span className="ltr-value variance-code">{line.code}</span>
              <span className="variance-detail">
                {pending
                  ? t('intake.not_received')
                  : t('intake.variance.line', {
                      params: {
                        expected: formatNumber(expected),
                        received: formatNumber(line.received ?? 0),
                        variance: formatNumber((line.received ?? 0) - expected),
                      },
                    })}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
