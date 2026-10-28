import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { configuredTenantId } from '../../src/auth/tenant.ts';

/**
 * Unit tests for the DEPLOYMENT-CONFIG tenant resolver.
 *
 * v1 is one deployment per client, so the tenant id is configuration
 * (`TENANT_ID`), not a runtime lookup. The property that matters is that an
 * unset or malformed value fails LOUDLY — a deployment that does not know its
 * tenant must not silently scope to nothing (or to the wrong tenant).
 */

const KEY = 'TENANT_ID';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

test('configuredTenantId returns the configured tenant id', () => {
  process.env[KEY] = '11111111-2222-3333-4444-555555555555';
  assert.equal(configuredTenantId(), '11111111-2222-3333-4444-555555555555');

  // Trimmed, so a stray space in a deployment manifest is not a different id.
  process.env[KEY] = '  11111111-2222-3333-4444-555555555555  ';
  assert.equal(configuredTenantId(), '11111111-2222-3333-4444-555555555555');
});

test('configuredTenantId throws a clear error when TENANT_ID is unset or malformed', () => {
  delete process.env[KEY];
  assert.throws(() => configuredTenantId(), /TENANT_ID is not set/, 'an unset TENANT_ID must throw');

  process.env[KEY] = '   ';
  assert.throws(() => configuredTenantId(), /TENANT_ID is not set/, 'a blank TENANT_ID must throw');

  process.env[KEY] = 'not-a-uuid';
  assert.throws(
    () => configuredTenantId(),
    /must be a tenant uuid/,
    'a malformed TENANT_ID must throw rather than scope to nothing',
  );

  // The NIL uuid has a valid uuid SHAPE and is still not a tenant. It is what a
  // placeholder (`.env.example`, a scaffold, a half-filled manifest) contains,
  // and a deployment that boots scoped to it would pin a tenant id that owns no
  // rows: every query returns nothing and every sign-in fails as "invalid",
  // which reads as a wrong password instead of a misconfiguration.
  process.env[KEY] = '00000000-0000-0000-0000-000000000000';
  assert.throws(
    () => configuredTenantId(),
    /nil uuid/,
    'the nil uuid must be rejected — it is a placeholder, not a tenant',
  );
  // ...and it cannot be smuggled past the check by its case or its padding.
  process.env[KEY] = '  00000000-0000-0000-0000-000000000000  ';
  assert.throws(() => configuredTenantId(), /nil uuid/);
});
