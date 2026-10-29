import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from 'pg';

import { migrateUrl } from '../../harness/sql.ts';

/**
 * Convention guard for every RLS table.
 *
 * These tests reflect over the catalogue — over the OWNER connection, because
 * the owner sees every table and every policy — and assert the shape the tenancy
 * root established in 0002 and every later migration must copy:
 *
 *   (a) `relrowsecurity` is true        (RLS is enabled), and
 *   (b) `relforcerowsecurity` is true   FORCE, so the table's owner is bound too,
 *   (c) on every table `authenticated` can reach, at least one policy exists, and
 *   (d) every such policy carries BOTH a USING and a WITH CHECK expression.
 *
 * (c)+(d) are what keep isolation honest: a `<col> = nullif(current_setting(
 * 'app.tenant_id', true), '')::uuid` USING alone would let a caller insert a row
 * for another tenant. This is the test that must fail the moment a new table is
 * added without the pattern.
 */

type TableAcl = {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policies: number;
  policies_missing_using: number;
  policies_missing_check: number;
  authenticated_has_privilege: boolean;
};

async function reflect(): Promise<TableAcl[]> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const { rows } = await owner.query<TableAcl>(
      `select c.relname                                   as table_name,
              c.relrowsecurity                            as rls_enabled,
              c.relforcerowsecurity                       as rls_forced,
              (select count(*)::int from pg_policy p
                where p.polrelid = c.oid)                 as policies,
              (select count(*)::int from pg_policy p
                where p.polrelid = c.oid
                  and p.polqual is null)                  as policies_missing_using,
              (select count(*)::int from pg_policy p
                where p.polrelid = c.oid
                  and p.polwithcheck is null)             as policies_missing_check,
              exists (
                select 1
                  from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                 where a.grantee = 0
                    or a.grantee = (select oid from pg_roles where rolname = 'authenticated')
              )                                           as authenticated_has_privilege
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname <> 'schema_migrations'
        order by c.relname`,
    );
    return rows;
  } finally {
    await owner.end();
  }
}

test('every public base table enables and forces row level security', { skip: !migrateUrl() }, async () => {
  const rows = await reflect();
  assert.ok(rows.length > 0, 'expected at least one public base table — run `npm run db:reset` first');

  const offenders = rows
    .filter((r) => !r.rls_enabled || !r.rls_forced)
    .map((r) => `${r.table_name} (enabled=${r.rls_enabled}, forced=${r.rls_forced})`);

  assert.deepEqual(
    offenders,
    [],
    'these public tables must have both `enable row level security` and `force row level security`',
  );
});

test('every RLS table the app role can reach has a USING and a WITH CHECK policy', { skip: !migrateUrl() }, async () => {
  const rows = await reflect();

  const problems: string[] = [];
  for (const r of rows) {
    if (!r.authenticated_has_privilege) continue;
    if (r.policies < 1) problems.push(`${r.table_name}: no policy at all`);
    if (r.policies_missing_using > 0) {
      problems.push(`${r.table_name}: ${r.policies_missing_using} policy/policies without a USING expression`);
    }
    if (r.policies_missing_check > 0) {
      problems.push(`${r.table_name}: ${r.policies_missing_check} policy/policies without a WITH CHECK expression`);
    }
  }

  assert.deepEqual(problems, [], 'RLS convention violations');
});
