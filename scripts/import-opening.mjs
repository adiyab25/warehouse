#!/usr/bin/env node
/**
 * Opening-balance importer (Task 19). Thin CLI over src/import/opening.ts.
 *
 *   npm run import:opening -- --tenant <uuid> --user <username> --file <path.csv> [--apply]
 *
 * DRY RUN is the default: the same code runs inside a transaction that is rolled
 * back. `--apply` commits. Any error fails the WHOLE file (exit 1, nothing saved).
 * Connects as the NON-owner app role from APP_DATABASE_URL and refuses a
 * superuser / BYPASSRLS role. There is no TENANT_ID fallback on purpose.
 * Exit codes: 0 clean (dry run or saved), 1 import failed, 2 bad command line.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { appDatabaseUrl } from '../src/db/app-pool.ts';
import { newPool } from '../src/db/client.ts';
import { MAX_BYTES, formatSummary, runOpeningImport } from '../src/import/opening.ts';

const USAGE =
  'usage: npm run import:opening -- --tenant <uuid> --user <username> --file <path.csv> [--apply]\n' +
  '  (without --apply nothing is saved: it is a dry run)';

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    let [k, v] = argv[i].split(/=(.*)/s, 2);
    const take = () => (v !== undefined ? v : argv[++i]);
    if (k === '--apply') out.apply = true;
    else if (k === '--dry-run') out.dry = true;
    else if (k === '--tenant') out.tenant = take();
    else if (k === '--user') out.user = take();
    else if (k === '--file') out.file = take();
    else if (k === '--help' || k === '-h') out.help = true;
    else throw new Error(`unknown option ${k}`);
  }
  return out;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.apply && args.dry) {
  console.error(`--apply and --dry-run contradict each other\n${USAGE}`);
  process.exit(2);
}
for (const [name, val] of [['--tenant', args.tenant], ['--user', args.user], ['--file', args.file]]) {
  if (!val) {
    console.error(`${name} is required\n${USAGE}`);
    process.exit(2);
  }
}

let pool;
let code = 1;
try {
  pool = newPool(appDatabaseUrl());
  const result = await runOpeningImport(pool, {
    tenantId: args.tenant,
    username: args.user,
    fileName: basename(args.file),
    apply: args.apply,
    readInput: () => {
      if (statSync(args.file).size > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES / 1024 / 1024} MB`);
      return readFileSync(args.file);
    },
  });
  console.log(formatSummary(result, args.apply));
  code = result.ok ? 0 : 1;
} catch (err) {
  // Message only: never print the connection string.
  console.error(`import refused: ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
} finally {
  await pool?.end().catch(() => {});
}
process.exit(code);
