import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createSession, readSession } from '../../src/auth/session.ts';
import { issueClient } from '../../src/db/api-clients.ts';
import { withTenant } from '../../src/db/client.ts';
import { sqlTestUrl, withDb } from '../harness/sql.ts';
import { cleanupTenants, provisionTenants } from '../harness/tenants.ts';

/**
 * Guards a session (a signed-in PERSON) must hold, beyond the happy path:
 *
 *   (1) DEACTIVATION IS ENFORCED AT READ TIME. `readSession` requires the
 *       joined user to be `active`, so offboarding — `active = false` — ends
 *       every live session for that person immediately, without hunting down
 *       and revoking individual tokens. Task 11's offboarding leans on this.
 *
 *   (2) `token_hash` is CONSTRAINED on both credential tables. Every other
 *       stored identifier in this schema (codes, skus, refs, names) is
 *       normalised and CHECKed, and a token hash is the most security-relevant
 *       value in the database; an unbounded `text` would accept a raw token, a
 *       truncated digest or a typo. It must be exactly a sha256 hex digest.
 */

after(async () => {
  if (!sqlTestUrl()) return;
  await cleanupTenants();
});

test('a deactivated user ends every live session, and reactivating restores it', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (db) => {
    const { token } = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));

    // Live while the user is active.
    const live = await withTenant(db, t1, (tdb) => readSession(tdb, token));
    assert.equal(live?.userId, u1, 'an active user has a live session');

    // Offboard: deactivate the user. The SESSION row is untouched — only the
    // user's flag changes — and the token must stop resolving.
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set active = false where id = $1', [u1]),
    );
    const afterDeactivation = await withTenant(db, t1, (tdb) => readSession(tdb, token));
    assert.equal(
      afterDeactivation,
      null,
      'a deactivated user must not resolve a live session (offboarding)',
    );

    // Re-activate: the untouched session resolves again.
    await withTenant(db, t1, (tdb) =>
      tdb.query('update app_users set active = true where id = $1', [u1]),
    );
    const afterReactivation = await withTenant(db, t1, (tdb) => readSession(tdb, token));
    assert.equal(afterReactivation?.userId, u1, 'reactivating the user restores the session');
  });
});

test('token_hash is constrained to a sha256 hex digest on both credential tables', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provisionTenants();

  await withDb(async (db) => {
    // A valid key still inserts (the app path is unchanged)...
    const issued = await withTenant(db, t1, (tdb) => issueClient(tdb, { name: 'Well Formed' }));
    assert.match(issued.token, /\S/, 'a key was issued');

    // ...but a raw token, a truncated digest or a non-hex value is refused.
    // Each attempt gets its OWN transaction: a CHECK violation aborts the
    // enclosing transaction, so a second insert in the same `withTenant` would
    // fail with "transaction is aborted" rather than its own constraint error.
    for (const bad of [issued.token, 'deadbeef', 'z'.repeat(64), 'A'.repeat(64)]) {
      await assert.rejects(
        () =>
          withTenant(db, t1, (tdb) =>
            tdb.query(
              `insert into api_clients (tenant_id, name, token_hash)
               values (nullif(current_setting('app.tenant_id', true), '')::uuid, 'Bad Hash', $1)`,
              [bad],
            ),
          ),
        (err: { code?: string }) => err.code === '23514',
        `api_clients.token_hash must reject ${JSON.stringify(bad)} with a CHECK violation`,
      );

      await assert.rejects(
        () =>
          withTenant(db, t1, (tdb) =>
            tdb.query(
              `insert into sessions (tenant_id, user_id, token_hash, expires_at)
               values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, now() + interval '1 hour')`,
              [u1, bad],
            ),
          ),
        (err: { code?: string }) => err.code === '23514',
        `sessions.token_hash must reject ${JSON.stringify(bad)} with a CHECK violation`,
      );
    }
  });
});
