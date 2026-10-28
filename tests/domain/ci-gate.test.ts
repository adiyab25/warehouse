import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countTapSkipDirectives,
  evaluateRun,
  parseTapSummary,
} from '../../scripts/ci-gate.mjs';

/**
 * THE CI SKIP-GATE, driven with CAPTURED TAP.
 *
 * `scripts/ci.mjs` is the one gate every task must pass, and it was fail-OPEN:
 * it regex-matched `# skipped (\d+)` and fell back to `0` when the match was
 * absent — so a truncated stream, a renamed field, or a suite that executed
 * NOTHING all read as "zero skipped" and PASSED. These tests pin the decision
 * to the four branches that must hold, against TAP samples captured from
 * `node --test --test-reporter=tap` (see the report for the live runs).
 *
 *   (i)   an ABSENT/unreadable summary  → refuse (never "zero skipped");
 *   (ii)  a run that executed NOTHING   → refuse (`# tests 0` / `# pass 0`);
 *   (iii) a real skipped test present    → refuse;
 *   (iv)  a normal, full run             → pass.
 *
 * …plus the anchoring property: a line a TEST printed (`# skipped 0`) must NOT
 * be able to satisfy the gate.
 */

// A normal full run's footer, exactly as node's TAP reporter prints it.
const NORMAL_RUN = [
  'TAP version 13',
  '# Subtest: one',
  'ok 1 - one',
  '  ---',
  "  type: 'test'",
  '  ...',
  '# Subtest: two',
  'ok 2 - two',
  '  ---',
  "  type: 'test'",
  '  ...',
  '1..240',
  '# tests 240',
  '# suites 0',
  '# pass 240',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 11797.2182',
].join('\n');

// Zero tests discovered: the runner still prints a (useless) summary and exits 0.
const ZERO_TESTS = [
  'TAP version 13',
  '1..0',
  '# tests 0',
  '# suites 0',
  '# pass 0',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 12.3',
].join('\n');

// One real skip: the TAP body carries the directive AND the footer counts it.
const WITH_SKIP = [
  'TAP version 13',
  'ok 1 - a real test',
  'ok 2 - a db test # SKIP SQL_TEST_DATABASE_URL is not set',
  '1..2',
  '# tests 2',
  '# suites 0',
  '# pass 1',
  '# fail 0',
  '# cancelled 0',
  '# skipped 1',
  '# todo 0',
].join('\n');

// A skip whose footer LIED (says 0): the BODY directive must still refuse it.
const BODY_SKIP_ONLY = [
  'TAP version 13',
  'ok 1 - a real test',
  'ok 2 - something # SKIP no database',
  '1..2',
  '# tests 2',
  '# suites 0',
  '# pass 2',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
].join('\n');

// A test that PRINTS `# skipped 0` (diagnostics are emitted as `# <line>`):
// it appears before the plan, so it must not be the gate's evidence.
const DIAGNOSTIC_LOOKALIKE = [
  'TAP version 13',
  '# a test printed the following diagnostic',
  '# skipped 0',
  'ok 1 - a real test',
  '1..1',
  '# tests 1',
  '# suites 0',
  '# pass 1',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
].join('\n');

test('(i) an absent or unreadable summary is a REFUSAL, never "zero skipped"', () => {
  for (const absent of ['', 'no tap here\n', 'TAP version 13\n# tests 3\n']) {
    const verdict = evaluateRun(absent, 0);
    assert.equal(verdict.ok, false, `an absent summary must refuse (got ok for ${JSON.stringify(absent)})`);
    assert.equal(verdict.reason, 'absent-summary');
  }

  // The plan line with no footer fields is unreadable, not "0".
  const noFooter = evaluateRun('1..5\n', 0);
  assert.equal(noFooter.ok, false);
  assert.equal(noFooter.reason, 'absent-summary');
});

test('(ii) a run that executed ZERO tests is a REFUSAL', () => {
  const verdict = evaluateRun(ZERO_TESTS, 0);
  assert.equal(verdict.ok, false, 'a suite that executed nothing must not pass');
  assert.equal(verdict.reason, 'empty');
  assert.match(verdict.message, /executed NOTHING|proven nothing/i);

  const summary = parseTapSummary(ZERO_TESTS);
  assert.equal(summary.tests, 0);
  assert.equal(summary.pass, 0);
});

test('(iii) a real skipped test is a REFUSAL', () => {
  const verdict = evaluateRun(WITH_SKIP, 0);
  assert.equal(verdict.ok, false, 'a skipped test is an unproven claim, not a pass');
  assert.equal(verdict.reason, 'skipped');
  assert.match(verdict.message, /SKIPPED/);

  // The BODY directive refuses even when the footer lies and says 0 skipped.
  const bodyOnly = evaluateRun(BODY_SKIP_ONLY, 0);
  assert.equal(bodyOnly.ok, false, 'the TAP body `# SKIP` must refuse even if the footer says 0');
  assert.equal(bodyOnly.reason, 'skipped');
  assert.equal(countTapSkipDirectives(BODY_SKIP_ONLY), 1);
});

test('(iv) a normal full run clears the gate', () => {
  const verdict = evaluateRun(NORMAL_RUN, 0);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, 'ok');
  assert.match(verdict.message, /240 tests ran, 0 skipped/);

  // A non-zero exit code still refuses, whatever the footer says.
  const failed = evaluateRun(NORMAL_RUN, 1);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'failed');
});

test('a line a TEST printed cannot satisfy the gate', () => {
  // If the gate read the FIRST `# skipped 0` it found, this diagnostic would be
  // mistaken for the runner's footer. Anchoring to the tail after the plan line
  // means it is ignored and the real footer (also 0) is the evidence — and the
  // diagnostic on its own, with no plan/footer, is unreadable.
  const verdict = evaluateRun(DIAGNOSTIC_LOOKALIKE, 0);
  assert.equal(verdict.ok, true, 'a diagnostic `# skipped 0` must not flip a clean run');

  const diagnosticOnly = evaluateRun('# skipped 0\n', 0);
  assert.equal(diagnosticOnly.ok, false, 'a lone diagnostic is not a summary — refuse');
  assert.equal(diagnosticOnly.reason, 'absent-summary');
});
