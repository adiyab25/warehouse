import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_MAP, ALL_STATUSES } from '../../../src/modules/shell/schema';

const CHECK_STATUSES = ['draft','receiving','posted','requested','approved','partially_issued','issued','received','closed','rejected','returned','open','fulfilled','short'];

test('status map covers every status in CHECK constraints', () => {
  for (const s of CHECK_STATUSES) {
    assert.ok(STATUS_MAP[s], `missing ${s}`);
  }
  assert.equal(ALL_STATUSES.length, CHECK_STATUSES.length);
});