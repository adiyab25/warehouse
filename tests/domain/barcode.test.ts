import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatSku, isValidScannedCode, normaliseScannedCode } from '../../src/domain/barcode.ts';

/**
 * Unit tests for the barcode helpers — the pure functions a scan route runs
 * BEFORE it touches the database.
 *
 * A scanned code arrives from a handheld or a keyboard exactly as the person
 * left it: padded with spaces, lower-cased, or mistyped. Normalising and
 * validating first is what keeps a mistyped code from reaching a lookup (and,
 * worse, from ever becoming a new row).
 */

test('a scanned code with whitespace or lowercase is normalised', () => {
  assert.equal(
    normaliseScannedCode('  ab-0012 '),
    'AB-0012',
    'trim and upper-case turn the raw scan into the canonical code stored in the database',
  );
  assert.equal(
    isValidScannedCode('  ab-0012 '),
    true,
    'a normalised code is valid, so validation must normalise before it judges',
  );
});

test('a malformed code is rejected before any lookup', () => {
  for (const bad of ['', 'x', 'AB 0012']) {
    assert.equal(
      isValidScannedCode(bad),
      false,
      `${JSON.stringify(bad)} must be rejected — a blank, an unshaped token and an embedded space are not codes`,
    );
  }
});

test('formatSku pads a sequence into a stable code', () => {
  assert.equal(formatSku('KG', 12), 'KG-0012', 'the sequence is zero-padded to a fixed width');
  assert.equal(formatSku('kg', 7), 'KG-0007', 'the prefix is upper-cased like every other code');
  assert.equal(formatSku('KG', 12345), 'KG-12345', 'a longer sequence is not truncated');
});
