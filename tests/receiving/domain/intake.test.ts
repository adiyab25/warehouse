import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Client } from 'pg';

import { checkNote, scan, submitReceipt } from '@/app/intake/actions';
import {
  CONFLICT_MESSAGE,
  IntakeError,
  checkNoteIn,
  frontDoor,
  scanIn,
  submitIn,
} from '@/app/intake/handler';
import { SESSION_COOKIE } from '@/modules/auth/schema';
import { createSession } from '@/modules/auth/index';
import { withTenant } from '@/modules/platform/index';
import { createItem } from '@/modules/catalog/index';
import { createLocation, warehouseLocation } from '@/modules/locations/index';
import { onHand } from '@/modules/ledger/index';
import type { ItemVariant } from '@/modules/platform/index';
import { hasKey, t } from '@/i18n/index';
import {
  RECEIVING_ROLES,
  REFUSAL_MESSAGE_KEYS,
  type ReceiptForm,
  canReceive,
  previewShortfalls,
  receivedLines,
  resolveScan,
} from '@/modules/receiving/schema';
import { REPO_ROOT, migrateUrl, sqlTestUrl, withDb } from '../../harness/sql.ts';

/**
 * The WAREHOUSE INTAKE DOOR — the screen where stock is counted in.
 *
 * This screen WRITES THE LEDGER (through Task 6's `createReceipt`/`postReceipt`)
 * and stands at the door with a lorry and a scanner, so it is judged on four
 * properties, each of which was a real defect elsewhere in this codebase:
 *
 *   1. A SCAN NEVER SILENTLY DOES NOTHING AND NEVER CREATES AN ITEM. An unknown
 *      code comes back as `{ kind: 'unknown', code }` echoing what was scanned;
 *      the code is normalised before it is looked up, so a padded or lower-cased
 *      scan reaches the same row a clean one does.
 *   2. INTAKE IS A WAREHOUSE FUNCTION. A `branch_user` is refused SERVER-SIDE —
 *      not merely hidden in the UI — while an `owner`/`warehouse_manager` posts.
 *   3. A DOUBLE SUBMIT POSTS ONCE. The screen generates its keys when the form
 *      OPENS and keeps them stable across retries, so a double-tap collapses to
 *      one movement while a genuinely second delivery still posts.
 *   4. A SHORTFALL IS REPORTED, NEVER ABSORBED — and goods that have NOT arrived
 *      are not a shortage: an unreceived line produces no variance and stays
 *      unreceived on the receipt.
 *
 * The PURE rules are tested with no database at all; the same rules are then
 * driven for real through the screen's server-side seams (`scanIn`/`submitIn`)
 * against Postgres, guarded by `{ skip: !sqlTestUrl() }`.
 */

/** A stand-in variant row — enough of `item_variants` for the pure tests. */
function variantStub(barcode: string): ItemVariant {
  return {
    id: `00000000-0000-4000-8000-${barcode}`.slice(0, 36),
    tenant_id: '11111111-2222-3333-4444-555555555555',
    item_id: '11111111-2222-3333-4444-555555555555',
    sku: barcode,
    barcode,
    attrs: {},
    active: true,
    created_at: new Date(0),
  } as ItemVariant;
}

/**
 * The lookup the real screen performs: `findByBarcode` matches stored codes AND
 * returns the item's Arabic name alongside the variant ({@link resolveScan}'s
 * `lookup` must agree with `findByBarcode` in shape).
 */
const storedLookup =
  (stored: string) =>
  async (code: string): Promise<{ variant: ItemVariant; itemNameAr: string } | null> =>
    code === stored ? { variant: variantStub(stored), itemNameAr: 'قميص قطني' } : null;

// ---------------------------------------------------------------------------
// (1) … (4), pure — no database.
// ---------------------------------------------------------------------------

test('scanning an unknown code returns the code echoed back', async () => {
  const unknown = await resolveScan('AB-9999', storedLookup('AB-0012'));
  assert.deepEqual(
    unknown,
    { kind: 'unknown', code: 'AB-9999' },
    'an unknown scan must come back as { kind: "unknown", code } — never a silent no-op and never a minted item',
  );

  // A code too malformed to be a real barcode is the same answer, not an error:
  // the scanner mis-fired and the person must be told WHAT was read.
  const malformed = await resolveScan('  not a code  ', storedLookup('AB-0012'));
  assert.deepEqual(malformed, { kind: 'unknown', code: 'NOT A CODE' });
});

