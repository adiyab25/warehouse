#!/usr/bin/env node
// Catalog-driven TypeScript type generator.
//
//   DATABASE_URL=postgresql://… node scripts/gen-types.mjs
//
// Writes src/db/types.ts by reading the LIVE catalogue — information_schema
// .columns plus pg_constraint — rather than guessing. It exists because
// `supabase gen types` needs a local Docker stack, which this machine does not
// have. The output is committed and reviewed by hand; re-run it after any
// migration that changes a table.
//
// It connects as the OWNER (DATABASE_URL / MIGRATE_DATABASE_URL): reading the
// catalogue does not touch row data, and the owner can see every table.
//
// The output is deterministic — tables and columns are ordered, and no
// timestamp is embedded — so a no-op run produces no diff.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outFile = join(repoRoot, 'src', 'db', 'types.ts');

// Bookkeeping tables are infrastructure, not domain rows — keep them out of the
// generated API surface.
const EXCLUDED = new Set(['schema_migrations']);

const connectionString =
  process.env.MIGRATE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  process.env.SQL_TEST_DATABASE_URL;

if (!connectionString) {
  console.error('gen-types: set MIGRATE_DATABASE_URL or DATABASE_URL');
  process.exit(1);
}

/** information_schema/udt_name → TypeScript type. */
function tsType(udtName) {
  switch (udtName) {
    case 'uuid':
    case 'text':
    case 'varchar':
    case 'bpchar':
    case 'name':
      return 'string';
    case 'bool':
      return 'boolean';
    case 'int2':
    case 'int4':
    case 'float4':
    case 'float8':
      return 'number';
    // int8 and numeric come back from node-postgres as strings, deliberately:
    // a JS number cannot hold every value they allow.
    case 'int8':
    case 'numeric':
    case 'money':
      return 'string';
    case 'timestamptz':
    case 'timestamp':
    case 'date':
      return 'Date';
    case 'json':
    case 'jsonb':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** `app_users` → `AppUser`; `tenants` → `Tenant`. */
function interfaceName(table) {
  const parts = table.split('_');
  const last = parts.pop();
  const singular = /ss$/.test(last) ? last : last.replace(/s$/, '');
  return [...parts, singular].map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

/**
 * Pulls the allowed values out of a Postgres `CHECK ((col = ANY (ARRAY['a'::text,
 * …])))` definition — how an `IN (…)` column check is stored. Returns null when
 * the constraint is not of that simple, single-column shape.
 */
function checkEnumValues(columns, definition) {
  const m = definition.match(
    /^CHECK \(\((\w+) = ANY \(ARRAY\[(.*?)\]\)\)\)$/s,
  );
  if (!m || m[1] !== columns) return null;
  return [...m[2].matchAll(/'([^']*)'::text/g)].map((x) => x[1]);
}

const client = new pg.Client({ connectionString, application_name: 'warehouse-gen-types' });
await client.connect();

try {
  const { rows: tables } = await client.query(
    `select table_name
       from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`,
  );
  const tableNames = tables.map((t) => t.table_name).filter((t) => !EXCLUDED.has(t));
  if (tableNames.length === 0) {
    console.error('gen-types: no public tables found — run `npm run db:migrate` first');
    process.exit(1);
  }

  const { rows: columns } = await client.query(
    `select table_name, column_name, udt_name, is_nullable, column_default, ordinal_position
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1)
      order by table_name, ordinal_position`,
    [tableNames],
  );

  const { rows: constraints } = await client.query(
    `select c.relname as table_name,
            con.conname as name,
            con.contype as kind,
            pg_get_constraintdef(con.oid) as definition,
            (select string_agg(a.attname, ',' order by k.ord)
               from unnest(con.conkey) with ordinality as k(attnum, ord)
               join pg_attribute a
                 on a.attrelid = con.conrelid and a.attnum = k.attnum) as columns
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1)
      order by c.relname, con.conname`,
    [tableNames],
  );

  // column → union of allowed values, derived from single-column CHECK … IN.
  const enums = new Map(); // `${table}.${column}` -> string[]
  const foreignKeys = [];
  for (const c of constraints) {
    if (c.kind === 'c') {
      const values = checkEnumValues(c.columns, c.definition);
      if (values) enums.set(`${c.table_name}.${c.columns}`, values);
    } else if (c.kind === 'f') {
      foreignKeys.push({ table: c.table_name, columns: c.columns, definition: c.definition });
    }
  }

  const blocks = [];
  for (const table of tableNames) {
    const cols = columns.filter((c) => c.table_name === table);
    const lines = cols.map((c) => {
      const enumValues = enums.get(`${table}.${c.column_name}`);
      const type = enumValues
        ? enumValues.map((v) => `'${v}'`).join(' | ')
        : tsType(c.udt_name);
      const nullable = c.is_nullable === 'YES';
      return `  ${c.column_name}: ${type}${nullable ? ' | null' : ''};`;
    });
    blocks.push(`export interface ${interfaceName(table)} {\n${lines.join('\n')}\n}`);
  }

  const databaseEntries = tableNames
    .map((t) => `  ${t}: ${interfaceName(t)};`)
    .join('\n');

  const fkLines =
    foreignKeys.length === 0
      ? '[]'
      : `[\n${foreignKeys
          .map((fk) => `  { table: '${fk.table}', columns: '${fk.columns}', definition: ${JSON.stringify(fk.definition)} },`)
          .join('\n')}\n]`;

  const output = `// AUTO-GENERATED by scripts/gen-types.mjs — do not edit by hand.
// Regenerate with \`npm run db:types\` after any migration that changes a table.
// The generator reads the live catalogue (information_schema.columns +
// pg_constraint), so these types cannot drift from the database silently.
//
// Nullability mirrors the schema exactly (\`| null\` for every nullable column,
// nothing for a \`not null\` column). \`numeric\` and \`bigint\` are typed as
// \`string\` because node-postgres returns them as strings.

${blocks.join('\n\n')}

/** Maps a table name to its row shape. */
export interface Database {
${databaseEntries}
}

/** Any table in the public schema that carries a generated row type. */
export type TableName = keyof Database;

/** Every generated table name, in catalogue order. */
export const tableNames = [${tableNames.map((t) => `'${t}'`).join(', ')}] as const;

/** Foreign keys discovered in the catalogue. */
export const foreignKeys = ${fkLines} as const;
`;

  writeFileSync(outFile, output);
  console.log(`gen-types: wrote ${tableNames.length} table(s) to src/db/types.ts`);
} finally {
  await client.end().catch(() => {});
}
