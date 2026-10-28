import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allowedTransitions, canConfirm } from '../../src/domain/requisition.ts';

/**
 * Unit tests for the requisition rules — the pure functions the flow judges a
 * move against BEFORE it touches the database.
 *
 * A branch does not take stock; it asks. The document that records the ask
 * moves through a fixed state machine, and the flow never runs backwards: a
 * requisition that has had stock issued cannot be quietly moved back, and a
 * terminal one (closed, rejected, returned) is final. `canConfirm` is the one
 * gate the confirm step reads: only an `issued` requisition has stock in transit
 * to acknowledge.
 */

test('allowed transitions are exactly the state machine', () => {
  assert.deepEqual(
    allowedTransitions('requested'),
    ['approved', 'rejected'],
    'a requested requisition may only be approved or rejected',
  );
  assert.deepEqual(
    allowedTransitions('approved'),
    ['issued', 'partially_issued'],
    'an approved requisition may be issued in full or in part',
  );
  assert.deepEqual(
    allowedTransitions('partially_issued'),
    ['issued', 'partially_issued', 'received'],
    'a partly-issued requisition may be issued again, completed, or finished by receipt',
  );
  assert.deepEqual(
    allowedTransitions('issued'),
    ['received', 'partially_issued'],
    'a fully-issued requisition completes to `received`, or falls back to `partially_issued` when a confirm leaves stock on the road',
  );
  assert.deepEqual(
    allowedTransitions('received'),
    ['closed', 'returned'],
    'received goods may be closed or returned to the warehouse',
  );
  assert.deepEqual(allowedTransitions('closed'), [], 'closed is terminal');
  assert.deepEqual(allowedTransitions('rejected'), [], 'rejected is terminal');
  assert.deepEqual(allowedTransitions('returned'), [], 'returned is terminal');
});

test('a requisition cannot be confirmed while still requested', () => {
  assert.equal(canConfirm('requested'), false, 'nothing has been issued yet — there is nothing to confirm');
  assert.equal(canConfirm('approved'), false, 'approved stock has not left the warehouse');
  assert.equal(
    canConfirm('partially_issued'),
    true,
    'a partial issue has stock in transit — the branch must be able to confirm what has arrived',
  );
  assert.equal(canConfirm('issued'), true, 'an issued requisition has stock in transit to confirm');
  assert.equal(canConfirm('received'), false, 'an already-received requisition cannot be confirmed again');
  assert.equal(canConfirm('closed'), false, 'a closed requisition is terminal');
  assert.equal(canConfirm('rejected'), false, 'a rejected requisition is terminal');
});