test('a scan is normalised before lookup', async () => {
  // The lookup is the REAL one: `findByBarcode` matches the STORED (trimmed,
  // upper-cased) code, so a screen that handed the raw scan straight through
  // would miss a padded, lower-cased barcode.
  const found = await resolveScan(' ab-0012 ', storedLookup('AB-0012'));

  assert.equal(found.kind, 'variant', 'a padded, lower-cased scan must still find its variant');
  if (found.kind === 'variant') {
    assert.equal(found.variant.barcode, 'AB-0012');
  }
});

test('a resolved scan carries the product’s NAME, not just its code', async () => {
  // A person holding a box at the door must confirm WHAT resolved: `AB-0012`
  // alone does not tell them it is the shirt they ordered. The name travels on
  // the scan result, alongside the variant, exactly as findByBarcode returns it.
  const found = await resolveScan(' ab-0012 ', storedLookup('AB-0012'));

  assert.equal(found.kind, 'variant', 'the scan must still resolve to a variant');
  if (found.kind === 'variant') {
    assert.equal(found.variant.barcode, 'AB-0012');
    assert.equal(
      found.itemNameAr,
      'قميص قطني',
      'the resolved scan must carry the item’s Arabic name, not only its code',
    );
  }
});

test('an unreceived line produces no shortfall', () => {
  const lines = [
    { variantId: 'a', expected: 40, received: null },
    { variantId: 'b', expected: 10, received: 10 },
  ];

  assert.deepEqual(
    previewShortfalls(lines),
    [],
    'goods that have not arrived are NOT a shortage — a delivery in parts must stay expressible',
  );

  assert.deepEqual(
    receivedLines(lines),
    [{ variantId: 'b', receivedQty: 10 }],
    'only the lines that actually arrived are posted',
  );
});

test('a shortfall is reported, never absorbed', () => {
  assert.deepEqual(
    previewShortfalls([{ variantId: 'a', expected: 40, received: 36 }]),
    [{ variantId: 'a', expected: 40, received: 36, variance: -4 }],
    'receiving 36 against an expected 40 is a variance of -4, not a quietly corrected 36',
  );
  assert.deepEqual(
    previewShortfalls([{ variantId: 'a', expected: 40, received: 44 }]),
    [{ variantId: 'a', expected: 40, received: 44, variance: 4 }],
    'an over-delivery is a positive variance',
  );
  assert.deepEqual(
    previewShortfalls([{ variantId: 'a', expected: 40, received: 40 }]),
    [],
    'an exact match is not a variance',
  );
});

test('only owner and warehouse_manager may receive goods', () => {
  assert.deepEqual([...RECEIVING_ROLES].sort(), ['owner', 'warehouse_manager']);
  assert.equal(canReceive('owner'), true);
  assert.equal(canReceive('warehouse_manager'), true);
  assert.equal(canReceive('branch_user'), false, 'a branch_user must never post a receipt');
  assert.equal(canReceive(''), false);
  assert.equal(canReceive(undefined), false);
});

test('each refusal CODE maps to its OWN message — forbidden is not “not signed in”', () => {
  const keys = Object.values(REFUSAL_MESSAGE_KEYS);
  assert.equal(
    new Set(keys).size,
    keys.length,
    'every refusal code must map to a DISTINCT message key',
  );
  assert.notEqual(
    REFUSAL_MESSAGE_KEYS.forbidden,
    REFUSAL_MESSAGE_KEYS.unauthenticated,
    'a forbidden refusal must not reuse the unauthenticated message',
  );
  assert.notEqual(REFUSAL_MESSAGE_KEYS.invalid, REFUSAL_MESSAGE_KEYS.unauthenticated);

  for (const key of keys) {
    assert.equal(hasKey(key, 'ar'), true, `${key} must exist in the Arabic dictionary`);
    assert.equal(hasKey(key, 'en'), true, `${key} must exist in the English dictionary`);
  }

  // The screen renders `t(REFUSAL_MESSAGE_KEYS[code])`; the FORBIDDEN code must
  // therefore produce the permission sentence, never the session one.
  assert.notEqual(
    t(REFUSAL_MESSAGE_KEYS.forbidden),
    t(REFUSAL_MESSAGE_KEYS.unauthenticated),
    'a forbidden refusal must not render the “you are not signed in” message',
  );
  assert.equal(t(REFUSAL_MESSAGE_KEYS.forbidden), t('intake.error.forbidden'));
});

