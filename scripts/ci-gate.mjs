/**
 * THE CI SKIP-GATE — the decision `npm run ci` makes about a finished test run.
 *
 * Extracted from `scripts/ci.mjs` into its own module so the decision can be
 * driven by a test with captured TAP, WITHOUT running a whole suite. This is
 * the piece that was fail-OPEN, so it is the piece that must be provably
 * fail-CLOSED:
 *
 *   (a) THE SUMMARY MUST BE PRESENT AND PARSEABLE. The old gate regex-matched
 *       `# skipped (\d+)` and fell back to `0` on no match — so truncation, an
 *       alternate reporter, or a wording change (`# skip: N`) all read as
 *       "zero skipped" and PASSED. An absent summary is now a REFUSAL: a run
 *       the gate cannot read is a run the gate cannot clear.
 *
 *   (b) NON-EMPTINESS IS ASSERTED. `# tests > 0` AND `# pass > 0`, or refuse.
 *       A suite that executed NOTHING (a renamed directory, a build that drops
 *       `*.test.ts`, a typo in the collector) prints `1..0 / # tests 0 /
 *       # skipped 0` and would otherwise have passed the skip check having
 *       proven nothing.
 *
 *   (c) SKIPS ARE COUNTED FROM THE TAP BODY, not the human-readable footer.
 *       A `ok N - name # SKIP reason` line is TAP's own skip directive and
 *       cannot be faked by prose; the footer `# skipped` is kept as a SECOND
 *       signal. Both are anchored so a line a TEST prints (diagnostics are
 *       emitted as `# <line>`) cannot satisfy the gate: the summary is read
 *       from the tail AFTER the last `1..N` plan line, and each field is the
 *       LAST such line — a test that prints `# skipped 0` mid-stream is before
 *       the plan and therefore cannot be the evidence the gate reads.
 *
 * Plain JavaScript on purpose: `scripts/ci.mjs` is run by `node` directly (no
 * tsx), and this module is its logic.
 */

/** One `# tests N` / `# pass N` / `# skipped N` line, anchored to line start. */
function summaryLine(label) {
  return new RegExp(`^# ${label} (\\d+)\\s*$`);
}

/**
 * Reads the runner's summary from the TAP stream, ANCHORED to the tail.
 *
 * The real summary is the block of `# …` lines that node's TAP reporter prints
 * AFTER the last plan line (`1..N`). Reading only that tail — and taking the
 * LAST occurrence of each field — is what stops a diagnostic the SUITE printed
 * (`# migrate: refusing …`, or even a literal `# skipped 0`) from standing in
 * for the runner's own summary. Returns `present: false` when the plan line or
 * any of the three fields is missing, which the caller treats as a refusal.
 */
export function parseTapSummary(output) {
  const lines = String(output ?? '').split(/\r?\n/);

  let lastPlan = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^1\.\.\d+\s*$/.test(lines[i] ?? '')) lastPlan = i;
  }
  if (lastPlan === -1) return { present: false, tests: null, pass: null, skipped: null };

  const tail = lines.slice(lastPlan + 1);
  const lastField = (label) => {
    let value = null;
    for (const line of tail) {
      const match = line.match(summaryLine(label));
      if (match) value = Number(match[1]);
    }
    return value;
  };

  const tests = lastField('tests');
  const pass = lastField('pass');
  const skipped = lastField('skipped');
  return {
    present: tests !== null && pass !== null && skipped !== null,
    tests,
    pass,
    skipped,
  };
}

/**
 * Counts TAP skip DIRECTIVES in the body: `ok N - name # SKIP reason`.
 *
 * This is the machine-readable signal, preferred over the footer because the
 * footer is prose that a reporter (or a version bump) may rename. Anchored to
 * a real `ok N` test line so a bare `# SKIP` in a diagnostic does not count.
 */
export function countTapSkipDirectives(output) {
  const lines = String(output ?? '').split(/\r?\n/);
  return lines.filter((line) => /^ok\s+\d+\b.*#\s*SKIP\b/i.test(line)).length;
}

/**
 * The gate's verdict for a finished run. FAIL CLOSED: anything the gate cannot
 * read or that proves too little is a refusal, not a silent pass.
 */
export function evaluateRun(output, exitCode) {
  const summary = parseTapSummary(output);

  // (a) An unreadable/absent summary is a REFUSAL, never "zero skipped".
  if (!summary.present) {
    return {
      ok: false,
      reason: 'absent-summary',
      message:
        'ci: refusing to pass — the test runner produced no readable TAP summary ' +
        '(a `1..N` plan line followed by `# tests` / `# pass` / `# skipped`). ' +
        'An absent summary is NOT "zero skipped": it is proof of nothing, so the gate fails closed.',
    };
  }

  // (c) Skips first: a skipped test is an unproven claim, whatever else ran.
  const bodySkips = countTapSkipDirectives(output);
  const skipped = Math.max(summary.skipped ?? 0, bodySkips);
  if (skipped > 0) {
    return {
      ok: false,
      reason: 'skipped',
      message:
        `ci: ${skipped} test(s) were SKIPPED — the gate refuses to pass on a suite that skipped ` +
        'itself green. Set the database urls (see .env.example) so every test actually runs.',
    };
  }

  // (b) Non-emptiness: a run that executed nothing must not pass.
  if ((summary.tests ?? 0) <= 0 || (summary.pass ?? 0) <= 0) {
    return {
      ok: false,
      reason: 'empty',
      message:
        `ci: refusing to pass — the run reported # tests ${summary.tests} and # pass ${summary.pass}. ` +
        'A gate that passes over a suite which executed NOTHING has proven nothing; ' +
        'check that the test files were discovered (renamed directory, dropped `*.test.ts`, a typo in the collector).',
    };
  }

  // (d) The runner's own exit code is the last word.
  if (exitCode !== 0) {
    return {
      ok: false,
      reason: 'failed',
      message: `ci: the test suite failed (exit ${exitCode}).`,
    };
  }

  return {
    ok: true,
    reason: 'ok',
    message: `ci: all gates passed — ${summary.tests} tests ran, ${summary.skipped} skipped.`,
  };
}

// ---------------------------------------------------------------------------
// CLI — `node scripts/ci-gate.mjs <tap-file> [exitCode]` prints the verdict as
// JSON and exits non-zero when the gate refuses. Used to prove each branch of
// the decision against REAL captured TAP.
// ---------------------------------------------------------------------------
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('ci-gate.mjs');

if (invokedDirectly) {
  const { readFileSync } = await import('node:fs');
  const [file, codeArg] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node scripts/ci-gate.mjs <tap-file> [exitCode]');
    process.exit(2);
  }
  const verdict = evaluateRun(readFileSync(file, 'utf8'), Number(codeArg ?? '0'));
  console.log(JSON.stringify(verdict));
  process.exit(verdict.ok ? 0 : 1);
}
