import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { migrateUrl } from '../../harness/sql.ts';

// Reasons that currently have no writer. This list must shrink to empty by end
// of P1 — each entry removed only when a writer lands in src/modules/**/server.
const ALLOWED_GAPS = new Set(['transfer', 'consumption', 'sale']);

function collectServerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectServerFiles(full));
    else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx') || full.endsWith('.sql'))) out.push(full);
  }
  return out;
}

test('every movement reason has at least one writer in src/modules/**/server', { skip: !migrateUrl() }, async () => {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  let allowed: string[] = [];
  try {
    const res = await owner.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'stock_movements'
          and c.conname = 'stock_movements_reason_check'`,
    );
    assert.equal(res.rows.length, 1, 'stock_movements_reason_check must exist');
    const def = res.rows[0].def;
    const m = def.match(/ARRAY\[(.*)\]/i);
    assert.ok(m, 'could not parse reason list from constraint');
    allowed = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  } finally {
    await owner.end();
  }

  const root = join(process.cwd(), 'src', 'modules');
  const files: string[] = [];
  for (const mod of readdirSync(root, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const serverDir = join(root, mod.name, 'server');
    try { files.push(...collectServerFiles(serverDir)); } catch { /* no server dir */ }
  }

  const writers = new Set<string>();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/reason\s*:\s*'([a-z_]+)'/g)) writers.add(m[1]);
  }

  const missing = allowed.filter((r) => !writers.has(r));
  for (const r of missing) {
    assert.ok(ALLOWED_GAPS.has(r), `reason '${r}' has no writer and is not in the allow-list`);
  }
  // The allow-list must only contain reasons that are actually missing.
  for (const r of ALLOWED_GAPS) {
    assert.ok(allowed.includes(r), `allow-list entry '${r}' is not a valid reason`);
    assert.ok(missing.includes(r), `allow-list entry '${r}' already has a writer — remove it`);
  }
});
