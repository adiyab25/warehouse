/**
 * OPENING-BALANCE IMPORT (Task 19) — the testable core behind
 * `scripts/import-opening.mjs`.
 *
 * This is a privileged BULK WRITE to the append-only ledger: the day the
 * client's real stock enters the system. It is strict and loud on purpose.
 *
 *   - ALL OR NOTHING: one `withTenant` transaction for the whole file. Any error
 *     anywhere rolls the whole thing back.
 *   - DRY-RUN IS THE SAME CODE PATH: without `apply` the identical writes run
 *     inside the transaction and are then ROLLED BACK. There is no separate
 *     preview implementation that could disagree with the real one.
 *   - APP ROLE ONLY: a superuser / BYPASSRLS connection is refused (the same
 *     assertion the app serves under).
 *   - The idempotency key `opening:<SKU>:<LOCATION>` makes a re-run harmless, but
 *     a re-run with a DIFFERENT number is an ERROR, never a silent skip.
 *   - Numbers are validated as DECIMAL STRINGS, never through float maths.
 */
import { createHash } from 'node:crypto';

import { assertServingRole } from '@/modules/platform/index';
import { withTenant, type Queryable } from '@/modules/platform/index';
import { createItem, type ItemFamily } from '@/modules/catalog/index';
import { lockStockPair, postMovement } from '@/modules/ledger/index';
import { isValidScannedCode, normaliseScannedCode } from '@/modules/catalog/schema';
import { normaliseUsername } from '@/modules/platform/schema';

import type { Pool } from 'pg';

export const COLUMNS = [
  'sku',
  'name_ar',
  'family',
  'uom',
  'pack_factor',
  'cost_egp',
  'location_code',
  'qty',
] as const;
type Column = (typeof COLUMNS)[number];

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 20_000;
/** Rows for already-existing items hold one advisory lock each until commit. */
export const MAX_EXISTING_ITEM_ROWS = 4_000;
export const MAX_ERRORS_SHOWN = 50;
export const FAMILIES = ['sellable', 'consumable', 'asset'] as const satisfies readonly ItemFamily[];
export const ALLOWED_LOCATION_TYPES = ['warehouse', 'branch', 'quarantine'] as const;
export const ALLOWED_ROLES = ['owner', 'warehouse_manager'] as const;
/** Units that are measured, not counted: a NEW item in one of these (blank `discrete`) may be fractional. */
export const MEASURED_UOMS = [
  'kg', 'g', 'gram', 'l', 'litre', 'liter', 'ml', 'm', 'metre', 'meter', 'cm', 'mm', 'ton', 'tonne', 'yard', 'yd',
  'كيلو', 'كجم', 'جرام', 'جم', 'لتر', 'متر', 'سم', 'طن', 'ياردة',
] as const;
export const OPTIONAL_COLUMNS = ['discrete'] as const;
const DISCRETE_VALUES: Record<string, boolean> = { yes: true, true: true, '1': true, no: false, false: false, '0': false };
const MAX_NAME = 200;
const MAX_UOM = 20;
const MAX_CODE = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Bidi overrides/isolates and zero-width characters: invisible, and they reorder or hide text. */
const HIDDEN = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
const UNSAFE_G = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/**
 * The ONE way any value from a file / command line is echoed in a message, the
 * summary or a stored note: control and bidi/zero-width characters become
 * `\uXXXX` (a terminal escape sequence can never run), and long text is capped.
 */
export function safeText(raw: string, max = 60): string {
  const cut = [...raw];
  return escapeUnsafe(cut.length > max ? `${cut.slice(0, max).join('')}…` : raw);
}

