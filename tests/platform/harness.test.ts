import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sqlTestUrl, withDb } from '../harness/sql.ts';

// Smoke test for the harness's exported API: `withDb(fn)` must hand back a live
// client with a working typed `query`, connected as the non-superuser
// `authenticated` role. Later tasks mirror this interface, so it has to be
// proven to actually work — not merely type-check.
test('withDb hands back a typed connection running as the non-superuser authenticated role', { skip: !sqlTestUrl() }, async () => {
  const result = await withDb(async (db) => {
    const who = await db.query<{ current_user: string; is_superuser: boolean }>(
      `select current_user as current_user,
              r.rolsuper as is_superuser
         from pg_roles r
        where r.rolname = current_user`,
    );
    const one = await db.query<{ n: number }>('select 1 as n');
    return { who: who.rows[0], one: one.rows[0] };
  });

  assert.equal(result.who.current_user, 'authenticated');
  assert.equal(
    result.who.is_superuser,
    false,
    'the test role must not be a superuser — a superuser bypasses RLS',
  );
  assert.equal(result.one.n, 1, 'a typed query through withDb must return rows');
});
