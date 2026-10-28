import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { createSession, readSession } from '../../src/auth/session.ts';
import { authenticateClient, issueClient } from '../../src/db/api-clients.ts';
import { withTenant } from '../../src/db/client.ts';
import { migrateUrl, sqlTestUrl, withDb } from '../harness/sql.ts';

/**
 * Contract tests for LOGINS, ROLES and API KEYS.
 *
 * The properties that matter are:
 *
 *   - a token is stored ONLY as a hash — the raw value appears in NO column, so
 *     a database read cannot resurrect a live credential;
 *   - a revoked (`active = false`) key cannot authenticate;
 *   - scopes round-trip, and default to the least privilege (`read`);
 *   - `authenticateClient` resolves the TENANT with no tenant set — the whole
 *     point of the `authenticate_api_token` SECURITY DEFINER function, since a
 *     tenant-scoped read would hide the very row needed to find the tenant;
 *   - one tenant's client is invisible to another (RLS on the table itself);
 *   - a session token round-trips, and an expired or revoked one resolves to
 *     null rather than an error;
 *   - a successful authentication actually WRITES `last_used_at`.
 *
 * Tenants are provisioned over the OWNER connection (`migrateUrl()`); everything
 * the app does runs as the non-superuser `authenticated` role.
 */

type Provisioned = { t1: string; t2: string; u1: string; u2: string };

const provisionedTenants: string[] = [];

/** Creates two tenants, each with one `owner` app_user, over the OWNER connection. */
async function provision(): Promise<Provisioned> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const {
      rows: [t1],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Auth One') returning id");
    const {
      rows: [t2],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Auth Two') returning id");

    const userIds: Record<string, string> = {};
    for (const [id, name, username] of [
      [t1!.id, 'Owner One', 'owner_one'],
      [t2!.id, 'Owner Two', 'owner_two'],
    ] as const) {
      const {
        rows: [u],
      } = await owner.query<{ id: string }>(
        "insert into app_users (tenant_id, name, name_normalised, username, role, password_hash) values ($1, $2, public.normalise_name($2), $3, 'owner', 'x') returning id",
        [id, name, username],
      );
      userIds[id] = u!.id;
    }

    provisionedTenants.push(t1!.id, t2!.id);
    return { t1: t1!.id, t2: t2!.id, u1: userIds[t1!.id]!, u2: userIds[t2!.id]! };
  } finally {
    await owner.end();
  }
}

// Cleanup over the OWNER connection. Child rows first: sessions and api_clients
// both hang off tenants (and, for sessions, app_users).
after(async () => {
  if (provisionedTenants.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('delete from sessions where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from api_clients where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from app_users where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from tenants where id = any($1)', [provisionedTenants]);
  } finally {
    await owner.end();
  }
});

test('a client token is stored only as a hash', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const issued = await withTenant(db, t1, (tdb) => issueClient(tdb, { name: 'Billing System' }));

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<Record<string, unknown>>('select * from api_clients');
      assert.equal(rows.length, 1, 'exactly one client was issued');

      // THE ASSERTION THAT MATTERS: the raw token appears in NO column. Serialise
      // the whole row and prove the token is not a substring of any of it.
      const serialised = JSON.stringify(rows[0]);
      assert.equal(
        serialised.includes(issued.token),
        false,
        'the raw token must not appear in ANY column of api_clients',
      );

      // ...and it cannot be looked up by the raw token.
      const { rows: byRaw } = await tdb.query(
        'select 1 from api_clients where token_hash = $1',
        [issued.token],
      );
      assert.equal(byRaw.length, 0, 'the raw token must not be the stored value');

      // The stored value is the sha256 of the token: 64 hex chars.
      const stored = rows[0]!.token_hash as string;
      assert.match(stored, /^[0-9a-f]{64}$/, 'the token_hash is a sha256 hex digest');
      assert.notEqual(stored, issued.token, 'the hash is not the token');
    });
  });
});

test('a revoked client cannot authenticate', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const issued = await withTenant(db, t1, (tdb) => issueClient(tdb, { name: 'Revoked Key' }));

    // It authenticates while active...
    const before = await authenticateClient(db, issued.token);
    assert.equal(before?.tenantId, t1, 'an active key authenticates');

    // ...and stops once revoked.
    await withTenant(db, t1, async (tdb) => {
      await tdb.query('update api_clients set active = false where id = $1', [issued.id]);
    });

    const after = await authenticateClient(db, issued.token);
    assert.equal(after, null, 'a revoked key must not authenticate');
  });
});

