import assert from 'node:assert/strict';
import { test } from 'node:test';

import { navLinksForPermissions } from '@/modules/shell/schema';
import { PERMISSION } from '@/modules/auth/keys';
import { hasKey } from '@/i18n/index';

/**
 * The NAVIGATION is built from the permission set, not the role enum.
 *
 * This is the screen's half of the rule the permission gates enforce: a role a
 * tenant invented must reach the screens it was granted, and must NOT reach the
 * ones it was not. Before this, every role the tenant created saw two links and
 * the admin screens were unreachable without a code change.
 */

/** Every key this build knows — what the seeded Owner role holds. */
const EVERY_PERMISSION = Object.values(PERMISSION);

/** What the seeded Branch role holds that reaches a screen. */
const BRANCH_PERMISSIONS = [
  PERMISSION.stockView,
  PERMISSION.requisitionsView,
  PERMISSION.requisitionsCreate,
  PERMISSION.requisitionsConfirm,
  PERMISSION.usageView,
  PERMISSION.reportsBasic,
];

test('a full permission set sees every screen, in menu order', () => {
  const hrefs = navLinksForPermissions(EVERY_PERMISSION).map((link) => link.href);
  assert.deepEqual(hrefs, [
    '/stock',
    '/requisitions',
    '/intake',
    '/stock/usage',
    '/reports',
    '/roles',
    '/users',
  ]);
});

test('a branch permission set sees only what it may reach', () => {
  const hrefs = navLinksForPermissions(BRANCH_PERMISSIONS).map((link) => link.href);
  // No intake (receiving goods) and no admin screens. The branch DOES see its
  // own usage report — `branch-usage:usage:view` is in the Branch seed, because
  // a branch is the party that records consumption.
  assert.deepEqual(hrefs, ['/stock', '/requisitions', '/stock/usage', '/reports']);
});

test('the admin screens need their own permission — no role name gets them', () => {
  const withoutAdmin = navLinksForPermissions([
    PERMISSION.stockView,
    PERMISSION.requisitionsView,
  ]).map((link) => link.href);
  assert.deepEqual(withoutAdmin, ['/stock', '/requisitions']);

  assert.deepEqual(
    navLinksForPermissions([PERMISSION.rolesManage]).map((link) => link.href),
    ['/roles'],
    'roles:manage opens the roles screen and NOTHING else',
  );
  assert.deepEqual(
    navLinksForPermissions([PERMISSION.usersManage]).map((link) => link.href),
    ['/users'],
    'users:manage opens the users screen and NOTHING else',
  );
});

test('an unknown or missing permission set yields no link at all', () => {
  for (const permissions of [null, undefined, [], ['made:up:key']]) {
    assert.deepEqual(
      navLinksForPermissions(permissions as readonly string[] | null | undefined),
      [],
      'least privilege: a set we do not recognise opens nothing',
    );
  }
});

test('every link has a non-empty href and a present i18n key', () => {
  for (const link of navLinksForPermissions(EVERY_PERMISSION)) {
    assert.ok(link.href.startsWith('/'), `href must be a path: ${link.href}`);
    assert.ok(hasKey(link.key), `missing i18n key ${link.key} (href ${link.href})`);
  }
});
