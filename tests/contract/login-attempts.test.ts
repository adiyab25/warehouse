import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { LOCKOUT_THRESHOLD, signIn } from '../../src/auth/login.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { readSession } from '../../src/auth/session.ts';
import { withTenant } from '../../src/db/client.ts';
import { sqlTestUrl, withDb } from '../harness/sql.ts';
import { USERNAME_ONE, cleanupTenants, provisionTenants } from '../harness/tenants.ts';

/**
 * Contract tests for sign-in against a real database on the NON-owner
 * `authenticated` role, so row-level security actually applies.
 *
 * They prove what the shell stands on, including the four things review found
 * MISSING or WRONG before:
 *
 *   (1) A correct password creates a SESSION (resolvable back to the user) and
 *       WRITES a success row into `login_attempts` — the attempt is recorded,
 *       not merely accepted.
 *   (2) Five failures LOCK the USERNAME, and the sixth is refused WITHOUT
 *       running the password KDF (an injected stub proves it is never called) —
 *       even when the sixth attempt carries the CORRECT password.
 *   (3) The lockout does NOT destroy the audit trail: a success KEEPS the
 *       failures that preceded it (it used to delete them), and a locked
 *       username KEEPS refusing to add rows, so the lock cannot be EXTENDED by
 *       an attacker who keeps knocking.
 *   (4) The WINDOW is a window: failures inside it lock, failures older than it
 *       do not.
 *   (5) `login_attempts` is tenant-scoped on BOTH halves of the policy, and the
 *       human-typed username is stored NORMALISED (trim + lower) — enforced in
 *       code AND by a CHECK that refuses a raw non-normalised insert.
 *   (6) Retention: `purge_login_attempts(interval)` reclaims OLD rows, leaves
 *       recent ones, and can only touch the tenant it is scoped to.
 */

const PASSWORD = 'correct horse battery staple';

after(async () => {
  if (!sqlTestUrl()) return;
  await cleanupTenants();
});

/** Counts the attempt rows of one username in one tenant, through the app role. */
async function attemptStats(
  db: Parameters<typeof withTenant>[0],
  tenant: string,
  identifier: string,
): Promise<{ total: number; failures: number; lastFailure: Date | null }> {
  const { rows } = await withTenant(db, tenant, (tdb) =>
    tdb.query<{ total: number; failures: number; last_failure: Date | null }>(
      `select count(*)::int                                     as total,
              count(*) filter (where not succeeded)::int         as failures,
              max(attempted_at) filter (where not succeeded)     as last_failure
         from login_attempts
        where identifier = $1`,
      [identifier],
    ),
  );
  const row = rows[0]!;
  return { total: row.total, failures: row.failures, lastFailure: row.last_failure };
}

test('a successful sign-in creates a session and records a success', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1, username1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );

    const result = await withTenant(db, t1, (tdb) =>
      signIn(tdb, { username: username1, password: PASSWORD }),
    );
    assert.equal(result.ok, true, 'a correct password must sign in');
    if (!result.ok) return;

    // The token resolves to the very user we signed in as.
    const session = await withTenant(db, t1, (tdb) => readSession(tdb, result.token));
    assert.equal(session?.userId, u1, 'the issued token must resolve back to the user');

    // ...and a SUCCESS was actually written, not merely accepted.
    const { rows } = await withTenant(db, t1, (tdb) =>
      tdb.query<{ succeeded: boolean }>(
        `select succeeded from login_attempts where identifier = $1`,
        [username1],
      ),
    );
    assert.ok(
      rows.some((r) => r.succeeded === true),
      'a successful sign-in must record a success row in login_attempts',
    );
  });
});

test('five failures lock the username, and a sixth is refused without checking the password', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1, username1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );

    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      const attempt = await withTenant(db, t1, (tdb) =>
        signIn(tdb, { username: username1, password: 'not the password' }),
      );
      assert.equal(attempt.ok, false, `failure #${i + 1} must not sign in`);
      assert.equal(attempt.ok === false && attempt.reason, 'invalid');
    }

    // The sixth attempt carries the CORRECT password, yet must still be refused
    // — and must NOT touch the password KDF at all.
    let kdfCalls = 0;
    const sixth = await withTenant(db, t1, (tdb) =>
      signIn(tdb, { username: username1, password: PASSWORD }, {
        verifyPassword: async () => {
          kdfCalls += 1;
          return true;
        },
      }),
    );
    assert.equal(sixth.ok, false, 'a locked username must be refused');
    assert.equal(sixth.ok === false && sixth.reason, 'locked');
    assert.equal(kdfCalls, 0, 'a locked username must be refused WITHOUT checking the password');

    // And the CORE-2 property: an unknown username locks exactly like a real
    // one, because an attempt is recorded for a username that does not exist.
    const ghost = 'ghost_user';
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await withTenant(db, t1, (tdb) =>
        signIn(tdb, { username: ghost, password: 'not the password' }),
      );
    }
    let ghostKdf = 0;
    const ghostSixth = await withTenant(db, t1, (tdb) =>
      signIn(tdb, { username: ghost, password: 'not the password' }, {
        verifyPassword: async () => {
          ghostKdf += 1;
          return false;
        },
      }),
    );
    assert.equal(
      ghostSixth.ok === false && ghostSixth.reason,
      'locked',
      'a username that does not exist must lock just like a real one',
    );
    assert.equal(ghostKdf, 0, 'and be refused on the same path, with no KDF call');
  });
});

