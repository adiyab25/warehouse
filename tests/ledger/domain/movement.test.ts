import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MOVEMENT_REASONS, signedDelta, validateMovement } from '@/modules/ledger/schema';

/**
 * Unit tests for the movement rules — the pure functions a posting route runs
 * BEFORE it touches the database.
 *
 * A movement is the atom every quantity is derived from, so a malformed one is
 * not a typo to be tolerated: it is a wrong number for ever. These tests pin the
 * closed reason set, the quantity rules (positive, and whole for a discrete
 * item), and the from/to rule the database also enforces.
 */

test('every reason is from the closed list', () => {
  assert.deepEqual(
    [...MOVEMENT_REASONS].sort(),
    [
      'consumption',
      'count_correction',
      'issue_to_branch',
      'opening_balance',
      'receipt',
      'return_from_branch',
      'sale',
      'transfer',
      'write_off',
    ],
    'the reason set is a closed list — a new kind of movement is a decision, not a typo',
  );

  const result = validateMovement({ reason: 'because' });
  assert.equal(result.ok, false, 'a reason outside the list must be refused');
  assert.equal(
    (result as { field: string }).field,
    'reason',
    'the failure must name the offending field',
  );
});

// Review Focus #2: quantity rules. Zero and negatives are meaningless as a
// magnitude (direction is carried by from/to); a fraction of a discrete item is
// not a thing a person can hold.
test('a discrete item rejects zero, negative and fractional quantities', () => {
  for (const qty of [0, -3, 0.5]) {
    const result = validateMovement({ reason: 'receipt', qty, toLocationId: 'WH-1' });
    assert.equal(result.ok, false, `a discrete quantity of ${qty} must be refused`);
    assert.equal(
      (result as { field: string }).field,
      'quantity',
      `the failure for qty ${qty} must name the quantity field`,
    );
  }
});

test('a non-discrete item accepts up to three decimals', () => {
  for (const qty of [2.5, 0.125]) {
    const result = validateMovement({
      reason: 'receipt',
      qty,
      discrete: false,
      toLocationId: 'WH-1',
    });
    assert.equal(result.ok, true, `a measured quantity of ${qty} must be accepted`);
  }

  // ...but not a fourth decimal place: numeric(12,3) cannot hold it.
  const tooPrecise = validateMovement({
    reason: 'receipt',
    qty: 0.0001,
    discrete: false,
    toLocationId: 'WH-1',
  });
  assert.equal(tooPrecise.ok, false, 'a quantity finer than three decimals must be refused');
  assert.equal((tooPrecise as { field: string }).field, 'quantity');
});

test('a movement must name a from and a to, and they must differ', () => {
  const neither = validateMovement({ reason: 'receipt', qty: 1 });
  assert.equal(neither.ok, false, 'a movement naming no location moves nothing');

  const same = validateMovement({ reason: 'transfer', qty: 1, fromLocationId: 'WH-1', toLocationId: 'WH-1' });
  assert.equal(same.ok, false, 'a movement from a place to the same place is not a movement');

  const oneSided = validateMovement({ reason: 'receipt', qty: 1, toLocationId: 'WH-1' });
  assert.equal(oneSided.ok, true, 'a one-sided receipt is a legitimate movement');

  const transfer = validateMovement({ reason: 'transfer', qty: 1, fromLocationId: 'WH-1', toLocationId: 'BR-1' });
  assert.equal(transfer.ok, true, 'a two-sided transfer is a legitimate movement');
});

test('signedDelta gives +qty where stock arrives and -qty where it leaves', () => {
  const transfer = { qty: 3, fromLocationId: 'WH-1', toLocationId: 'BR-1' };
  assert.equal(signedDelta({ ...transfer, locationId: 'BR-1' }), 3, 'the destination gains');
  assert.equal(signedDelta({ ...transfer, locationId: 'WH-1' }), -3, 'the source loses');
  assert.equal(
    signedDelta({ ...transfer, locationId: 'OTHER' }),
    0,
    'a location the movement does not touch contributes nothing',
  );

  assert.equal(
    signedDelta({ qty: 10, toLocationId: 'WH-1', locationId: 'WH-1' }),
    10,
    'a one-sided receipt gains its whole quantity',
  );
});
