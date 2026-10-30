#!/usr/bin/env node
// Catalog-driven TypeScript type generator.
//
//   MIGRATE_DATABASE_URL=postgresql://… node scripts/gen-types.mjs
//
// Writes src/db/types.ts by reading the LIVE catalogue — information_schema
// .columns plus pg_constraint and pg_enum — rather than guessing. It exists
// because `supabase gen types` needs a local Docker stack, which this machine
// does not have. The output is committed and reviewed by hand; re-run it after
// any migration that changes a table.
//
// It connects as the OWNER (MIGRATE_DATABASE_URL / DATABASE_URL): reading the
// catalogue does not touch row data, and only the owner can see every table.
// The non-owner test role is deliberately NOT accepted as a fallback — a
// connection that cannot see every table would silently under-generate types.
//
// The output is deterministic — tables and columns are ordered, and no
// timestamp is embedded — so a no-op run produces no diff.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outFile = join(repoRoot, 'src', 'modules', 'platform', 'server', 'types.ts');

// Bookkeeping tables are infrastructure, not domain rows — keep them out of the
// generated API surface.
const EXCLUDED = new Set(['schema_migrations']);

const connectionString =
  process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    'gen-types: set MIGRATE_DATABASE_URL (or DATABASE_URL) to the database OWNER url — ' +
      'the catalogue reader must see every table, so the non-owner app role is not accepted',
  );
  process.exit(1);
}

/** A single udt_name → TypeScript type, ignoring array/enum wrapping. */
function baseTsType(udtName, enumsByType) {
  // A real Postgres enum (pg_enum) becomes a string union — without this it
  // would fall through to `unknown` and silently lose its type.
  const labels = enumsByType.get(udtName);
  if (labels) return labels.map((v) => `'${v}'`).join(' | ');

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

/**
 * `information_schema`/`udt_name` → TypeScript type, including the `_xxx`
 * array form Postgres uses for array columns (`_text` → `string[]`,
 * `_uuid` → `string[]`, `_mood` → `('a' | 'b')[]`).
 */
function tsType(udtName, enumsByType) {
  if (udtName.startsWith('_')) {
    const element = baseTsType(udtName.slice(1), enumsByType);
    return element.includes(' | ') ? `(${element})[]` : `${element}[]`;
  }
  return baseTsType(udtName, enumsByType);
}

/** `statuses` → `status`, `batch_boxes` → `batch_box`, `addresses` → `address`. */
function singularize(word) {
  if (/ss$/.test(word)) return word; // address, class, progress
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`; // entries → entry
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2); // statuses → status, boxes → box
  if (/s$/.test(word)) return word.slice(0, -1); // tenants → tenant
  return word;
}

/** `app_users` → `AppUser`; `tenants` → `Tenant`; `batch_boxes` → `BatchBox`. */
function interfaceName(table) {
  const parts = table.split('_');
  const last = parts.pop();
  const singular = singularize(last);
  return [...parts, singular].map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

/**
 * Pulls the allowed values out of a Postgres `CHECK … IN (…)` definition.
 *
 * Postgres does not store `IN` — it renders a `= ANY (ARRAY[…])`. A `text`
 * column renders as `CHECK ((k = ANY (ARRAY['x'::text, 'y'::text])))`, but the
 * identical `varchar` column renders differently, with an explicit cast:
 * `CHECK (((k)::text = ANY ((ARRAY['x'::character varying, 'y'::character
 * varying])::text[])))`. Both shapes are recognised here; anything else (a
 * multi-column or non-`ANY` constraint) returns null.
 */
function checkEnumValues(column, definition) {
  const m = definition.match(
    /^CHECK \(\(\(?(\w+)\)?(?:::text)? = ANY \(\(?ARRAY\[/,
  );
  if (!m || m[1] !== column) return null;
  const values = [...definition.matchAll(/'((?:[^']|'')*)'::(?:text|character varying)/g)]
    .map((x) => x[1].replace(/''/g, "'"));
  return values.length > 0 ? values : null;
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

  // Real enum types (not CHECK … IN) → their labels, straight from pg_enum.
  const { rows: enumRows } = await client.query(
    `select t.typname as type_name, e.enumlabel as label
       from pg_type t
       join pg_enum e on e.enumtypid = t.oid
       join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      order by t.typname, e.enumsortorder`,
  );
  const enumsByType = new Map(); // udt_name -> string[]
  for (const row of enumRows) {
    if (!enumsByType.has(row.type_name)) enumsByType.set(row.type_name, []);
    enumsByType.get(row.type_name).push(row.label);
  }

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
    const typeOf = (c) => {
      const enumValues = enums.get(`${table}.${c.column_name}`);
      return enumValues
        ? enumValues.map((v) => `'${v}'`).join(' | ')
        : tsType(c.udt_name, enumsByType);
    };

    const rowLines = cols.map((c) => {
      const nullable = c.is_nullable === 'YES';
      return `  ${c.column_name}: ${typeOf(c)}${nullable ? ' | null' : ''};`;
    });

    // Insert shape: a column is optional when it is nullable or carries a
    // database default, so an insert need not hand-`Omit` the defaulted ones.
    const insertLines = cols.map((c) => {
      const nullable = c.is_nullable === 'YES';
      const hasDefault = c.column_default != null;
      return `  ${c.column_name}${nullable || hasDefault ? '?' : ''}: ${typeOf(c)}${
        nullable ? ' | null' : ''
      };`;
    });

    blocks.push(
      `export interface ${interfaceName(table)} {\n${rowLines.join('\n')}\n}`,
      `export interface ${interfaceName(table)}Insert {\n${insertLines.join('\n')}\n}`,
    );
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
// pg_constraint + pg_enum), so these types cannot drift from the database
// silently.
//
// Nullability mirrors the schema exactly (\`| null\` for every nullable column,
// nothing for a \`not null\` column). \`numeric\` and \`bigint\` are typed as
// \`string\` because node-postgres returns them as strings. Real Postgres enums
// become string unions and array columns become typed arrays. Each table also
// gets an \`…Insert\` shape where nullable and defaulted columns are optional.

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
  console.log(`gen-types: wrote ${tableNames.length} table(s) to src/modules/platform/types.ts`);
} finally {
  await client.end().catch(() => {});
}