test('a locked username is not RECORDED again — the lock cannot be extended', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1, username1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );

    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await withTenant(db, t1, (tdb) =>
        signIn(tdb, { username: username1, password: 'not the password' }),
      );
    }

    const locked = await attemptStats(db, t1, username1);
    assert.equal(locked.failures, LOCKOUT_THRESHOLD, 'the failures were recorded while unlocked');

    // The attacker keeps knocking for the length of the window. Every attempt
    // must be REFUSED and NONE of them recorded — that is what stops the old
    // "one request every 14 minutes holds the account shut forever" attack:
    // nothing moves `last_failure`, so the window runs out on schedule.
    for (let i = 0; i < 5; i += 1) {
      const refused = await withTenant(db, t1, (tdb) =>
        signIn(tdb, { username: username1, password: 'not the password' }),
      );
      assert.equal(refused.ok === false && refused.reason, 'locked');
    }

    const after = await attemptStats(db, t1, username1);
    assert.equal(after.total, locked.total, 'a refused attempt must not add a row');
    assert.equal(after.failures, locked.failures, 'a refused attempt must not add a failure');
    assert.deepEqual(
      after.lastFailure,
      locked.lastFailure,
      'the last failure (and so the end of the lock) must not move',
    );
  });
});

test('the lockout WINDOW: failures older than the window do not lock, fresh ones do', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1, username1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );

    // A burst of failures 30 minutes ago — MORE than the threshold, and one
    // attempt 20 minutes ago, all outside the 15-minute window. If the window
    // were ever widened to "forever" (or the count ignored `attempted_at`
    // entirely) this username would be locked and the assertions below would
    // fail — which is exactly what this test is for.
    await withTenant(db, t1, (tdb) =>
      tdb.query(
        `insert into login_attempts (tenant_id, identifier, succeeded, attempted_at)
         select nullif(current_setting('app.tenant_id', true), '')::uuid,
                $1, false, now() - interval '30 minutes'
           from generate_series(1, $2::int)`,
        [username1, LOCKOUT_THRESHOLD],
      ),
    );
    await withTenant(db, t1, (tdb) =>
      tdb.query(
        `insert into login_attempts (tenant_id, identifier, succeeded, attempted_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, false,
                 now() - interval '20 minutes')`,
        [username1],
      ),
    );

    // NOT locked: the correct password signs in even though the identifier has
    // more failures than the threshold on record.
    const signInResult = await withTenant(db, t1, (tdb) =>
      signIn(tdb, { username: username1, password: PASSWORD }),
    );
    assert.equal(
      signInResult.ok,
      true,
      'failures older than the window must NOT lock the username out',
    );

    // Now FRESH failures, inside the window, do lock it.
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await withTenant(db, t1, (tdb) =>
        signIn(tdb, { username: username1, password: 'not the password' }),
      );
    }
    const locked = await withTenant(db, t1, (tdb) =>
      signIn(tdb, { username: username1, password: PASSWORD }),
    );
    assert.equal(locked.ok === false && locked.reason, 'locked', 'fresh failures must lock');
  });
});

test('a success does NOT delete the failures that preceded it', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1, username1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );

    // A few failures — deliberately BELOW the threshold.
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) {
      await withTenant(db, t1, (tdb) =>
        signIn(tdb, { username: username1, password: 'not the password' }),
      );
    }
    const before = await attemptStats(db, t1, username1);
    assert.equal(before.failures, LOCKOUT_THRESHOLD - 1, 'the failures were recorded');

    const result = await withTenant(db, t1, (tdb) =>
      signIn(tdb, { username: username1, password: PASSWORD }),
    );
    assert.equal(result.ok, true, 'the correct password must sign in');

    // The failures SURVIVE. Deleting them on success destroyed the only record
    // of the brute force that led up to a successful sign-in — and a success is
    // not evidence that the failures did not happen. The success is marked with
    // its own row's `succeeded = true`, not by erasing anything.
    const after = await attemptStats(db, t1, username1);
    assert.equal(
      after.failures,
      before.failures,
      'a successful sign-in must KEEP the failures that preceded it (audit history)',
    );
    assert.equal(after.total, before.total + 1, 'the success is recorded as its own row');
  });
});

