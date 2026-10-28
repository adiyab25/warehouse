'use client';

import { formatNumber, t, type Lang } from '../i18n';

/**
 * What the delivery note said against what is actually on the lorry.
 *
 * A receipt exists precisely because those two numbers disagree sometimes, and
 * the disagreement must SURFACE rather than be quietly equalised: this shows
 * every line where the received quantity differs from the expected one, in a
 * warning style, with the signed difference. It is a REPORT — the numbers the
 * person typed are never rewritten to match.
 *
 * `lang` is the request's resolved language, passed down from the server page,
 * so the labels and numbers follow the app's language and direction.
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

export function ExpectedVsReceived({
  lines,
  lang,
}: {
  lines: ReadonlyArray<ExpectedVsReceivedLine>;
  lang: Lang;
}) {
  const notable = lines.filter(
    (line) => line.received == null || (line.expected != null && line.received !== line.expected),
  );
  if (notable.length === 0) return null;

  return (
    <section className="variance-block" aria-live="polite">
      <h2 className="variance-heading">{t('intake.variance.heading', lang)}</h2>
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
                  ? t('intake.not_received', lang)
                  : t('intake.variance.line', {
                      lang,
                      params: {
                        expected: formatNumber(expected, lang),
                        received: formatNumber(line.received ?? 0, lang),
                        variance: formatNumber((line.received ?? 0) - expected, lang),
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