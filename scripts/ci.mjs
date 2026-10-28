#!/usr/bin/env node
/**
 * THE CI ENTRY POINT — the gate every task must pass.
 *
 * `npm test` is deliberately FLEXIBLE: run without a database and it skips the
 * DB-backed suites and says so. That is correct for a laptop. A GATE is not; a
 * suite that skips itself green buys confidence it did not earn, and this
 * project has already shipped one gate that skipped itself silently. So `npm
 * run ci` is strict in two ways `npm test` is not:
 *
 *   (1) IT REQUIRES A DATABASE. It refuses to run at all unless
 *       `SQL_TEST_DATABASE_URL` and `MIGRATE_DATABASE_URL` are set, so the DB
 *       tests can never silently vanish from a green CI run. The refusal is one
 *       loud line naming the missing variable(s).
 *   (2) IT REFUSES TO PASS ON A SKIP. The suite's own summary is read back, and
 *       `npm run ci` exits non-zero if ANY test reported as skipped — a skipped
 *       test is an unproven claim, not a pass.
 *
 * Typecheck (`tsc --noEmit`) and lint (`eslint .`) run first, so the gate is the
 * whole `tsc && eslint && test` chain and there is exactly one command to run.
 *
 * It is implemented HERE rather than in `node --test` because the runner has no
 * notion of "a skip is a failure" and no notion of required env, and because
 * this must stay a small, readable script.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_ENV = ['SQL_TEST_DATABASE_URL', 'MIGRATE_DATABASE_URL'];

const missing = REQUIRED_ENV.filter((name) => !(process.env[name] ?? '').trim());
if (missing.length > 0) {
  console.error(
    `ci: refusing to pass — ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set, ` +
      'so the database-backed tests would SKIP themselves green. ' +
      'Export them (see .env.example) and run `npm run ci` again.',
  );
  process.exit(1);
}

/**
 * Runs a gate step that speaks for itself (typecheck, lint): its output goes
 * straight to the terminal and a non-zero exit stops the gate immediately.
 */
function step(label, args) {
  const result = spawnSync('npx', args, { stdio: 'inherit', shell: true });
  if (result.error) {
    console.error(`ci: could not run \`${label}\`: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`ci: \`${label}\` failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

step('tsc --noEmit', ['tsc', '--noEmit']);
step('eslint .', ['eslint', '.']);

/** Every `*.test.ts` under `tests/`, found deterministically (no shell glob). */
function collectTestFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTestFiles(full));
    else if (entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

const testFiles = collectTestFiles('tests').sort();

// The TAP reporter is requested explicitly so the `# skipped N` summary line is
// guaranteed, whatever the terminal would otherwise have chosen.
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-reporter=tap', ...testFiles],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.on('error', (err) => {
  console.error('ci: could not start the test runner:', err.message);
  process.exit(1);
});

child.on('close', (code) => {
  const skippedMatch = output.match(/^# skipped (\d+)\s*$/m);
  const skipped = skippedMatch ? Number(skippedMatch[1]) : 0;

  if (skipped > 0) {
    console.error(
      `ci: ${skipped} test(s) were SKIPPED — the gate refuses to pass on a suite that skipped itself green. ` +
        'Set the database urls (see .env.example) so every test actually runs.',
    );
    process.exit(1);
  }

  if (code !== 0) {
    console.error(`ci: the test suite failed (exit ${code}).`);
    process.exit(code ?? 1);
  }

  console.log('ci: all gates passed — typecheck, lint, and the full suite with 0 skipped.');
  process.exit(0);
});
