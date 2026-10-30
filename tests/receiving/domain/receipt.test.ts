import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lineVariance, packToUnits } from '@/modules/receiving/schema';

/**
 * Unit tests for the receipt rules — the pure functions the receiving path runs
 * BEFORE it touches the database.
 *
 * Consumables are bought by the carton and issued as singles, so a quantity a
 * person types is often in PURCHASE PACKS, not base units. The pack factor is
 * the one place that conversion happens, and it is used ONLY at receiving (the
 * ledger always holds base units). The variance is what the system reports
 * instead of absorbing: a delivery that is short must surface as a negative
 * number, an over-delivery as a positive one.
 */

test('two cartons of 24 post as 48 units', () => {
  assert.equal(packToUnits(2, 24), 48, 'entering 2 packs of a pack_factor-24 item must post 48 units');
});

test('an item with no pack factor posts the entered number', () => {
  assert.equal(packToUnits(7, null), 7, 'with no pack factor the entered number IS the base-unit count');
});

test('lineVariance reports the shortfall as a negative number', () => {
  assert.equal(lineVariance(40, 36), -4, 'received 36 against expected 40 is a shortfall of -4');
});
