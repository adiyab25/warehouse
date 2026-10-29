import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emit } from '@/modules/events/domain/events';

/** `emit` must refuse sensitive payload keys at ANY depth, before touching the db. */
const calls: unknown[] = [];
const fakeDb = { query: async (...a: unknown[]) => (calls.push(a), { rows: [], rowCount: 0 }) } as any;
const ev = (payload: Record<string, unknown>) => ({ type: 'stock.low' as const, tenantId: 't', occurredAt: new Date().toISOString(), payload });

const KEYS = ['token', 'apiToken', 'secret', 'clientSecret', 'hash', 'tokenHash', 'passwordHash', 'password', 'email', 'e-mail', 'userEmail', 'EMAIL', 'Token'];

test('emit refuses every sensitive key at top level', async () => {
  for (const k of KEYS) {
    await assert.rejects(emit(fakeDb, ev({ ok: '1', [k]: 'x' })), /may not appear/, k);
  }
  assert.equal(calls.length, 0, 'nothing reached the db');
});

test('emit refuses sensitive keys nested in objects and arrays', async () => {
  for (const k of KEYS) {
    await assert.rejects(emit(fakeDb, ev({ a: { b: { [k]: 'x' } } })), /may not appear/, `nested ${k}`);
    await assert.rejects(emit(fakeDb, ev({ list: [{ ok: 1 }, { [k]: 'x' }] })), /may not appear/, `array ${k}`);
  }
  assert.equal(calls.length, 0);
});

test('emit accepts a safe payload', async () => {
  await emit(fakeDb, ev({ movementId: 'm', actor: { type: 'api_client', name: 'POS' }, qty: '1.000', rows: [{ sku: 'A' }] }));
  assert.equal(calls.length, 1);
});
