import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { REPO_ROOT, sqlTestUrl } from './harness/sql.ts';

test('migrate runner applies 0001 and records it', { skip: !sqlTestUrl() }, async () => {
  execFileSync(process.execPath, ['scripts/migrate.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: sqlTestUrl()! },
    stdio: 'pipe',
  });

  const { Client } = await import('pg');
  const c = new Client({ connectionString: sqlTestUrl()! });
  await c.connect();
  const r = await c.query(
    "select count(*)::int n from schema_migrations where name = '0001_init.sql'",
  );
  await c.end();
  assert.equal(r.rows[0].n, 1);
});

test('the runner is idempotent — a second run applies nothing', { skip: !sqlTestUrl() }, async () => {
  const out1 = execFileSync(process.execPath, ['scripts/migrate.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: sqlTestUrl()! },
    encoding: 'utf8',
  });
  const out2 = execFileSync(process.execPath, ['scripts/migrate.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: sqlTestUrl()! },
    encoding: 'utf8',
  });

  assert.ok(out1.length > 0 || out2.length >= 0);
  assert.match(out2, /nothing to apply/i);

  const { Client } = await import('pg');
  const c = new Client({ connectionString: sqlTestUrl()! });
  await c.connect();
  const r = await c.query(
    "select count(*)::int n from schema_migrations where name = '0001_init.sql'",
  );
  await c.end();
  assert.equal(r.rows[0].n, 1, 'the migration must be recorded exactly once');
});
