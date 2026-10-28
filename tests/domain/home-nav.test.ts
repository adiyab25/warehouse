import assert from 'node:assert/strict';
import { test } from 'node:test';

import { navLinksForRole } from '../../src/domain/home-nav.ts';
import { hasKey } from '../../src/i18n/index.ts';

test('a warehouse role sees every screen', () => {
  for (const role of ['owner', 'warehouse_manager']) {
    const hrefs = navLinksForRole(role).map((l) => l.href);
    assert.deepEqual(hrefs, ['/stock', '/requisitions', '/intake', '/stock/usage', '/reports']);
  }
});

test('a branch user sees stock and requisitions only', () => {
  const hrefs = navLinksForRole('branch_user').map((l) => l.href);
  // A branch cannot receive goods (intake), see the accounts view, or read the
  // replenishment report — those are the warehouse's screens.
  assert.deepEqual(hrefs, ['/stock', '/requisitions']);
});

test('an unknown or missing role is treated as least privilege', () => {
  for (const role of [null, undefined, '', 'accountant']) {
    const hrefs = navLinksForRole(role).map((l) => l.href);
    assert.deepEqual(hrefs, ['/stock', '/requisitions']);
  }
});

test('every link has a non-empty href and a present i18n key', () => {
  for (const role of ['owner', 'warehouse_manager', 'branch_user']) {
    for (const l of navLinksForRole(role)) {
      assert.ok(l.href.startsWith('/'), `href must be a path: ${l.href}`);
      assert.ok(hasKey(l.key), `missing i18n key ${l.key} (href ${l.href})`);
    }
  }
});