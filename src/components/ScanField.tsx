'use client';

/**
 * The ONE field that takes a barcode — typed by a person or typed by a scanner.
 *
 * A barcode scanner is a keyboard: it types the code as fast as it can and then
 * sends ENTER. So this field does two things a plain input does not:
 *
 *   1. ENTER ADDS THE LINE — `onKeyDown` catches Enter, calls `preventDefault`
 *      so the surrounding form is NOT submitted and the person is not navigated
 *      away, and hands the code to `onScan`. The scan field's Enter is the
 *      warehouse's most-repeated gesture; it must never mean "submit".
 *   2. THE CODE STAYS LEFT-TO-RIGHT — `dir="ltr"` plus the shared `.ltr-value`
 *      class (globals.css). The screen is Arabic and RTL, but a code is a
 *      machine-read Latin string: rendered right-to-left, `AB-0012` reads
 *      backwards and stops matching the printed label.
 *
 * THE FIELD'S LOOK IS NOT DEFINED HERE. There is no `style` and no local
 * restyle: the border, background, focus ring and 44px tap target all come from
 * the shared `input` rules in globals.css, so restyling the app is one edit in
 * one file. Everything this component adds is structure and behaviour.
 */
export interface ScanFieldProps {
  /** The visible label, already translated. */
  label: string;
  /** A translated hint shown under the field (e.g. "press Enter to add"). */
  hint?: string;
  /** The typed-in value — owned by the screen, so it survives a re-render. */
  value: string;
  /** Called on every keystroke (a scanner types). */
  onChange: (value: string) => void;
  /** Called when Enter is pressed on a non-empty value. */
  onScan: (code: string) => void;
  /** A sample barcode to show, as a placeholder. */
  placeholder?: string;
  /** True while a scan is in flight — the field waits rather than queueing. */
  busy?: boolean;
}

export function ScanField({
  label,
  hint,
  value,
  onChange,
  onScan,
  placeholder,
  busy = false,
}: ScanFieldProps) {
  return (
    <div className="scan-field">
      <label htmlFor="intake-scan">{label}</label>
      <input
        id="intake-scan"
        className="ltr-value"
        dir="ltr"
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        placeholder={placeholder}
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          // The scanner (or the person) finished a code. Add the line — do NOT
          // submit the form, and do NOT let Enter bubble to anything that would.
          event.preventDefault();
          event.stopPropagation();
          const code = value.trim();
          if (code !== '') onScan(code);
        }}
      />
      {hint ? <small className="field-hint">{hint}</small> : null}
    </div>
  );
}