/** Escapes (without capping) every control / bidi / zero-width character. */
export function escapeUnsafe(raw: string): string {
  return raw.replace(UNSAFE_G, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Does the unit mean a measured quantity (so a NEW item may be fractional)? */
export function isMeasuredUom(uom: string): boolean {
  const k = uom.normalize('NFKC').trim().toLowerCase().replace(/\.$/, '').trim();
  return (MEASURED_UOMS as readonly string[]).includes(k);
}

export interface ImportError {
  /** CSV line number (1 = the header), or null for a whole-file problem. */
  line: number | null;
  message: string;
}

export interface OpeningRow {
  line: number;
  sku: string;
  nameAr: string;
  family: ItemFamily;
  uom: string;
  packFactor: string;
  costEgp: string;
  locationCode: string;
  qty: string;
  qtyIsZero: boolean;
  /** The value of the `discrete` cell: true/false, or null when blank / no such column. */
  discreteGiven: boolean | null;
  /** The flag a NEW item gets: the given value, else derived from the unit. */
  discrete: boolean;
  discreteSource: 'given' | 'derived';
}

/** The advisory-lock key text — exported so a test can hold the same lock. */
export function importLockText(tenantId: string): string {
  return `import-opening:${tenantId.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180)
// ---------------------------------------------------------------------------

export interface CsvRecord {
  line: number;
  fields: string[];
}

/**
 * RFC-4180 parser: quoted fields with commas, doubled quotes and embedded
 * newlines; CRLF / LF / lone CR; blank lines (and all-empty rows such as the
 * `,,,,,,,` Excel leaves behind) are skipped but still COUNTED in line numbers.
 * `line` is the line the record STARTS on.
 */
export function parseCsv(text: string): { records: CsvRecord[]; errors: ImportError[] } {
  const records: CsvRecord[] = [];
  const errors: ImportError[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false; // this field was opened with a quote
  let inQuotes = false;
  let afterQuote = false; // closing quote seen, field not yet ended
  let line = 1;
  let recLine = 1;
  let recBad = false;
  let started = false; // any char consumed in this record
  const n = text.length;

  const endField = (): void => {
    fields.push(field);
    field = '';
    quoted = false;
    afterQuote = false;
  };
  const endRecord = (): void => {
    endField();
    const blank = fields.every((f) => f.trim() === '');
    if (!recBad && !blank) records.push({ line: recLine, fields });
    fields = [];
    recBad = false;
    started = false;
  };
  const bad = (msg: string): void => {
    if (!recBad) errors.push({ line: recLine, message: msg });
    recBad = true;
  };

  for (let i = 0; i < n; i++) {
    const c = text[i]!;
    if (!started) {
      recLine = line;
      started = true;
    }
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (c === '\r') {
        if (text[i + 1] === '\n') i++;
        line++;
        field += '\n';
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field === '' && !quoted && !afterQuote) {
        inQuotes = true;
        quoted = true;
      } else {
        bad(
          `a quote mark appears in the middle of a value — wrap the whole value in quotes and write an inner quote as two ("")`,
        );
      }
    } else if (c === ',') {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
    } else {
      if (afterQuote) bad('text follows a closing quote — a quoted value must end at its closing quote');
      field += c;
    }
  }
  if (inQuotes) {
    errors.push({
      line: recLine,
      message: 'a quoted value starting on this line is never closed (missing closing quote)',
    });
  } else if (started) {
    endRecord();
  }
  return { records, errors };
}

/** Decodes strictly as UTF-8 (BOM stripped). Never silently mojibakes Arabic. */
export function decodeUtf8(bytes: Uint8Array): { text?: string; error?: ImportError } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); // also strips one leading BOM
    return { text };
  } catch {
    return {
      error: {
        line: null,
        message:
          'the file is not valid UTF-8 text (Arabic letters would come out garbled). In Excel choose ' +
          'File > Save As > "CSV UTF-8 (Comma delimited)" — not plain "CSV", which uses Windows-1256 — and try again',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Exact decimal strings
// ---------------------------------------------------------------------------

/** Strips trailing zeros so '12.500' and '12.5' and '12' compare by value. */
export function canonDecimal(s: string): string {
  if (!s.includes('.')) return s.replace(/^0+(?=\d)/, '');
  return s.replace(/0+$/, '').replace(/\.$/, '').replace(/^0+(?=\d)/, '');
}

export interface DecimalRule {
  label: string;
  maxInt: number;
  maxDec: number;
  /** true: value must be > 0; false: value must be >= 0. */
  positive: boolean;
}

/** Returns a specific problem, or null when `raw` is a clean decimal string. */
export function decimalProblem(raw: string, rule: DecimalRule): string | null {
  const { label, maxInt, maxDec, positive } = rule;
  const s = raw.trim();
  if (s === '') return `${label} is blank`;
  const q = safeText(s);
  if (/[\u0660-\u0669\u06F0-\u06F9\uFF10-\uFF19]/.test(s)) {
    return `${label} "${q}" uses Arabic-Indic or full-width digits — retype it with plain digits 0-9`;
  }
  if (/^[-\u2212]/.test(s)) return `${label} "${q}" is negative`;
  if (s.startsWith('+')) return `${label} "${q}" starts with a plus sign — write the bare number`;
  if (/^(nan|inf|infinity)$/i.test(s)) return `${label} "${q}" is not a number`;
  if (/[$£€¥]|egp|\bl\.?e\b|ج\.?م/i.test(s)) {
    return `${label} "${q}" contains a currency sign or text — write only the number`;
  }
  if (/^\d+(\.\d+)?e[-+]?\d+$/i.test(s)) {
    return `${label} "${q}" is in scientific notation — write it out in full`;
  }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    return `${label} "${q}" has a thousands separator — remove the comma`;
  }
  if (/^\d+,\d+$/.test(s)) {
    return `${label} "${q}" uses a comma as the decimal point — use a dot (1.5)`;
  }
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return `${label} "${q}" is not a plain decimal number (digits 0-9 with an optional .decimals)`;
  }
  const [int = '', dec = ''] = s.split('.');
  if (maxDec === 0 && s.includes('.')) return `${label} "${q}" must be a whole number`;
  if (dec.length > maxDec) return `${label} "${q}" has more than ${maxDec} decimal places`;
  if (/^0\d/.test(int)) return `${label} "${q}" has leading zeros`;
  if (int.length > maxInt) return `${label} "${q}" is too large (at most ${maxInt} digits before the point)`;
  const isZero = /^0+(\.0+)?$/.test(s);
  if (positive && isZero) return `${label} "${q}" must be greater than zero`;
  return null;
}

const QTY_RULE: DecimalRule = { label: 'qty', maxInt: 9, maxDec: 3, positive: false };
const COST_RULE: DecimalRule = { label: 'cost_egp', maxInt: 10, maxDec: 2, positive: false };
const PACK_RULE: DecimalRule = { label: 'pack_factor', maxInt: 9, maxDec: 0, positive: true };

/** Light canonical form of an item name: NFKC + collapsed whitespace + trim. */
export function canonName(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Parsing + per-row validation (pure)
// ---------------------------------------------------------------------------

export function parseOpeningCsv(bytes: Uint8Array): {
  rows: OpeningRow[];
  rowsRead: number;
  errors: ImportError[];
} {
  const errors: ImportError[] = [];
  if (bytes.length > MAX_BYTES) {
    return {
      rows: [],
      rowsRead: 0,
      errors: [{ line: null, message: `the file is larger than ${MAX_BYTES / 1024 / 1024} MB — split it into smaller files` }],
    };
  }
  const dec = decodeUtf8(bytes);
  if (dec.error) return { rows: [], rowsRead: 0, errors: [dec.error] };
  const { records, errors: csvErrors } = parseCsv(dec.text!);
  errors.push(...csvErrors);
  const header = records[0];
  if (!header) {
    errors.push({ line: null, message: 'the file is empty — it needs a header line and at least one row' });
    return { rows: [], rowsRead: 0, errors };
  }
  const names = header.fields.map((h) => h.trim().toLowerCase());
  const want = new Set<string>([...COLUMNS, ...OPTIONAL_COLUMNS]);
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const nm of names) (seen.has(nm) ? dup : seen).add(nm);
  const missing = COLUMNS.filter((c) => !seen.has(c));
  const unknown = [...seen].filter((c) => !want.has(c));
  if (dup.size) errors.push({ line: header.line, message: `header repeats column(s): ${[...dup].map((d) => safeText(d)).join(', ')}` });
  if (missing.length) errors.push({ line: header.line, message: `header is missing column(s): ${missing.join(', ')}` });
  if (unknown.length) {
    errors.push({
      line: header.line,
      message: `header has unknown column(s): ${unknown.map((u) => `"${safeText(u)}"`).join(', ')} (expected: ${COLUMNS.join(', ')}, and optionally ${OPTIONAL_COLUMNS.join(', ')})`,
    });
  }
  if (dup.size || missing.length || unknown.length) return { rows: [], rowsRead: 0, errors };

  const idx = Object.fromEntries(COLUMNS.map((c) => [c, names.indexOf(c)])) as Record<Column, number>;
  const discreteIdx = names.indexOf('discrete');
  const data = records.slice(1);
  if (data.length === 0 && csvErrors.length === 0) {
    errors.push({ line: null, message: 'the file has a header but no data rows — nothing to import' });
  }
  if (data.length > MAX_ROWS) {
    errors.push({ line: null, message: `the file has ${data.length} data rows; the limit is ${MAX_ROWS} — split it into smaller files` });
    return { rows: [], rowsRead: data.length, errors };
  }

  const rows: OpeningRow[] = [];
  for (const rec of data) {
    if (rec.fields.length !== names.length) {
      errors.push({
        line: rec.line,
        message: `this row has ${rec.fields.length} value(s) but the header has ${names.length} (check for a missing or extra comma, or an unquoted comma inside a name)`,
      });
      continue;
    }
    const get = (c: Column): string => rec.fields[idx[c]] ?? '';
    const rowErrors: string[] = [];

    const skuRaw = get('sku').trim();
    const sku = normaliseScannedCode(skuRaw);
    if (skuRaw === '') rowErrors.push('sku is blank');
    else if (HIDDEN.test(get('sku'))) rowErrors.push('sku contains a hidden character (invisible or text-direction mark) — retype it');
    else if (!isValidScannedCode(skuRaw) || sku.length > MAX_CODE) {
      rowErrors.push(
        `sku "${safeText(skuRaw)}" is not a code the scanner can read (letters/digits joined by hyphens, like PEN-0001) — its label could never be scanned`,
      );
    }

    const nameAr = canonName(get('name_ar'));
    if (nameAr === '') rowErrors.push('name_ar is blank');
    else if (HIDDEN.test(get('name_ar'))) rowErrors.push('name_ar contains a hidden character (invisible or text-direction mark) — retype it');
    else if (CONTROL.test(get('name_ar').trim())) rowErrors.push('name_ar contains a control character (line break or similar)');
    else if (nameAr.length > MAX_NAME) rowErrors.push(`name_ar is longer than ${MAX_NAME} characters`);

    const familyRaw = get('family').trim().toLowerCase();
    if (!(FAMILIES as readonly string[]).includes(familyRaw)) {
      rowErrors.push(`family "${safeText(get('family').trim())}" is not one of: ${FAMILIES.join(', ')}`);
    }

    const uom = get('uom').trim();
    if (uom === '') rowErrors.push('uom is blank');
    else if (HIDDEN.test(get('uom'))) rowErrors.push('uom contains a hidden character (invisible or text-direction mark) — retype it');
    else if (CONTROL.test(uom)) rowErrors.push('uom contains a control character');
    else if (uom.length > MAX_UOM) rowErrors.push(`uom is longer than ${MAX_UOM} characters`);

    const locationCode = get('location_code').trim().toUpperCase();
    if (locationCode === '') rowErrors.push('location_code is blank');
    else if (HIDDEN.test(get('location_code'))) rowErrors.push('location_code contains a hidden character (invisible or text-direction mark) — retype it');
    else if (CONTROL.test(locationCode) || locationCode.length > MAX_CODE) {
      rowErrors.push(`location_code "${safeText(get('location_code').trim())}" is not a valid location code`);
    }

    let discreteGiven: boolean | null = null;
    if (discreteIdx >= 0) {
      const dv = (rec.fields[discreteIdx] ?? '').trim();
      if (dv !== '') {
        const key = dv.toLowerCase();
        if (!Object.hasOwn(DISCRETE_VALUES, key)) {
          rowErrors.push(`discrete "${safeText(dv)}" is not allowed — use one of: yes, no, true, false, 1, 0 (or leave it blank to decide from the unit)`);
        } else discreteGiven = DISCRETE_VALUES[key]!;
      }
    }
    const packProblem = decimalProblem(get('pack_factor'), PACK_RULE);
    if (packProblem) rowErrors.push(packProblem);
    const costProblem = decimalProblem(get('cost_egp'), COST_RULE);
    if (costProblem) rowErrors.push(costProblem);
    const qtyProblem = decimalProblem(get('qty'), QTY_RULE);
    if (qtyProblem) rowErrors.push(qtyProblem);

    if (rowErrors.length) {
      for (const m of rowErrors) errors.push({ line: rec.line, message: m });
      continue;
    }
    const qtyRaw = get('qty').trim();
    rows.push({
      line: rec.line,
      sku,
      nameAr,
      family: familyRaw as ItemFamily,
      uom,
      packFactor: canonDecimal(get('pack_factor').trim()),
      costEgp: canonDecimal(get('cost_egp').trim()),
      locationCode,
      qty: canonDecimal(qtyRaw),
      qtyIsZero: /^0+(\.0+)?$/.test(qtyRaw),
      discreteGiven,
      discrete: discreteGiven ?? !isMeasuredUom(uom),
      discreteSource: discreteGiven === null ? 'derived' : 'given',
    });
  }
  return { rows, rowsRead: data.length, errors };
}

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

export interface ImportOptions {
  tenantId: string;
  username: string;
  fileName: string;
  /** Called only AFTER the actor is resolved, inside the transaction. */
  readInput: () => Uint8Array | Promise<Uint8Array>;
  apply: boolean;
}

export interface ImportResult {
  ok: boolean;
  applied: boolean;
  tenantId: string;
  actor: string | null;
  fileName: string;
  rowsRead: number;
  itemsToCreate: number;
  movementsToPost: number;
  skippedZero: number;
  unchanged: number;
  errors: ImportError[];
  /** Human-readable "would do" lines (what was / would be written). */
  plan: string[];
}

type VariantInfo = {
  id: string;
  sku: string;
  barcode: string;
  active: boolean;
  item_active: boolean;
  name_ar: string;
  family: string;
  uom: string;
  pack_factor: string | null;
  cost_egp: string;
  discrete: boolean;
};

type PlanEntry = {
  row: OpeningRow;
  create: boolean;
  variantId: string | null;
  locationId: string;
  discrete: boolean;
  source: 'given' | 'derived' | 'stored';
};

class RowFailure extends Error {}
class Rollback extends Error {
  constructor(readonly result: ImportResult) {
    super('rollback');
  }
}

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** A canonical decimal shown with exactly 2 decimals (piasters): '120.5' -> '120.50'. */
function money(c: string): string {
  const [i = '0', d = ''] = c.split('.');
  return `${i}.${d.padEnd(2, '0')}`;
}

function discreteWords(discrete: boolean, source: 'given' | 'derived' | 'stored'): string {
  return `${discrete ? 'counted in whole units' : 'may be fractional'} (${source})`;
}

export async function runOpeningImport(pool: Pool, opts: ImportOptions): Promise<ImportResult> {
  const base = safeText((opts.fileName.split(/[\\/]/).pop() ?? opts.fileName).slice(0, 120), 120);
  const result: ImportResult = {
    ok: false,
    applied: false,
    tenantId: safeText(opts.tenantId, 80),
    actor: null,
    fileName: base,
    rowsRead: 0,
    itemsToCreate: 0,
    movementsToPost: 0,
    skippedZero: 0,
    unchanged: 0,
    errors: [],
    plan: [],
  };
  const fail = (line: number | null, message: string): void => {
    result.errors.push({ line, message });
  };

  if (!UUID.test(opts.tenantId)) {
    fail(null, `--tenant "${safeText(opts.tenantId)}" is not a valid tenant id (a UUID)`);
    return result;
  }
  const username = normaliseUsername(opts.username);
  if (!username) {
    fail(null, '--user is required: the username of the owner or warehouse manager doing the import');
    return result;
  }
  if (CONTROL.test(opts.username) || HIDDEN.test(opts.username) || CONTROL.test(username)) {
    fail(null, `--user "${safeText(opts.username)}" contains a control or hidden character — type the username again`);
    return result;
  }
  // REFUSE a connection that bypasses row-level security (throws).
  await assertServingRole(pool);

  try {
    await withTenant(pool, opts.tenantId, async (db) => {
      // One import per tenant at a time. Taken BEFORE any read, so a second
      // import waits and then sees the first one's committed rows.
      await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [importLockText(opts.tenantId)]);

      // --- the actor, resolved WITHIN this tenant before the file is read ---
      const { rows: users } = await db.query<{ id: string; role: string; active: boolean }>(
        `select id, role, active from app_users where username = $1 and tenant_id = ${TENANT}`,
        [username],
      );
      const user = users[0];
      if (!user) {
        fail(null, `user "${safeText(username)}" does not exist in this tenant — nothing was read or written`);
      } else if (!user.active) {
        fail(null, `user "${safeText(username)}" is deactivated — nothing was read or written`);
      } else if (!(ALLOWED_ROLES as readonly string[]).includes(user.role)) {
        fail(null, `user "${safeText(username)}" has role ${user.role}; only an owner or warehouse_manager may import opening balances`);
      }
      if (!user || result.errors.length) throw new Rollback(result);
      result.actor = username;

      // --- read + parse + validate (pure) ---
      let bytes: Uint8Array;
      try {
        bytes = await opts.readInput();
      } catch (err) {
        fail(null, `could not read the file: ${safeText(err instanceof Error ? err.message : String(err), 300)}`);
        throw new Rollback(result);
      }
      const parsed = parseOpeningCsv(bytes);
      result.rowsRead = parsed.rowsRead;
      result.errors.push(...parsed.errors);
      const rows = parsed.rows;

      // --- duplicates inside the file ---
      const firstSeen = new Map<string, number>();
      const unique: OpeningRow[] = [];
      for (const r of rows) {
        const k = `${r.sku}\u0000${r.locationCode}`;
        const prev = firstSeen.get(k);
        if (prev !== undefined) {
          fail(
            r.line,
            `duplicate of line ${prev}: sku ${r.sku} at location ${r.locationCode} is listed twice (lines ${prev} and ${r.line}). One opening balance per item per location — merge them into one row`,
          );
        } else {
          firstSeen.set(k, r.line);
          unique.push(r);
        }
      }

      // --- preload the facts we check against (read-only) ---
      const locByCode = new Map<string, { id: string; type: string; active: boolean }>();
      const codes = [...new Set(unique.map((r) => r.locationCode))];
      for (const part of chunks(codes, 1000)) {
        const { rows: ls } = await db.query<{ id: string; code: string; type: string; active: boolean }>(
          `select id, code, type, active from locations where code = any($1) and tenant_id = ${TENANT}`,
          [part],
        );
        for (const l of ls) locByCode.set(l.code, l);
      }

      const skus = [...new Set(unique.map((r) => r.sku))];
      const variantBySku = new Map<string, VariantInfo>();
      const barcodeOwner = new Map<string, string>();
      for (const part of chunks(skus, 2000)) {
        const { rows: vs } = await db.query<VariantInfo>(
          `select v.id, v.sku, v.barcode, v.active, i.active as item_active, i.name_ar, i.family, i.uom,
                  i.pack_factor::text as pack_factor, i.cost_egp::text as cost_egp, i.discrete
             from item_variants v
             join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
            where (v.sku = any($1) or v.barcode = any($1)) and v.tenant_id = ${TENANT}`,
          [part],
        );
        for (const v of vs) {
          if (part.includes(v.sku)) variantBySku.set(v.sku, v);
          else barcodeOwner.set(v.barcode, v.sku);
        }
      }

      const keyOf = (r: OpeningRow): string => `opening:${r.sku}:${r.locationCode}`;
      const keyRows = new Map<string, { variant_id: string; to_location_id: string | null; from_location_id: string | null; qty: string; reason: string }>();
      for (const part of chunks(unique.map(keyOf), 2000)) {
        const { rows: ks } = await db.query<{
          idempotency_key: string;
          variant_id: string;
          to_location_id: string | null;
          from_location_id: string | null;
          qty: string;
          reason: string;
        }>(
          `select idempotency_key, variant_id, to_location_id, from_location_id, qty::text as qty, reason
             from stock_movements where idempotency_key = any($1) and tenant_id = ${TENANT}`,
          [part],
        );
        for (const k of ks) keyRows.set(k.idempotency_key, k);
      }

      const existingIds = [...variantBySku.values()].map((v) => v.id);
      const skuById = new Map([...variantBySku.values()].map((v) => [v.id, v.sku] as const));
      const codeById = new Map([...locByCode.entries()].map(([c, l]) => [l.id, c] as const));
      const wanted = new Set(unique.map((r) => `${variantBySku.get(r.sku)?.id}|${locByCode.get(r.locationCode)?.id}`));
      const otherAt = new Map<string, string>(); // `${variant}|${location}` -> description of first other movement
      for (const part of chunks(existingIds, 2000)) {
        const { rows: ms } = await db.query<{
          variant_id: string;
          to_location_id: string | null;
          from_location_id: string | null;
          idempotency_key: string | null;
          reason: string;
        }>(
          `select variant_id, to_location_id, from_location_id, idempotency_key, reason
             from stock_movements where variant_id = any($1) and tenant_id = ${TENANT}`,
          [part],
        );
        for (const m of ms) {
          for (const loc of [m.to_location_id, m.from_location_id]) {
            if (!loc) continue;
            const pair = `${m.variant_id}|${loc}`;
            if (!wanted.has(pair)) continue;
            if (m.idempotency_key === `opening:${skuById.get(m.variant_id)}:${codeById.get(loc)}`) continue;
            if (!otherAt.has(pair)) otherAt.set(pair, m.reason);
          }
        }
      }

      // `discrete` for a NEW sku: any row that GIVES it decides (blank rows have no opinion);
      // two rows that give different values are an error.
      const newDiscrete = new Map<string, { value: boolean; line: number }>();
      for (const r of unique) {
        if (variantBySku.has(r.sku) || r.discreteGiven === null) continue;
        const prev = newDiscrete.get(r.sku);
        if (!prev) newDiscrete.set(r.sku, { value: r.discreteGiven, line: r.line });
        else if (prev.value !== r.discreteGiven) {
          fail(r.line, `sku ${r.sku} also appears on line ${prev.line} with a different discrete: "${r.discreteGiven ? 'yes' : 'no'}" vs "${prev.value ? 'yes' : 'no'}". One item, one set of details`);
        }
      }

      // --- per-row checks (read-only; build the plan) ---
      const plan: PlanEntry[] = [];
      const newSkuFirst = new Map<string, OpeningRow>();
      for (const r of unique) {
        const before = result.errors.length;
        const loc = locByCode.get(r.locationCode);
        if (!loc) {
          fail(r.line, `unknown location "${r.locationCode}" — locations must already exist; this import never creates them`);
        } else if (!(ALLOWED_LOCATION_TYPES as readonly string[]).includes(loc.type)) {
          fail(
            r.line,
            `location "${r.locationCode}" is a ${loc.type} location; opening stock can only go into a ${ALLOWED_LOCATION_TYPES.join(', ')} location`,
          );
        } else if (!loc.active) {
          fail(r.line, `location "${r.locationCode}" is inactive — reactivate it first`);
        }

        const v = variantBySku.get(r.sku);
        let discrete: boolean;
        if (v) {
          discrete = v.discrete;
          if (!v.active || !v.item_active) fail(r.line, `item ${r.sku} is deactivated — reactivate it before importing stock for it`);
          const diffs: Array<[string, string, string]> = [];
          if (canonName(v.name_ar) !== r.nameAr) diffs.push(['name_ar', r.nameAr, v.name_ar]);
          if (v.family !== r.family) diffs.push(['family', r.family, v.family]);
          if (v.uom !== r.uom) diffs.push(['uom', r.uom, v.uom]);
          if ((v.pack_factor === null ? '' : canonDecimal(v.pack_factor)) !== r.packFactor) {
            diffs.push(['pack_factor', r.packFactor, v.pack_factor === null ? '(none)' : canonDecimal(v.pack_factor)]);
          }
          if (canonDecimal(v.cost_egp) !== r.costEgp) diffs.push(['cost_egp', r.costEgp, canonDecimal(v.cost_egp)]);
          if (r.discreteGiven !== null && r.discreteGiven !== v.discrete) {
            diffs.push(['discrete', r.discreteGiven ? 'yes' : 'no', v.discrete ? 'yes' : 'no']);
          }
          for (const [field, csv, stored] of diffs) {
            fail(
              r.line,
              `item ${r.sku} already exists but ${field} differs: CSV has "${safeText(csv, 200)}", the item has "${safeText(stored, 200)}". The import never edits an item — fix the CSV or edit the item itself`,
            );
          }
        } else {
          discrete = newDiscrete.get(r.sku)?.value ?? r.discrete;
          const owner = barcodeOwner.get(r.sku);
          if (owner) fail(r.line, `code ${r.sku} is already used as the barcode of item ${safeText(owner)}`);
          const first = newSkuFirst.get(r.sku);
          if (!first) newSkuFirst.set(r.sku, r);
          else {
            for (const f of ['nameAr', 'family', 'uom', 'packFactor', 'costEgp'] as const) {
              if (first[f] !== r[f]) {
                fail(r.line, `sku ${r.sku} also appears on line ${first.line} with a different ${f === 'nameAr' ? 'name_ar' : f === 'packFactor' ? 'pack_factor' : f === 'costEgp' ? 'cost_egp' : f}: "${safeText(r[f], 200)}" vs "${safeText(first[f], 200)}". One item, one set of details`);
              }
            }
          }
        }

        if (discrete && !/^\d+(\.0+)?$/.test(r.qty) && r.qty.includes('.')) {
          fail(
            r.line,
            `item ${r.sku} is counted in whole units, so qty ${r.qty} is not allowed. ` +
              (v
                ? 'The item already exists and the import never edits it, so fix the qty.'
                : 'If it can be fractional (metres, kilos), put no in the discrete column and import again; if it is whole, fix the qty.'),
          );
        }

        // Opening balance must be FIRST, and a re-run must not swallow a different number.
        const key = keyOf(r);
        const kr = keyRows.get(key);
        let unchanged = false;
        if (kr) {
          if (v && loc && kr.variant_id === v.id && kr.to_location_id === loc.id && kr.from_location_id === null && kr.reason === 'opening_balance') {
            if (canonDecimal(kr.qty) === r.qty) unchanged = true;
            else {
              fail(
                r.line,
                `already imported with a different quantity: stored ${canonDecimal(kr.qty)}, this file says ${r.qty} (sku ${r.sku}, location ${r.locationCode}). A posted opening balance is corrected with a COUNT SESSION, not by importing again`,
              );
            }
          } else {
            fail(r.line, `idempotency key ${key} already belongs to a different movement — refusing to guess`);
          }
        } else if (v && loc && otherAt.has(`${v.id}|${loc.id}`)) {
          fail(
            r.line,
            `item ${r.sku} already has stock movements at ${r.locationCode} (${otherAt.get(`${v.id}|${loc.id}`)}). An opening balance after trading began would double count — correct it with a COUNT SESSION`,
          );
        }

        if (result.errors.length > before) continue;
        if (r.qtyIsZero) {
          result.skippedZero++;
          continue;
        }
        if (unchanged) {
          result.unchanged++;
          continue;
        }
        plan.push({
          row: r,
          create: !v,
          variantId: v?.id ?? null,
          locationId: loc!.id,
          discrete,
          source: v ? (r.discreteGiven === null ? 'stored' : 'given') : newDiscrete.has(r.sku) ? 'given' : 'derived',
        });
      }

      // A new sku is created once, at its first posted row.
      const creating = new Set<string>();
      for (const p of plan) {
        if (p.create) {
          if (creating.has(p.row.sku)) p.create = false;
          else creating.add(p.row.sku);
        }
      }

      const lockedRows = plan.filter((p) => p.variantId).length;
      if (lockedRows > MAX_EXISTING_ITEM_ROWS) {
        fail(
          null,
          `this file posts opening stock for ${lockedRows} items that already exist; the limit is ${MAX_EXISTING_ITEM_ROWS} per file (each one is locked until the save finishes). Split the file`,
        );
      }

      if (result.errors.length) throw new Rollback(finish(result, plan));

      // --- execute (the SAME writes for dry-run and apply; dry-run rolls back) ---
      const variantIds = new Map<string, string>();
      for (const [sku, v] of variantBySku) variantIds.set(sku, v.id);
      let lineNow = 0;
      try {
        for (const p of plan) {
          const r = p.row;
          lineNow = r.line;
          if (p.create) {
            const { variant } = await createItem(db, {
              sku: r.sku,
              barcode: r.sku,
              nameAr: r.nameAr,
              family: r.family,
              uom: r.uom,
              packFactor: Number(r.packFactor),
              costEgp: Number(r.costEgp),
              discrete: p.discrete,
            });
            variantIds.set(r.sku, variant.id);
            result.plan.push(`line ${r.line}: create item ${r.sku} "${safeText(r.nameAr, 200)}" (${r.family}, ${safeText(r.uom)}, cost ${money(r.costEgp)}) — ${discreteWords(p.discrete, p.source)}`);
          }
          const variantId = variantIds.get(r.sku)!;
          // Pair lock per posted row, like every other ledger writer — but only for
          // items that EXIST. A variant created in this very transaction is
          // invisible to every other session until commit, so nobody can race it;
          // and each advisory lock is held until commit, so locking 20,000 brand-new
          // pairs would exhaust Postgres's shared lock table ("out of shared memory").
          if (p.variantId) {
            await lockStockPair(db, variantId, p.locationId);
            const { rows } = await db.query<{ n: string }>(
              `select count(*)::text as n from stock_movements
                where variant_id = $1 and tenant_id = ${TENANT}
                  and (to_location_id = $2 or from_location_id = $2)`,
              [variantId, p.locationId],
            );
            if (rows[0]?.n !== '0') throw new RowFailure('movements appeared at this location while importing — nothing was written, run again');
          }
          const posted = await postMovement(db, {
            variantId,
            qty: Number(r.qty), // exact: <= 9 integer digits and <= 3 decimals = <= 12 significant digits
            reason: 'opening_balance',
            toLocationId: p.locationId,
            actorUserId: user.id,
            refType: 'IMPORT',
            idempotencyKey: keyOf(r),
            notes: `opening balance import ${base} line ${r.line}`,
            discrete: p.discrete,
          });
          if (posted.deduped) throw new RowFailure('the opening movement for this row already exists (posted by a concurrent writer)');
          result.plan.push(`line ${r.line}: post opening balance +${r.qty} ${r.sku} -> ${r.locationCode} — ${discreteWords(p.discrete, p.source)}`);
        }
      } catch (err) {
        fail(lineNow || null, err instanceof RowFailure ? err.message : `the database refused this row: ${safeText(err instanceof Error ? err.message : String(err), 300)}`);
        throw new Rollback(finish(result, plan));
      }
      finish(result, plan);
      result.ok = true;
      if (!opts.apply) throw new Rollback(result);
      result.applied = true;
    }, { requireCommit: true });
  } catch (err) {
    if (err instanceof Rollback) {
      return err.result;
    }
    throw err;
  }
  return result;
}

function finish(result: ImportResult, plan: PlanEntry[]): ImportResult {
  // A failed import writes nothing, so it reports nothing to create or post.
  const failed = result.errors.length > 0;
  result.itemsToCreate = failed ? 0 : plan.filter((p) => p.create).length;
  result.movementsToPost = failed ? 0 : plan.length;
  result.errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return result;
}

/** A stable digest of the file, for the summary (proves WHICH file was read). */
export function fileDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

/** Plain-text summary (never includes connection details). */
export function formatSummary(r: ImportResult, apply: boolean): string {
  const out: string[] = [];
  const mode = apply ? 'APPLY' : 'DRY RUN (nothing is saved — add --apply to save)';
  out.push(`Opening-balance import — ${mode}`);
  out.push(`  tenant:  ${safeText(r.tenantId, 80)}`);
  out.push(`  user:    ${safeText(r.actor ?? '(not resolved)')}`);
  out.push(`  file:    ${safeText(r.fileName, 120)}`);
  out.push(`  rows read:            ${r.rowsRead}`);
  out.push(`  items to create:      ${r.itemsToCreate}`);
  out.push(`  movements to post:    ${r.movementsToPost}`);
  out.push(`  rows skipped (qty 0): ${r.skippedZero}`);
  out.push(`  unchanged (re-run):   ${r.unchanged}`);
  out.push(`  errors:               ${r.errors.length}`);
  if (r.plan.length) {
    out.push('Actions:');
    for (const p of r.plan.slice(0, 30)) out.push(`  ${escapeUnsafe(p)}`);
    if (r.plan.length > 30) out.push(`  ... and ${r.plan.length - 30} more`);
  }
  if (r.errors.length) {
    out.push('ERRORS:');
    for (const e of r.errors.slice(0, MAX_ERRORS_SHOWN)) out.push(`  ${e.line === null ? 'file' : `line ${e.line}`}: ${escapeUnsafe(e.message)}`);
    if (r.errors.length > MAX_ERRORS_SHOWN) out.push(`  ... and ${r.errors.length - MAX_ERRORS_SHOWN} more`);
    out.push('RESULT: FAILED — nothing was saved.');
  } else if (r.applied && r.movementsToPost === 0) {
    out.push(
      r.skippedZero === 0
        ? 'RESULT: NOTHING TO DO — every line was already imported'
        : 'RESULT: NOTHING TO DO — every line was already imported or has a quantity of 0',
    );
  } else if (r.applied) {
    out.push('RESULT: SAVED.');
  } else {
    out.push('RESULT: dry run OK — nothing was saved.');
  }
  return out.join('\n');
}
