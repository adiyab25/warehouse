import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { hashToken } from '../../src/auth/token.ts';
import { issueClient } from '../../src/db/api-clients.ts';
import { withTenant } from '../../src/db/client.ts';
import { migrateUrl, sqlTestUrl, withDb } from '../harness/sql.ts';
import { cleanupTenants, provisionTenants } from '../harness/tenants.ts';

/**
 * Security regression tests for the ONE sanctioned escape hatch: the
 * `authenticate_api_token(text)` SECURITY DEFINER resolver (migration 0010).
 *
 * Two properties are load-bearing and neither is visible in a happy-path test:
 *
 *   (1) The resolver reads the REAL `public.api_clients`. A SECURITY DEFINER
 *       function with `search_path` pinned to a list that does NOT mention
 *       `pg_temp` still searches `pg_temp` FIRST for relation names (Postgres
 *       puts the session's temp schema at the front when it is not listed).
 *       A caller able to run SQL as `authenticated` can therefore
 *       `create temp table api_clients(...)`, seed it with a SECOND tenant's id
 *       and a `{write}` scope, and the unqualified lookup inside the resolver
 *       would read the temp row — handing the caller another tenant's identity.
 *       This is FULL tenant impersonation: `authenticateClient` opens a
 *       `withTenant` scope for whatever that function returned. The fix is
 *       BOTH to schema-qualify the table (`public.api_clients`) and to pin
 *       `search_path = public, pg_temp` so a shadow cannot win.
 *
 *   (2) The resolver only works because its OWNER bypasses row level security.
 *       FORCE RLS binds a table's owner, but NOT a superuser and NOT a role
 *       with BYPASSRLS. If a deployment applied the migrations as a role with
 *       neither, `authenticate_api_token` would silently return zero rows and
 *       ALL api authentication would fail closed-and-broken with no error. The
 *       guard below fails LOUDLY at test time instead.
 */

after(async () => {
  if (!sqlTestUrl()) return;
  await cleanupTenants();
});

test('the resolver reads public.api_clients, not a pg_temp shadow', { skip: !sqlTestUrl() }, async () => {
  const { t1, t2 } = await provisionTenants();

  await withDb(async (db) => {
    // A real key in tenant ONE.
    const issued = await withTenant(db, t1, (tdb) => issueClient(tdb, { name: 'Resolver Target' }));
    const tokenHash = hashToken(issued.token);

    // THE ATTACK. As the app role, shadow `api_clients` with a session-local
    // temp table seeded to a DIFFERENT tenant and a `write` scope, keyed on the
    // real token's hash. With an unqualified lookup and no `pg_temp` in the
    // pinned path, the resolver reads THIS row.
    const forgedClientId = randomUUID();
    await db.query(
      `create temp table api_clients (
         id uuid, tenant_id uuid, scopes text[], token_hash text, active boolean
       )`,
    );
    await db.query(
      `insert into api_clients (id, tenant_id, scopes, token_hash, active)
       values ($1, $2, $3, $4, true)`,
      [forgedClientId, t2, ['write'], tokenHash],
    );

    // The resolver must return the REAL row: tenant ONE, scope read.
    const { rows } = await db.query<{ client_id: string; tenant_id: string; scopes: string[] }>(
      'select client_id, tenant_id, scopes from authenticate_api_token($1)',
      [tokenHash],
    );

    assert.equal(rows.length, 1, 'the real key resolves to exactly one row');
    assert.equal(
      rows[0]!.tenant_id,
      t1,
      'the resolver must read public.api_clients — a pg_temp shadow must never be able to forge a tenant',
    );
    assert.notEqual(rows[0]!.tenant_id, t2, 'the forged tenant must never come back');
    assert.deepEqual(
      rows[0]!.scopes,
      ['read'],
      'the REAL scopes come back, not the forged {write}',
    );
    assert.equal(rows[0]!.client_id, issued.id, 'the real client id comes back, not the forged one');
  });
});

type DefinerOwner = {
  proname: string;
  owner: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
};

/** Reflects the owner of every SECURITY DEFINER function in `public`. */
async function reflectDefinerOwners(): Promise<DefinerOwner[]> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const { rows } = await owner.query<DefinerOwner>(
      `select p.proname,
              r.rolname        as owner,
              r.rolsuper       as rolsuper,
              r.rolbypassrls   as rolbypassrls
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_roles r on r.oid = p.proowner
        where n.nspname = 'public'
          and p.prosecdef
        order by p.proname`,
    );
    return rows;
  } finally {
    await owner.end();
  }
}

test('every SECURITY DEFINER function is owned by a role that bypasses RLS', { skip: !migrateUrl() }, async () => {
  const rows = await reflectDefinerOwners();

  assert.ok(
    rows.some((r) => r.proname === 'authenticate_api_token'),
    'the resolver authenticate_api_token must exist as a SECURITY DEFINER function',
  );

  const offenders = rows
    .filter((r) => !(r.rolsuper || r.rolbypassrls))
    .map((r) => `${r.proname} (owner=${r.owner})`);

  assert.deepEqual(
    offenders,
    [],
    'a SECURITY DEFINER function owned by a role with neither rolsuper nor rolbypassrls ' +
      'cannot see past the FORCE-RLS policy it exists to bypass — it would silently return ' +
      'zero rows and break authentication with no error. Apply the migrations as a role that ' +
      'is rolsuper or rolbypassrls.',
  );
});
