import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareReconciliation, runInProcess } from '../../../scripts/e2e-flow.mjs';
import { migrateUrl, sqlTestUrl } from '../../harness/sql.ts';

/**
 * THE END-TO-END GATE (in-process half). Never skipped: with no database
 * configured it FAILS, because a gate that skips itself green proves nothing.
 *
 * The flow itself lives in scripts/e2e-flow.mjs so `npm run e2e` runs the very
 * same code (plus the HTTP smoke). It talks to the database ONLY through the
 * real writers as the NON-owner role (`SQL_TEST_DATABASE_URL`); the owner
 * connection (`MIGRATE_DATABASE_URL`) creates and deletes the fresh tenants.
 */
test('factory -> warehouse -> branch -> confirm -> return, counts all the way', async () => {
  const ownerUrl = migrateUrl();
  const appUrl = sqlTestUrl();
  assert.ok(ownerUrl && appUrl, 'MIGRATE_DATABASE_URL and SQL_TEST_DATABASE_URL must be set');

  const r = await runInProcess({ ownerUrl, appUrl });

  // After EACH step, the on-hand per location (asserted inside the flow; echoed here).
  assert.deepEqual(r.steps, [
    { step: 'receipt', WH: '40', TRANSIT: '0', BR: '0' },
    { step: 'issue', WH: '30', TRANSIT: '10', BR: '0' },
    { step: 'confirm', WH: '30', TRANSIT: '0', BR: '10' },
    { step: 'return', WH: '32', TRANSIT: '0', BR: '8' },
    { step: 'count', WH: '31', TRANSIT: '0', BR: '8' },
  ]);
  assert.deepEqual(r.reasons, [
    'receipt',
    'issue_to_branch',
    'issue_to_branch',
    'return_from_branch',
    'count_correction',
  ]);
  assert.equal(r.cleanup.rowsLeft, 0, 'the fresh tenants are fully deleted');
  assert.equal(r.reconciliation?.ok, true);
});

test('the reconciliation is not vacuous: a doctored view total is caught, a matching one is not', () => {
  const ledger = { v1: 39000n, v2: 5500n };
  assert.deepEqual(compareReconciliation({ v1: 39000n, v2: 5500n }, ledger), []);
  const bad = compareReconciliation({ v1: 38000n, v2: 5500n }, ledger);
  assert.deepEqual(bad, [{ variantId: 'v1', view: '38', ledger: '39' }]);
  // A variant the view never heard of, or one that vanished from it, is a mismatch too.
  assert.equal(compareReconciliation({ v1: 39000n, v2: 5500n, v3: 1n }, ledger).length, 1);
  assert.equal(compareReconciliation({ v1: 39000n }, ledger).length, 1);
});

test('the e2e flow refuses to run as the database OWNER (a bypassing role proves nothing)', async () => {
  const ownerUrl = migrateUrl();
  assert.ok(ownerUrl, 'MIGRATE_DATABASE_URL must be set');
  await assert.rejects(() => runInProcess({ ownerUrl, appUrl: ownerUrl }), /refusing to serve as role/);
});
