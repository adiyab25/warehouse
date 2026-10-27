import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root (…/warehouse), derived from this file's location. */
export const REPO_ROOT = resolve(here, '..', '..');

let cached: string | null = null;

/**
 * The connection string every database-backed test must use.
 *
 * It must be the NON-superuser role (`authenticated`): a superuser bypasses
 * row-level security, so a tenancy test run as `postgres` proves nothing.
 * The URL is read from `SQL_TEST_DATABASE_URL`, falling back to a local `.env`
 * so `npm test` works without exporting anything by hand. Returns `undefined`
 * when unset, which is what gates the database tests on and off.
 */
export function sqlTestUrl(): string | undefined {
  if (cached !== null) return cached || undefined;

  let url = process.env.SQL_TEST_DATABASE_URL?.trim() || '';
  if (!url) {
    try {
      const text = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
      const match = text.match(/^\s*SQL_TEST_DATABASE_URL\s*=\s*(.*)$/m);
      if (match) url = match[1].trim().replace(/^["']|["']$/g, '');
    } catch {
      // No .env file — the tests stay skipped.
    }
  }

  cached = url;
  return cached || undefined;
}

/** Anything that can run a parameterised query — a Pool, a Client or a stub. */
export type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
};

/**
 * Opens one connection to the test database, hands it to `fn`, and always
 * closes it. Tests own their own transaction if they need one.
 */
export async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const url = sqlTestUrl();
  if (!url) throw new Error('SQL_TEST_DATABASE_URL is not set — cannot open a test database');

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
