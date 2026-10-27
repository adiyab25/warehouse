import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from 'pg';

import { migrateUrl } from '../harness/sql.ts';

/**
 * PRIVILEGE GUARD for every relation the app role can reach.
 *
 * The RLS convention guard (rls-conventions.test.ts) proves a table's tenancy
 * shape, but it cannot see the column grants — and the two privileges that
 * broke Task 5 are exactly the ones RLS does NOT govern:
 *
 *   * TRUNCATE is not subject to row level security, and the append-only guard
 *     is a BEFORE UPDATE OR DELETE row trigger a TRUNCATE never fires. One
 *     `truncate public.stock_movements` as `authenticated` therefore empties
 *     EVERY tenant's ledger at once — no policy, no trigger, no error.
 *   * REFERENCES / TRIGGER let the app role bolt foreign keys and triggers
 *     onto the ledger.
 *
 * All three arrive by accident: `alter default privileges in schema public
 * grant all on tables` hands them to every future table, so the fix is to grant
 * only SELECT/INSERT/UPDATE/DELETE by default and revoke the three wherever
 * they exist. This test is what keeps the NEXT table safe: add a table to the
 * schema and it is checked here automatically, over the whole of `public`.
 *
 * Reflected over the OWNER connection, because the owner sees every relation
 * and `has_table_privilege` answers for the `authenticated` role regardless of
 * who asks.
 */

type RelationPrivileges = {
  relation_name: string;
  relkind: string;
  can_truncate: boolean;
  can_reference: boolean;
  can_trigger: boolean;
};

async function reflect(): Promise<RelationPrivileges[]> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const { rows } = await owner.query<RelationPrivileges>(
      `select c.relname                                             as relation_name,
              c.relkind                                             as relkind,
              has_table_privilege('authenticated', c.oid, 'TRUNCATE')   as can_truncate,
              has_table_privilege('authenticated', c.oid, 'REFERENCES') as can_reference,
              has_table_privilege('authenticated', c.oid, 'TRIGGER')    as can_trigger
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p', 'v', 'm')
        order by c.relname`,
    );
    return rows;
  } finally {
    await owner.end();
  }
}

test('the app role holds no TRUNCATE, REFERENCES or TRIGGER on any public relation', { skip: !migrateUrl() }, async () => {
  const rows = await reflect();
  assert.ok(
    rows.length > 0,
    'expected at least one public relation — run `npm run db:reset` first',
  );

  const offenders = rows
    .map((r) => {
      const bad = [
        r.can_truncate ? 'TRUNCATE' : null,
        r.can_reference ? 'REFERENCES' : null,
        r.can_trigger ? 'TRIGGER' : null,
      ].filter((x): x is string => x !== null);
      return bad.length > 0 ? `${r.relation_name} (${r.relkind}): ${bad.join(', ')}` : null;
    })
    .filter((x): x is string => x !== null);

  assert.deepEqual(
    offenders,
    [],
    'these relations grant the app role a privilege RLS cannot govern ' +
      '(TRUNCATE empties the append-only ledger for every tenant at once)',
  );
});
