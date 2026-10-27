import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root (…/warehouse), derived from this file's location. */
export const REPO_ROOT = resolve(here, '..', '..');

const cache = new Map<string, string>();

/**
 * Reads a URL from the environment, falling back to a single-line assignment
 * of the same name in a local `.env` so `npm test` works without exporting
 * anything by hand. Returns `undefined` when absent.
 */
function readUrl(envVar: string): string | undefined {
  const hit = cache.get(envVar);
  if (hit !== undefined) return hit || undefined;

  let url = process.env[envVar]?.trim() || '';
  if (!url) {
    try {
      const text = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
      const match = text.match(new RegExp(`^\\s*${envVar}\\s*=\\s*(.*)$`, 'm'));
      if (match) url = match[1].trim().replace(/^["']|["']$/g, '');
    } catch {
      // No .env file — the caller sees `undefined` and decides to skip.
    }
  }

  cache.set(envVar, url);
  return url || undefined;
}

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
  return readUrl('SQL_TEST_DATABASE_URL');
}

/**
 * The connection the MIGRATION RUNNER must use: the database OWNER.
 *
 * Deliberately a different role from {@link sqlTestUrl}. Postgres makes whoever
 * created a table its owner, and a table's owner bypasses that table's own RLS
 * policies. If the runner were pointed at `SQL_TEST_DATABASE_URL`
 * (`authenticated`), every table it created would be owned by `authenticated`
 * and every future tenancy/RLS test would pass trivially instead of proving
 * anything.
 *
 * Read from `MIGRATE_DATABASE_URL`, falling back to `DATABASE_URL` (the name
 * `scripts/migrate.mjs` reads), then to a local `.env`. Returns `undefined`
 * when neither is set, which is what skips the migration tests.
 */
export function migrateUrl(): string | undefined {
  return readUrl('MIGRATE_DATABASE_URL') ?? readUrl('DATABASE_URL');
}

/** Anything that can run a parameterised query — a Pool, a Client or a stub. */
export type Queryable = {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
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
