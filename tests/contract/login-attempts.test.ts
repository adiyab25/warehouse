import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { LOCKOUT_THRESHOLD, signIn } from '../../src/auth/login.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { readSession } from '../../src/auth/session.ts';
import { withTenant } from '../../src/db/client.ts';
import { sqlTestUrl, withDb } from '../harness/sql.ts';
import { cleanupTenants, provisionTenants } from '../harness/tenants.ts';

/**
 * Contract tests for sign-in against a real database on the NON-owner
 * `authenticated` role, so row-level security actually applies.
 *
 * They prove the four things the shell stands on:
 *
 *   (1) A correct password creates a SESSION (resolvable back to the user) and
 *       WRITES a success row into `login_attempts` — the attempt is recorded,
 *       not merely accepted.
 *   (2) Five failures LOCK the identifier, and the sixth is refused WITHOUT
 *       running the password KDF (injected stub proves it is never called) —
 *       even when the sixth attempt carries the CORRECT password.
 *   (3) A success CLEARS the failure count, so a legitimate user is not locked
 *       out by an earlier run of failures.
 *   (4) `login_attempts` is tenant-scoped: one tenant's failures are invisible
 *       to another, and the human-typed identifier is stored NORMALISED
 *       (trim + upper) — enforced in code AND by a CHECK that refuses a raw
 *       non-normalised insert.
 */

const PASSWORD = 'correct horse battery staple';

after(async () => {
  if (!sqlTestUrl()) return;
  await cleanupTenants();
});

test('a successful sign-in creates a session and records a success', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );

    const result = await withTenant(db, t1, (tdb) =>
      signIn(tdb, { userLookup: 'Owner One', password: PASSWORD }),
    );
    assert.equal(result.ok, true, 'a correct password must sign in');
    if (!result.ok) return;

    // The token resolves to the very user we signed in as.
    const session = await withTenant(db, t1, (tdb) => readSession(tdb, result.token));
    assert.equal(session?.userId, u1, 'the issued token must resolve back to the user');

    // ...and a SUCCESS was actually written, not merely accepted.
    const { rows } = await withTenant(db, t1, (tdb) =>
      tdb.query<{ succeeded: boolean }>(
        `select succeeded from login_attempts where identifier = 'OWNER ONE'`,
      ),
    );
    assert.ok(
      rows.some((r) => r.succeeded === true),
      'a successful sign-in must record a success row in login_attempts',
    );
  });
});

test('five failures lock the identifier, and a sixth is refused without checking the password', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );

    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      const attempt = await withTenant(db, t1, (tdb) =>
        signIn(tdb, { userLookup: 'Owner One', password: 'not the password' }),
      );
      assert.equal(attempt.ok, false, `failure #${i + 1} must not sign in`);
      assert.equal(attempt.ok === false && attempt.reason, 'invalid');
    }

    // The sixth attempt carries the CORRECT password, yet must still be refused
    // — and must NOT touch the password KDF at all.
    let kdfCalls = 0;
    const sixth = await withTenant(db, t1, (tdb) =>
      signIn(tdb, { userLookup: 'Owner One', password: PASSWORD }, {
        verifyPassword: async () => {
          kdfCalls += 1;
          return true;
        },
      }),
    );
    assert.equal(sixth.ok, false, 'a locked identifier must be refused');
    assert.equal(sixth.ok === false && sixth.reason, 'locked');
    assert.equal(kdfCalls, 0, 'a locked identifier must be refused WITHOUT checking the password');
  });
});

test('a success clears the failure count', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );

    // A few failures — deliberately BELOW the threshold.
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) {
      await withTenant(db, t1, (tdb) =>
        signIn(tdb, { userLookup: 'Owner One', password: 'not the password' }),
      );
    }

    const failures = async () =>
      (
        await withTenant(db, t1, (tdb) =>
          tdb.query<{ n: number }>(
            `select count(*)::int as n from login_attempts
              where identifier = 'OWNER ONE' and not succeeded`,
          ),
        )
      ).rows[0]!.n;

    assert.equal(await failures(), LOCKOUT_THRESHOLD - 1, 'the failures were recorded');

    const result = await withTenant(db, t1, (tdb) =>
      signIn(tdb, { userLookup: 'Owner One', password: PASSWORD }),
    );
    assert.equal(result.ok, true, 'the correct password must sign in');

    assert.equal(await failures(), 0, 'a success must clear the failure count for the identifier');
  });
});

test('the attempts of one tenant are invisible to another', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2, u1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );

    const count = async (tenant: string) =>
      (
        await withTenant(db, tenant, (tdb) =>
          tdb.query<{ n: number }>(
            `select count(*)::int as n from login_attempts where identifier = 'OWNER ONE'`,
          ),
        )
      ).rows[0]!.n;

    // Two failures against tenant one.
    for (let i = 0; i < 2; i += 1) {
      await withTenant(db, t1, (tdb) =>
        signIn(tdb, { userLookup: 'Owner One', password: 'not the password' }),
      );
    }

    assert.equal(await count(t1), 2, 'tenant one must see its own two attempts');
    assert.equal(await count(t2), 0, "another tenant must NOT see tenant one's attempts");
  });
});

test('an identifier is stored normalised', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();
  const hash = await hashPassword(PASSWORD);

  await withDb(async (db) => {
    // A RAW, non-normalised insert must be refused by the database itself —
    // both untrimmed and lowercase. Each attempt gets its OWN transaction,
    // because a CHECK violation aborts the enclosing one.
    for (const raw of ['  Ahmed ', 'ahmed', 'Ahmed']) {
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

    // The APP path stores it normalised: '  Owner One ' -> 'OWNER ONE'.
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set password_hash = $1 where id = $2', [hash, u1]),
    );
    await withTenant(db, t1, (tdb) =>
      signIn(tdb, { userLookup: '  Owner One ', password: 'not the password' }),
    );

    const { rows } = await withTenant(db, t1, (tdb) =>
      tdb.query<{ identifier: string }>(`select identifier from login_attempts`),
    );
    assert.ok(
      rows.some((r) => r.identifier === 'OWNER ONE'),
      "the identifier must be stored trim+upper ('  Owner One ' -> 'OWNER ONE')",
    );
  });
});
