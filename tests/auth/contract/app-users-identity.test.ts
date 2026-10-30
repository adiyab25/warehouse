import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { normaliseName } from '@/modules/platform/schema';
import { withTenant } from '@/modules/platform/index';
import { sqlTestUrl, withDb } from '../../harness/sql.ts';
import { cleanupTenants, provisionTenants } from '../../harness/tenants.ts';

/**
 * IDENTITY, proven in the schema.
 *
 * Review found two things about `app_users` that made two people one account:
 *
 *   * `name` had NO unique constraint while sign-in looked people up BY NAME,
 *     so two employees called أحمد علي were one identity — one person's password
 *     checked against the other's hash, and one shared lockout bucket.
 *   * the name was normalised with ASCII rules (`trim().toUpperCase()`, a NO-OP
 *     for Arabic), so the stored أحمد علي rejected احمد علي (the ordinary
 *     spelling, bare alef) and أحمد  علي (a double space).
 *
 * The fixes are constraints (migration 0012), and these tests are about the
 * CONSTRAINTS — they insert through the app role, so the RLS policy applies
 * too, and they assert the duplicate/unfolded insert is REFUSED rather than
 * merely discouraged.
 */

after(async () => {
  if (!sqlTestUrl()) return;
  await cleanupTenants();
});

/**
 * Inserts an app_user through the app role, inside a pinned tenant.
 *
 * `nameNormalised` defaults to what the DATABASE would compute for `name`, so a
 * test only passes the value explicitly when it is deliberately WRONG.
 */
async function insertUser(
  db: Parameters<typeof withTenant>[0],
  tenant: string,
  user: {
    name: string;
    username: string;
    nameNormalised?: string;
    role?: string;
  },
): Promise<void> {
  await withTenant(db, tenant, (tdb) =>
    tdb.query(
      `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid,
               $1, coalesce($2::text, public.normalise_name($1)), $3, $4, 'x')`,
      [user.name, user.nameNormalised ?? null, user.username, user.role ?? 'branch_user'],
    ),
  );
}

test('two people with the SAME NAME are two accounts — the username tells them apart', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provisionTenants();

  await withDb(async (db) => {
    const shared = 'أحمد علي';

    // Two employees, one name, two assigned usernames: BOTH are accepted, and
    // they are distinct rows. (Before 0012 this was the situation the app could
    // not survive — one name, one identity.)
    await insertUser(db, t1, { name: shared, username: 'ahmed_1' });
    await insertUser(db, t1, { name: shared, username: 'ahmed_2' });

    const rows = await withTenant(db, t1, (tdb) =>
      tdb.query<{ id: string; username: string }>(
        `select id, username from app_users where name = $1 order by username`,
        [shared],
      ),
    );
    assert.equal(rows.rows.length, 2, 'the same name twice must be TWO users, not one');
    assert.deepEqual(
      rows.rows.map((r) => r.username),
      ['ahmed_1', 'ahmed_2'],
    );

    // THE CONSTRAINT: a second user with the SAME username in the SAME tenant is
    // refused. This is the assertion that fails the moment the unique constraint
    // is removed — without it every "look up by username" query silently becomes
    // "pick one of them".
    await assert.rejects(
      () => insertUser(db, t1, { name: 'someone else', username: 'ahmed_1' }),
      (err: { code?: string }) => err.code === '23505',
      'a duplicate username within a tenant must violate the unique constraint',
    );

    // ...and it is per TENANT: another client may have its own `ahmed_1`.
    await insertUser(db, t2, { name: shared, username: 'ahmed_1' });
  });
});

test('a username is stored normalised and inside its charset', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provisionTenants();

  await withDb(async (db) => {
    // Refused by the CHECK: un-normalised spellings (upper-case, padded, empty)
    // and anything outside `^[a-z0-9][a-z0-9._-]{2,31}$`.
    for (const username of ['Owner1', ' owner1 ', 'owner one', 'ab', '_owner1', '.owner1', 'أحمد', 'a'.repeat(33)]) {
      await assert.rejects(
        () => insertUser(db, t1, { name: 'Charset Probe', username }),
        (err: { code?: string }) => err.code === '23514' || err.code === '23505',
        `the username ${JSON.stringify(username)} must be refused`,
      );
    }

    // A well-formed one is accepted, and stored exactly as given.
    await insertUser(db, t1, { name: 'Charset Probe', username: 'sara.zaki-2' });
  });
});

test('the Arabic normaliser and its SQL twin agree, case for case', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provisionTenants();

  await withDb(async (db) => {
    const cases = [
      'أحمد علي',
      ' أحمد علي ',
      'احمد علي',
      'أحمد  علي',
      'مصطفى',
      'أسامه',
      'محمّـد',
      'ا\u0654حمد علي', // alef + combining hamza (NFKC recomposes it)
      'أحمد\u00a0علي', // NBSP
    ];

    for (const raw of cases) {
      const { rows } = await db.query<{ n: string }>('select public.normalise_name($1) as n', [raw]);
      assert.equal(
        rows[0]!.n,
        normaliseName(raw),
        `src/domain/text.ts and public.normalise_name must agree on ${JSON.stringify(raw)}`,
      );
    }

    // The four review cases fold to ONE stored name, and the DATABASE agrees.
    const folded = ['أحمد علي', ' أحمد علي ', 'احمد علي', 'أحمد  علي'].map(normaliseName);
    assert.equal(new Set(folded).size, 1, 'the four spellings must be one stored name');
    assert.equal(folded[0], 'احمد علي');

    // Storing the hamza spelling with the BARE-ALEF normalised form is accepted:
    // that is exactly what the "name as typed + normalised name" pair is for.
    await insertUser(db, t1, { name: 'أحمد علي', username: 'fold_probe_1', nameNormalised: 'احمد علي' });
    // ...and the double-space spelling, likewise.
    await insertUser(db, t1, { name: 'أحمد  علي', username: 'fold_probe_2', nameNormalised: 'احمد علي' });

    // THE DISCRIMINATING CASE: an UNFOLDED normalised name is refused. Storing
    // 'أحمد علي' as the normalised form of 'أحمد علي' is what the OLD ASCII rule
    // produced, and it is precisely the bug — the same person, two spellings,
    // unmatched. If the Arabic folding is ever reverted, this insert starts
    // succeeding and the assertion below fails.
    await assert.rejects(
      () => insertUser(db, t1, { name: 'أحمد علي', username: 'fold_probe_4', nameNormalised: 'أحمد علي' }),
      (err: { code?: string }) => err.code === '23514',
      'an un-folded name_normalised must be refused — that is the Arabic bug',
    );
    await assert.rejects(
      () => insertUser(db, t1, { name: 'أحمد  علي', username: 'fold_probe_5', nameNormalised: 'أحمد  علي' }),
      (err: { code?: string }) => err.code === '23514',
      'a double-space name_normalised must be refused',
    );

    // Both accepted spellings really are the same normalised name on disk.
    const { rows } = await withTenant(db, t1, (tdb) =>
      tdb.query<{ normalised: string }>(
        `select distinct name_normalised as normalised from app_users
          where username like 'fold_probe%'`,
      ),
    );
    assert.deepEqual(rows.map((r) => r.normalised), ['احمد علي']);
  });
});