test('the server actions ANSWER rather than throw when they cannot resolve a request', async () => {
  // There is no request scope in `node --test`, so reading the session cookie
  // throws. That is EXACTLY the "throw before the try" that used to reject the
  // action and strand the submit button; every action must turn it into an
  // outcome the screen can render, never a rejection it never catches.
  const submitted = await submitReceipt({
    formId: randomUUID(),
    refNo: 'dn-smoke',
    sourceLocationId: 'not-a-location',
    lines: [{ variantId: 'not-a-variant', expected: 1, received: 1 }],
  });
  assert.equal(submitted.ok, false, 'the submit action must answer, not reject');
  assert.ok(submitted.error, 'a refusal must arrive as a structured error on the outcome');

  const scanned = await scan('AB-0012');
  assert.equal(scanned.ok, false, 'the scan action must answer, not reject');

  const noted = await checkNote('DN-1');
  assert.equal(noted.ok, false, 'the note pre-check must answer, not reject');
});

// ---------------------------------------------------------------------------
// The same rules, driven for real through the screen's server-side seams.
// ---------------------------------------------------------------------------

type Provisioned = {
  t1: string;
  owner: string;
  manager: string;
  branch: string;
};

const provisionedTenants: string[] = [];

/**
 * One tenant with an `owner`, a `warehouse_manager` and a `branch_user`, over
 * the OWNER connection (a fresh tenant cannot satisfy its own RLS policy, so it
 * can never be created by the app role).
 */
async function provision(): Promise<Provisioned> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const {
      rows: [t1],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Intake One') returning id");

    const ids: Record<string, string> = {};
    for (const [name, username, role] of [
      ['Intake Owner', 'intake_owner', 'owner'],
      ['Intake Manager', 'intake_manager', 'warehouse_manager'],
      ['Intake Branch', 'intake_branch', 'branch_user'],
    ] as const) {
      const {
        rows: [u],
      } = await owner.query<{ id: string }>(
        `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash)
         values ($1, $2, public.normalise_name($2), $3, $4, 'x') returning id`,
        [t1!.id, name, username, role],
      );
      ids[role] = u!.id;
    }

    provisionedTenants.push(t1!.id);
    return { t1: t1!.id, owner: ids.owner!, manager: ids.warehouse_manager!, branch: ids.branch_user! };
  } finally {
    await owner.end();
  }
}

// Child rows first. `stock_movements` is append-only, so the ledger rows a
// receipt posts are cleared with triggers disabled on the OWNER connection.
after(async () => {
  if (provisionedTenants.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('set session_replication_role = replica');
    await owner.query('delete from receipt_lines where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from receipts where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from stock_snapshots where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from stock_movements where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('set session_replication_role = origin');
    await owner.query('delete from location_levels where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from item_variants where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from items where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from sessions where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from app_users where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from locations where tenant_id = any($1)', [provisionedTenants]);
    await owner.query('delete from tenants where id = any($1)', [provisionedTenants]);
  } finally {
    await owner.end();
  }
});

type AnyDb = Parameters<typeof createLocation>[0];

/** The receiving cast: a vendor, the warehouse, and one scannable item. */
async function setup(db: AnyDb, suffix: string) {
  const vendor = await createLocation(db, { code: `FAC-${suffix}`, nameAr: 'المصنع', type: 'vendor' });
  const warehouse = await createLocation(db, { code: `WH-${suffix}`, nameAr: 'المخزن', type: 'warehouse' });
  const created = await createItem(db, {
    nameAr: 'قميص',
    nameEn: 'Shirt',
    family: 'sellable',
    sku: `AB-${suffix}`,
    barcode: `AB-${suffix}`,
  });
  return { vendor, warehouse, variantId: created.variant.id, barcode: created.variant.barcode };
}

/** Opens a live session for one of the fixture users, as sign-in would. */
async function tokenFor(db: AnyDb, tenantId: string, userId: string): Promise<string> {
  const { token } = await withTenant(db, tenantId, (tdb) => createSession(tdb, { userId }));
  return token;
}

function formFor(vendorId: string, variantId: string, extra: Partial<ReceiptForm> = {}): ReceiptForm {
  return {
    formId: randomUUID(),
    refNo: 'dn-7',
    sourceLocationId: vendorId,
    lines: [{ variantId, expected: 40, received: 36 }],
    ...extra,
  };
}

test('the screen finds a variant from a padded, lower-cased scan', { skip: !sqlTestUrl() }, async () => {
  const { t1, owner } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'SCAN'));
    const token = await tokenFor(db, t1, owner);

    const found = await withTenant(db, t1, (tdb) => scanIn(tdb, token, ` ab-${'SCAN'} `));
    assert.equal(found.kind, 'variant', 'the screen’s own path must reach findByBarcode’s row');
    if (found.kind === 'variant') assert.equal(found.variant.id, ctx.variantId);

    const unknown = await withTenant(db, t1, (tdb) => scanIn(tdb, token, 'AB-9999'));
    assert.deepEqual(unknown, { kind: 'unknown', code: 'AB-9999' });
  });
});