test('the attempts of one tenant are invisible to another', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2, u1, username1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );

    const count = async (tenant: string) =>
      (await attemptStats(db, tenant, username1)).total;

    // Two failures against tenant one.
    for (let i = 0; i < 2; i += 1) {
      await withTenant(db, t1, (tdb) =>
        signIn(tdb, { username: username1, password: 'not the password' }),
      );
    }

    assert.equal(await count(t1), 2, 'tenant one must see its own two attempts');
    assert.equal(await count(t2), 0, "another tenant must NOT see tenant one's attempts");
  });
});

test('a cross-tenant attempt insert is refused by the WITH CHECK half of the policy', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provisionTenants();

  await withDb(async (db) => {
    // Scoped to tenant ONE, writing a row that claims tenant TWO. The SELECT
    // half of the policy is covered above; this is the INSERT half, and without
    // it one tenant could plant failures in another's trail (or in nobody's).
    await assert.rejects(
      () =>
        withTenant(db, t1, (tdb) =>
          tdb.query(
            `insert into login_attempts (tenant_id, identifier, succeeded)
             values ($1, 'planted', false)`,
            [t2],
          ),
        ),
      (err: { code?: string; message?: string }) =>
        err.code === '42501' || /row-level security/i.test(err.message ?? ''),
      'inserting an attempt for another tenant must be refused by the with check clause',
    );
  });
});

test('a username is stored normalised, and a raw insert cannot bypass it', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1, username1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    // A RAW, non-normalised insert must be refused by the database itself —
    // untrimmed, and upper-case. Each attempt gets its OWN transaction, because
    // a CHECK violation aborts the enclosing one.
    for (const raw of [' Owner_1 ', 'OWNER_1', 'Owner_1']) {
      await assert.rejects(
        () =>
          withTenant(db, t1, (tdb) =>
            tdb.query(
              `insert into login_attempts (tenant_id, identifier, succeeded)
               values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, false)`,
              [raw],
            ),
          ),
        (err: { code?: string }) => err.code === '23514',
        `a raw non-normalised identifier ${JSON.stringify(raw)} must be refused with a CHECK violation`,
      );
    }

    // The APP path stores it normalised: '  Owner_1  ' -> 'owner_1'.
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );
    await withTenant(db, t1, (tdb) =>
      signIn(tdb, { username: `  ${username1.toUpperCase()}  `, password: 'not the password' }),
    );

    const { rows } = await withTenant(db, t1, (tdb) =>
      tdb.query<{ identifier: string }>(`select identifier from login_attempts`),
    );
    assert.ok(
      rows.some((r) => r.identifier === username1),
      `the identifier must be stored trim+lower ('  ${username1.toUpperCase()}  ' -> '${username1}')`,
    );
  });
});

test('retention: the sweep reclaims old attempts, keeps recent ones, and stays in its tenant', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provisionTenants();

  await withDb(async (db) => {
    const plant = (tenant: string, age: string, n: number) =>
      withTenant(db, tenant, (tdb) =>
        tdb.query(
          `insert into login_attempts (tenant_id, identifier, succeeded, attempted_at)
           select nullif(current_setting('app.tenant_id', true), '')::uuid,
                  'sweep_probe', false, now() - $1::interval
             from generate_series(1, $2::int)`,
          [age, n],
        ),
      );

    // Two OLD attempts (well past the retention window) and one recent, in
    // tenant one; one OLD attempt in tenant two, which must survive a sweep run
    // scoped to tenant one.
    await plant(t1, '2 days', 2);
    await plant(t1, '1 minute', 1);
    await plant(t2, '2 days', 1);

    const swept = await withTenant(db, t1, (tdb) =>
      tdb.query<{ p: number }>(`select public.purge_login_attempts(interval '1 day') as p`),
    );
    assert.equal(swept.rows[0]!.p, 2, 'the sweep must delete exactly the two old attempts');

    const left = await withTenant(db, t1, (tdb) =>
      tdb.query<{ n: number }>(
        `select count(*)::int as n from login_attempts where identifier = 'sweep_probe'`,
      ),
    );
    assert.equal(left.rows[0]!.n, 1, 'the recent attempt must NOT be swept away');

    const otherTenant = await withTenant(db, t2, (tdb) =>
      tdb.query<{ n: number }>(
        `select count(*)::int as n from login_attempts where identifier = 'sweep_probe'`,
      ),
    );
    assert.equal(
      otherTenant.rows[0]!.n,
      1,
      "a sweep scoped to tenant one must not touch another tenant's audit trail",
    );
  });
});