test('scopes round-trip and default to read', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const defaulted = await withTenant(db, t1, (tdb) => issueClient(tdb, { name: 'Least Privilege' }));
    const withWrite = await withTenant(db, t1, (tdb) =>
      issueClient(tdb, { name: 'Full Access', scopes: ['read', 'write'] }),
    );

    const a = await authenticateClient(db, defaulted.token);
    assert.deepEqual(a?.scopes, ['read'], 'an omitted scope list defaults to the least privilege, read');

    const b = await authenticateClient(db, withWrite.token);
    assert.deepEqual(b?.scopes, ['read', 'write'], 'the scope list round-trips');
  });
});

test('authenticateClient resolves the tenant without one being set', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const issued = await withTenant(db, t1, (tdb) => issueClient(tdb, { name: 'Resolver Probe' }));

    // Positive control for the SECURITY DEFINER function: a PLAIN read of the
    // table with NO tenant pinned sees nothing — the row is hidden by RLS. If
    // resolution worked by an ordinary scoped read, it would find nothing.
    const { rows: direct } = await db.query<{ n: number }>(
      'select count(*)::int as n from api_clients',
    );
    assert.equal(direct[0]!.n, 0, 'a plain tenant-scoped read cannot see a client with no tenant pinned');

    // ...yet the token resolves, because authenticate_api_token runs SECURITY
    // DEFINER and returns just enough to bootstrap.
    const resolved = await authenticateClient(db, issued.token);
    assert.equal(resolved?.id, issued.id, 'the key resolves to its client');
    assert.equal(resolved?.tenantId, t1, 'and reveals the tenant it belongs to — the whole point');

    // Resolving the tenant let the rest of the work be ordinary and scoped: the
    // last_used_at write actually landed.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ last_used_at: Date | null }>(
        'select last_used_at from api_clients where id = $1',
        [issued.id],
      );
      assert.notEqual(rows[0]!.last_used_at, null, 'last_used_at is WRITTEN on a successful authentication');
    });
  });
});

test('a client of one tenant cannot authenticate into another', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provision();

  await withDb(async (db) => {
    const a = await withTenant(db, t1, (tdb) => issueClient(tdb, { name: 'Tenant One Key' }));
    const b = await withTenant(db, t2, (tdb) => issueClient(tdb, { name: 'Tenant Two Key' }));

    // Each key resolves to its OWN tenant, never the other's.
    const ra = await authenticateClient(db, a.token);
    const rb = await authenticateClient(db, b.token);
    assert.equal(ra?.tenantId, t1, 'tenant one\'s key resolves to tenant one');
    assert.equal(rb?.tenantId, t2, 'tenant two\'s key resolves to tenant two');
    assert.notEqual(ra?.id, rb?.id, 'the two keys are different clients');

    // The table itself is isolated: within one tenant's scope, only that
    // tenant's client is visible.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ name: string }>('select name from api_clients');
      assert.deepEqual(rows.map((r) => r.name), ['Tenant One Key'], 'tenant one sees only its own key');
    });
    await withTenant(db, t2, async (tdb) => {
      const { rows } = await tdb.query<{ name: string }>('select name from api_clients');
      assert.deepEqual(rows.map((r) => r.name), ['Tenant Two Key'], 'tenant two sees only its own key');
    });
  });
});

test('a session token round-trips and an expired or revoked one does not', { skip: !sqlTestUrl() }, async () => {
  const { t1, u1 } = await provision();

  await withDb(async (db) => {
    // A live session.
    const { token } = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));

    await withTenant(db, t1, async (tdb) => {
      // The raw token is stored only as a hash.
      const { rows } = await tdb.query<{ token_hash: string }>('select token_hash from sessions');
      assert.equal(rows.length, 1, 'exactly one session was opened');
      assert.notEqual(rows[0]!.token_hash, token, 'the session token is stored only as a hash');

      const session = await readSession(tdb, token);
      assert.equal(session?.userId, u1, 'the session resolves to its user');
      assert.equal(session?.tenantId, t1, 'and to its tenant');
      assert.equal(session?.role, 'owner', 'and carries the user\'s role');
    });

    // An unknown token resolves to null, not an error.
    const unknown = await withTenant(db, t1, (tdb) => readSession(tdb, 'not-a-real-token'));
    assert.equal(unknown, null, 'an unknown token is a miss');

    // An EXPIRED session resolves to null.
    const expired = await withTenant(db, t1, (tdb) =>
      createSession(tdb, { userId: u1, ttlMs: -1000 }),
    );
    const expiredSession = await withTenant(db, t1, (tdb) => readSession(tdb, expired.token));
    assert.equal(expiredSession, null, 'an expired session must not resolve');

    // A REVOKED session resolves to null.
    const revocable = await withTenant(db, t1, (tdb) => createSession(tdb, { userId: u1 }));
    await withTenant(db, t1, async (tdb) => {
      await tdb.query('update sessions set revoked_at = now() where token_hash is not null');
    });
    const revokedSession = await withTenant(db, t1, (tdb) => readSession(tdb, revocable.token));
    assert.equal(revokedSession, null, 'a revoked session must not resolve');
  });
});