test('scanning a real barcode names the product; an unknown or retired code does not', { skip: !sqlTestUrl() }, async () => {
  const { t1, owner } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'NAME'));
    const token = await tokenFor(db, t1, owner);

    // A scan that resolves must carry the item's Arabic name — the door person
    // confirms WHAT arrived, not just a code.
    const found = await withTenant(db, t1, (tdb) => scanIn(tdb, token, ` ab-${'NAME'} `));
    assert.equal(found.kind, 'variant', 'the barcode must resolve');
    if (found.kind === 'variant') {
      assert.equal(found.variant.id, ctx.variantId);
      assert.equal(found.itemNameAr, 'قميص', 'the scan must carry the item’s Arabic name');
    }

    // A code that matches nothing carries NO name — there is nothing to name.
    const unknown = await withTenant(db, t1, (tdb) => scanIn(tdb, token, 'AB-9999'));
    assert.deepEqual(
      unknown,
      { kind: 'unknown', code: 'AB-9999' },
      'an unknown code must be exactly { kind, code } — no name smuggled on',
    );

    // A RETIRED product scans exactly like one that never existed: same answer,
    // and no name — an unknown code and a deactivated one are indistinguishable.
    await withTenant(db, t1, (tdb) =>
      tdb.query('update items set active = false where id = (select item_id from item_variants where id = $1)', [
        ctx.variantId,
      ]),
    );
    const retired = await withTenant(db, t1, (tdb) => scanIn(tdb, token, ctx.barcode));
    assert.deepEqual(
      retired,
      { kind: 'unknown', code: ctx.barcode },
      'a retired product must scan as unknown with no name, like a code that never existed',
    );
  });
});

test('a branch_user is refused server-side, a warehouse_manager is not', { skip: !sqlTestUrl() }, async () => {
  const { t1, manager, branch } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'ROLE'));
    const branchToken = await tokenFor(db, t1, branch);
    const managerToken = await tokenFor(db, t1, manager);

    // The refusal is at the LEDGER, not in the UI: the action itself refuses.
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => submitIn(tdb, branchToken, formFor(ctx.vendor.id, ctx.variantId))),
      /not permitted|warehouse function/i,
      'a branch_user must be refused server-side',
    );
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => scanIn(tdb, branchToken, ctx.barcode)),
      /not permitted|warehouse function/i,
      'the scan path is a warehouse function too',
    );

    // …and nothing was written.
    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>('select count(*)::int as n from receipts');
      assert.equal(rows[0]!.n, 0, 'a refused caller must leave no receipt behind');
    });

    // Positive control: without it, an implementation that ALWAYS refused would
    // pass the assertions above.
    const posted = await withTenant(db, t1, (tdb) =>
      submitIn(tdb, managerToken, formFor(ctx.vendor.id, ctx.variantId)),
    );
    assert.deepEqual(posted.shortfalls, [
      { variantId: ctx.variantId, expected: 40, received: 36, variance: -4 },
    ]);
  });
});

test('an unauthenticated caller is refused', { skip: !sqlTestUrl() }, async () => {
  const { t1 } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'ANON'));

    await assert.rejects(
      () => withTenant(db, t1, (tdb) => submitIn(tdb, 'not-a-real-token', formFor(ctx.vendor.id, ctx.variantId))),
      /signed in|session/i,
      'a forged or absent cookie must be refused before anything is written',
    );
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => submitIn(tdb, undefined, formFor(ctx.vendor.id, ctx.variantId))),
      /signed in|session/i,
    );

    // The page's front door resolves the same way, and refuses to hand back a
    // user — so the screen cannot be rendered for a stranger.
    const door = await withTenant(db, t1, (tdb) => frontDoor(tdb, 'not-a-real-token'));
    assert.equal(door.user, null, 'the page gate resolves no user for a forged cookie');
  });
});

test('a double submit of one form posts once, and a second delivery still posts', { skip: !sqlTestUrl() }, async () => {
  const { t1, owner } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'DUP'));
    const token = await tokenFor(db, t1, owner);

    const form = formFor(ctx.vendor.id, ctx.variantId);

    const first = await withTenant(db, t1, (tdb) => submitIn(tdb, token, form));
    const second = await withTenant(db, t1, (tdb) => submitIn(tdb, token, form));

    assert.deepEqual(first.shortfalls, [
      { variantId: ctx.variantId, expected: 40, received: 36, variance: -4 },
    ]);
    assert.deepEqual(second.shortfalls, first.shortfalls, 'a retry reports the same receipt, not a second one');

    await withTenant(db, t1, async (tdb) => {
      const { rows: receipts } = await tdb.query<{ n: number }>('select count(*)::int as n from receipts');
      assert.equal(receipts[0]!.n, 1, 'a double-tap must leave exactly ONE receipt');
      const { rows: moves } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where reason = 'receipt'",
      );
      assert.equal(moves[0]!.n, 1, 'a double-tap must move the stock exactly ONCE');
      const oh = await onHand(tdb, { variantId: ctx.variantId, locationId: ctx.warehouse.id });
      assert.equal(oh[0]?.qty, '36.000', 'the warehouse holds the received quantity once');
    });

    // A GENUINELY second delivery — a new form, a new key — still posts.
    await withTenant(db, t1, (tdb) =>
      submitIn(tdb, token, formFor(ctx.vendor.id, ctx.variantId, { refNo: 'dn-8', lines: [{ variantId: ctx.variantId, expected: 10, received: 10 }] })),
    );
    await withTenant(db, t1, async (tdb) => {
      const { rows: moves } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where reason = 'receipt'",
      );
      assert.equal(moves[0]!.n, 2, 'a second delivery must post — the key is per form, not per item');
      const oh = await onHand(tdb, { variantId: ctx.variantId, locationId: ctx.warehouse.id });
      assert.equal(oh[0]?.qty, '46.000', 'both deliveries are counted');
    });
  });
});

test('a posted receipt records WHO received and WHERE the goods arrived', { skip: !sqlTestUrl() }, async () => {
  const { t1, manager } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'ACTOR'));
    const token = await tokenFor(db, t1, manager);

    const posted = await withTenant(db, t1, (tdb) =>
      submitIn(tdb, token, formFor(ctx.vendor.id, ctx.variantId, { lines: [{ variantId: ctx.variantId, expected: 5, received: 5 }] })),
    );
    assert.equal(posted.receiptId, posted.receiptId, 'the result names the receipt it wrote');

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{
        received_by: string | null;
        received_at: Date | null;
        dest_location_id: string;
        ref_no: string | null;
        source_location_id: string;
      }>('select received_by, received_at, dest_location_id, source_location_id, ref_no from receipts where id = $1', [
        posted.receiptId,
      ]);
      const row = rows[0]!;
      assert.equal(row.received_by, manager, 'who received the goods comes from the SESSION, never typed');
      assert.ok(row.received_at, 'when comes from the clock');
      assert.equal(row.dest_location_id, ctx.warehouse.id, 'the goods arrive at the warehouse — auto-filled, not asked for');
      assert.equal(row.source_location_id, ctx.vendor.id);
      assert.equal(row.ref_no, 'DN-7', 'the delivery-note number is normalised before it is stored');
    });
  });
});

test('an unreceived line stays unreceived and reports no shortfall', { skip: !sqlTestUrl() }, async () => {
  const { t1, owner } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'PART'));
    const token = await tokenFor(db, t1, owner);

    // Line a arrived (short by 1); line b has not arrived at all.
    const second = await withTenant(db, t1, (tdb) =>
      createItem(tdb, { nameAr: 'حزام', nameEn: 'Belt', family: 'sellable', sku: 'PART-B', barcode: 'PART-B' }),
    );

    const posted = await withTenant(db, t1, (tdb) =>
      submitIn(tdb, token, {
        formId: randomUUID(),
        refNo: 'dn-part',
        sourceLocationId: ctx.vendor.id,
        lines: [
          { variantId: ctx.variantId, expected: 10, received: 9 },
          { variantId: second.variant.id, expected: 20, received: null },
        ],
      }),
    );

    assert.deepEqual(
      posted.shortfalls,
      [{ variantId: ctx.variantId, expected: 10, received: 9, variance: -1 }],
      'only the line that actually arrived is reported; the unsupplied line is not a phantom shortage',
    );

    await withTenant(db, t1, async (tdb) => {
      const { rows: hdr } = await tdb.query<{ status: string }>('select status from receipts where id = $1', [
        posted.receiptId,
      ]);
      assert.equal(hdr[0]!.status, 'receiving', 'a part-received delivery stays expressible');

      const { rows } = await tdb.query<{ variant_id: string; received_qty: string | null }>(
        'select variant_id, received_qty from receipt_lines where receipt_id = $1',
        [posted.receiptId],
      );
      const untouched = rows.find((r) => r.variant_id === second.variant.id)!;
      assert.equal(untouched.received_qty, null, 'goods that have not arrived are left UNTOUCHED');
    });
  });
});

test('a reused delivery-note number is surfaced before the goods are accepted', { skip: !sqlTestUrl() }, async () => {
  const { t1, owner } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'NOTE'));
    const token = await tokenFor(db, t1, owner);

    // Nothing posted under this note yet: no warning to give.
    const before = await withTenant(db, t1, (tdb) => checkNoteIn(tdb, token, 'dn-7'));
    assert.equal(before, null, 'the first delivery under a note has no earlier receipt to warn about');

    const posted = await withTenant(db, t1, (tdb) =>
      submitIn(tdb, token, formFor(ctx.vendor.id, ctx.variantId, { lines: [{ variantId: ctx.variantId, expected: 5, received: 5 }] })),
    );

    // The PRE-CHECK — what the screen shows before the goods are accepted.
    const duplicate = await withTenant(db, t1, (tdb) => checkNoteIn(tdb, token, 'dn-7'));
    assert.ok(duplicate, 'a note already posted must be surfaced to the manager');
    assert.equal(duplicate!.receiptId, posted.receiptId);
    assert.ok(duplicate!.postedAt.length > 0, 'the warning carries when the earlier receipt was posted');

    // The warning SURFACES, it never BLOCKS: a second lorry under the same note
    // still posts (Task 6's rule, honoured by the screen).
    const second = await withTenant(db, t1, (tdb) =>
      submitIn(tdb, token, formFor(ctx.vendor.id, ctx.variantId, { lines: [{ variantId: ctx.variantId, expected: 5, received: 5 }] })),
    );
    assert.ok(second.duplicateOf, 'the second post reports the duplicate it created');
  });
});

test('the required fields are required at the moment of entry', { skip: !sqlTestUrl() }, async () => {
  const { t1, owner } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'REQ'));
    const token = await tokenFor(db, t1, owner);

    await assert.rejects(
      () => withTenant(db, t1, (tdb) => submitIn(tdb, token, formFor(ctx.vendor.id, ctx.variantId, { refNo: '  ' }))),
      /delivery-note number/i,
      'a delivery with no note number is refused — it is what the paperwork proves',
    );
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => submitIn(tdb, token, formFor(ctx.vendor.id, ctx.variantId, { sourceLocationId: '' }))),
      /sending|from/i,
      'the sending party is required — a receipt is a transfer, not an arrival from nowhere',
    );
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => submitIn(tdb, token, formFor(ctx.vendor.id, ctx.variantId, { lines: [] }))),
      /at least one/i,
      'a receipt with no lines is not a receipt',
    );
  });
});

// IMPORTANT #3: the SCREEN must be able to continue a PART delivery. `submitIn`
// reports `status` and the `outstanding` lines, so the screen keeps the form key
// and the remainder posts against the SAME receipt — not a fresh one.
test('a part delivery can be continued against the SAME receipt', { skip: !sqlTestUrl() }, async () => {
  const { t1, manager } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'CONT'));
    const outstandingItem = await withTenant(db, t1, (tdb) =>
      createItem(tdb, { nameAr: 'حزام', nameEn: 'Belt', family: 'sellable', sku: 'CONT-2', barcode: 'CONT-2' }),
    );
    const token = await tokenFor(db, t1, manager);
    const formId = randomUUID();

    // First lorry: one line arrived, one did not.
    const first = await withTenant(db, t1, (tdb) =>
      submitIn(tdb, token, {
        formId,
        refNo: 'dn-cont',
        sourceLocationId: ctx.vendor.id,
        lines: [
          { variantId: ctx.variantId, expected: 10, received: 10 },
          { variantId: outstandingItem.variant.id, expected: 20, received: null },
        ],
      }),
    );
    assert.equal(first.status, 'receiving', 'a part-received receipt reports `receiving`');
    assert.deepEqual(first.outstanding, [outstandingItem.variant.id], 'the unarrived line is named outstanding');

    // The remainder, against the SAME key the screen kept.
    const completion = await withTenant(db, t1, (tdb) =>
      submitIn(tdb, token, {
        formId,
        refNo: 'dn-cont',
        sourceLocationId: ctx.vendor.id,
        lines: [{ variantId: outstandingItem.variant.id, expected: 20, received: 18 }],
      }),
    );
    assert.equal(completion.receiptId, first.receiptId, 'the remainder posts against the SAME receipt');
    assert.equal(completion.status, 'posted', 'once every line arrived the receipt is posted');
    assert.deepEqual(completion.outstanding, []);
    assert.deepEqual(completion.shortfalls, [
      { variantId: outstandingItem.variant.id, expected: 20, received: 18, variance: -2 },
    ]);

    await withTenant(db, t1, async (tdb) => {
      const { rows: receipts } = await tdb.query<{ n: number }>('select count(*)::int as n from receipts');
      assert.equal(receipts[0]!.n, 1, 'a continued part delivery is ONE receipt, not two');
      const { rows: moves } = await tdb.query<{ n: number }>(
        "select count(*)::int as n from stock_movements where reason = 'receipt'",
      );
      assert.equal(moves[0]!.n, 2, 'the one receipt has TWO postings (one per line that arrived)');
    });
  });
});

// IMPORTANT #4: a key protects a RETRY, not a change of mind. Re-using the same
// form key with EDITED lines must be a NAMED refusal, never a silent success.
test('re-using a form key with different content is refused, not reported as success', { skip: !sqlTestUrl() }, async () => {
  const { t1, owner } = await provision();

  await withDb(async (db) => {
    const ctx = await withTenant(db, t1, (tdb) => setup(tdb, 'EDIT'));
    const token = await tokenFor(db, t1, owner);
    const formId = randomUUID();

    const form = (expected: number, received: number): ReceiptForm => ({
      formId,
      refNo: 'dn-edit',
      sourceLocationId: ctx.vendor.id,
      lines: [{ variantId: ctx.variantId, expected, received }],
    });

    await withTenant(db, t1, (tdb) => submitIn(tdb, token, form(40, 36)));

    // The SAME key, an EDITED expected quantity.
    await assert.rejects(
      () => withTenant(db, t1, (tdb) => submitIn(tdb, token, form(50, 50))),
      (err: unknown) =>
        err instanceof IntakeError && err.code === 'invalid' && err.message === CONFLICT_MESSAGE,
      'an edited resubmit must be a NAMED invalid refusal, not a silent success',
    );

    // A GENUINE retry — the identical content — still returns the stored result.
    const retry = await withTenant(db, t1, (tdb) => submitIn(tdb, token, form(40, 36)));
    assert.deepEqual(
      retry.shortfalls,
      [{ variantId: ctx.variantId, expected: 40, received: 36, variance: -4 }],
      'a retry of the same content returns the receipt’s own numbers',
    );

    await withTenant(db, t1, async (tdb) => {
      const { rows } = await tdb.query<{ n: number }>('select count(*)::int as n from receipts');
      assert.equal(rows[0]!.n, 1, 'the refused edit wrote nothing');
    });
  });
});

// IMPORTANT #5: a caller-supplied id is a GLOBAL key. Re-using an id that exists
// in ANOTHER tenant (invisible under RLS) must be refused with EXACTLY the same
// message a same-tenant content mismatch gets — the response must not be an
// existence oracle.
test('a cross-tenant id and a content mismatch are indistinguishable to the caller', { skip: !sqlTestUrl() }, async () => {
  const tenantA = await provision();
  const tenantB = await provision();

  await withDb(async (db) => {
    const aCtx = await withTenant(db, tenantA.t1, (tdb) => setup(tdb, 'XA'));
    const bCtx = await withTenant(db, tenantB.t1, (tdb) => setup(tdb, 'XB'));
    const aToken = await tokenFor(db, tenantA.t1, tenantA.owner);
    const bToken = await tokenFor(db, tenantB.t1, tenantB.owner);

    const formId = randomUUID();
    // Tenant A's receipt, carrying the supplied key.
    await withTenant(db, tenantA.t1, (tdb) =>
      submitIn(tdb, aToken, {
        formId,
        refNo: 'dn-x',
        sourceLocationId: aCtx.vendor.id,
        lines: [{ variantId: aCtx.variantId, expected: 5, received: 5 }],
      }),
    );

    const capture = async (fn: () => Promise<unknown>): Promise<IntakeError> => {
      try {
        await fn();
      } catch (err) {
        assert.ok(err instanceof IntakeError, 'the refusal must be an IntakeError');
        return err;
      }
      throw new Error('expected the call to be refused');
    };

    // Path 1: tenant B supplies A's receipt id (invisible to B — RLS).
    const crossTenant = await capture(() =>
      withTenant(db, tenantB.t1, (tdb) =>
        submitIn(tdb, bToken, {
          formId,
          refNo: 'dn-x',
          sourceLocationId: bCtx.vendor.id,
          lines: [{ variantId: bCtx.variantId, expected: 5, received: 5 }],
        }),
      ),
    );

    // Path 2: tenant A re-uses its OWN key with a different expected quantity.
    const mismatch = await capture(() =>
      withTenant(db, tenantA.t1, (tdb) =>
        submitIn(tdb, aToken, {
          formId,
          refNo: 'dn-x',
          sourceLocationId: aCtx.vendor.id,
          lines: [{ variantId: aCtx.variantId, expected: 9, received: 9 }],
        }),
      ),
    );

    assert.equal(crossTenant.code, 'invalid');
    assert.equal(mismatch.code, 'invalid');
    assert.equal(
      crossTenant.message,
      mismatch.message,
      'the cross-tenant and mismatch refusals must be INDISTINGUISHABLE — no existence oracle',
    );
    assert.equal(crossTenant.message, CONFLICT_MESSAGE);

    // Positive control: tenant B's OWN form, its own content, posts normally.
    const ok = await withTenant(db, tenantB.t1, (tdb) =>
      submitIn(tdb, bToken, {
        formId: randomUUID(),
        refNo: 'dn-y',
        sourceLocationId: bCtx.vendor.id,
        lines: [{ variantId: bCtx.variantId, expected: 5, received: 5 }],
      }),
    );
    assert.equal(ok.status, 'posted', 'a caller may still create its own receipt with its own key');
  });
});

// ---------------------------------------------------------------------------
// SMOKE CHECKS (SOURCE GREPS) — NOT GUARDS.
//
// These two tests read source text with `readFileSync` and assert on it. They
// are SMOKE CHECKS, not controls: they pass even if the code is bypassed at
// runtime (a screen that imports the gate but never calls it still greps clean),
// so they prove the *shape* of the wiring exists, never that it is exercised.
// The REAL guards are the database-backed tests above, which drive the same
// seams against Postgres. Kept (not deleted) as a cheap early warning that a
// file lost its `'use server'`/session-cookie plumbing entirely.
// ---------------------------------------------------------------------------

test('SMOKE (source grep): the intake actions still look like the app’s one session mechanism', () => {
  const actions = readFileSync(join(REPO_ROOT, 'src', 'app', 'intake', 'actions.ts'), 'utf8');

  assert.match(actions, /^'use server';/m, 'the actions module must be a server-action module');
  assert.match(actions, /export async function scan\(/, 'scan must be exported as a server action');
  assert.match(actions, /export async function submitReceipt\(/, 'submitReceipt must be exported as a server action');
  assert.match(actions, /SESSION_COOKIE/, 'the action must read the session cookie — the SAME mechanism as the rest of the app');
  assert.match(actions, /await getAppPool\(\)/, 'the action must resolve its connection through getAppPool');
  assert.match(actions, /configuredTenantId\(\)/, 'the action must scope to the deployment tenant');

  const page = readFileSync(join(REPO_ROOT, 'src', 'app', 'intake', 'page.tsx'), 'utf8');
  assert.match(page, /frontDoor\(/, 'the page must resolve who is asking before it renders the door');
  assert.match(page, /canReceive\(/, 'the page must refuse a role that may not receive goods');
  assert.match(page, /IntakeScreen/, 'the page must render the door');
  // Direction is now owned by the root layout (`dir={DIRECTION[lang]}`), so the
  // app flips RTL/LTR with the resolved language. A page hardcoding its own
  // direction would fight that switch.
  assert.doesNotMatch(page, /dir="rtl"/, 'the page must inherit its direction from the root layout');
});

test('SMOKE (source grep): the barcode field opts out of RTL, and shared form styles are reused', () => {
  const scanField = readFileSync(join(REPO_ROOT, 'src', 'modules', 'shell', 'ui', 'ScanField.tsx'), 'utf8');
  assert.match(scanField, /ltr-value/, 'the machine-read field must use the shared .ltr-value class');
  assert.match(scanField, /dir="ltr"/, 'a scanned code must never be rendered right-to-left');

  // Nothing may restyle a field locally: the look lives in globals.css alone.
  const files = [
    ['shell', 'ScanField.tsx'],
    ['receiving', 'ExpectedVsReceived.tsx'],
    ['receiving', 'IntakeScreen.tsx'],
  ] as const;
  for (const [mod, file] of files) {
    const source = readFileSync(join(REPO_ROOT, 'src', 'modules', mod, 'ui', file), 'utf8');
    assert.doesNotMatch(
      source,
      /style=\{\{/,
      `${file} must not restyle fields locally — the shared rules in globals.css are the one place`,
    );
  }
});
