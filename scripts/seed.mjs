#!/usr/bin/env node
/**
 * Seed (Task 20): ONE demo-style tenant — a warehouse, 14 branches, the transit /
 * scrap / quarantine pseudo-locations, a vendor, users, and a handful of items of
 * every family with real opening balances.
 *
 *   SEED_OWNER_PASSWORD=... SEED_MANAGER_PASSWORD=... SEED_BRANCH_PASSWORD=... \
 *     npm run seed -- [--name "Demo Kindergarten"]
 *
 * TWO CONNECTIONS, TWO JOBS. The OWNER connection (MIGRATE_DATABASE_URL) is used
 * ONLY to create the tenant, its users and its locations (the app role cannot
 * create a tenant by design). Everything else — items, opening balances, levels —
 * goes through the NON-owner app role (APP_DATABASE_URL, a superuser/BYPASSRLS
 * role is refused) and the real opening-balance importer, so the seed exercises
 * the production import path and every balance is a ledger row with an actor.
 *
 * NO PASSWORDS ARE STORED OR PRINTED. All three come from the environment, each
 * at least 12 characters; a missing/short one refuses BEFORE any connection is
 * opened. There is no default and nothing is generated. Connection strings are
 * never printed.
 *
 * IDEMPOTENT AND TENANT-EXPLICIT. `tenants` has no unique key, so the seed's key
 * is the exact tenant NAME (`--name`). A re-run with the same name finds its own
 * tenant (and reports "already seeded"); TWO tenants with that name, the demo
 * tenant, or a same-named tenant that is not shaped like a seed tenant are all
 * REFUSED. Pick a unique name. No other tenant is ever read for data or written.
 *
 * Exit codes: 0 seeded / already seeded, 1 refused or failed, 2 bad command line.
 */
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { hashPassword } from '../src/auth/password.ts';
import { createAppPool } from '../src/db/app-pool.ts';
import { withTenant } from '../src/db/client.ts';
import { setLocationLevel } from '../src/db/items.ts';
import { escapeUnsafe, runOpeningImport } from '../src/import/opening.ts';

export const DEFAULT_NAME = 'Demo Kindergarten';
export const DEMO_TENANT_ID = '11111111-2222-3333-4444-555555555555';
export const MIN_PASSWORD = 12;

const BRANCH_NAMES = [
  'المعادي', 'مدينة نصر', 'الزمالك', 'المهندسين', 'الدقي', 'التجمع الخامس', 'الشيخ زايد',
  'السادس من أكتوبر', 'مصر الجديدة', 'حلوان', 'الإسكندرية', 'طنطا', 'المنصورة', 'أسيوط',
];

const pad = (n) => String(n).padStart(2, '0');

/** The fixed location list: [code, Arabic name, English name, type]. */
export function locationPlan() {
  const out = [['WH-01', 'المستودع الرئيسي', 'Main warehouse', 'warehouse']];
  BRANCH_NAMES.forEach((n, i) => out.push([`BR-${pad(i + 1)}`, `فرع ${n}`, `Branch ${pad(i + 1)}`, 'branch']));
  out.push(
    ['TRANSIT', 'في الطريق', 'In transit', 'transit'],
    ['SCRAP', 'التالف', 'Scrap', 'scrap'],
    ['QUARANTINE', 'الحجر', 'Quarantine', 'quarantine'],
    ['VENDOR-01', 'المصنع', 'Factory', 'vendor'],
  );
  return out;
}

/** The users: [username, Arabic display name, role, branch code | null, password key]. */
export function userPlan() {
  const out = [
    ['owner', 'مالك النظام', 'owner', null, 'owner'],
    ['manager', 'مدير المستودع', 'warehouse_manager', null, 'manager'],
  ];
  for (let i = 1; i <= 14; i++) out.push([`branch${pad(i)}`, `مسؤول فرع ${pad(i)}`, 'branch_user', `BR-${pad(i)}`, 'branch']);
  return out;
}

/** Items: [sku, Arabic name, family, uom, pack, cost, location, qty]. Barcode = sku. */
const ITEMS = [
  ['NTB-0001', 'دفتر مدرسي ١٠٠ ورقة', 'sellable', 'unit', 1, '12.50', 'WH-01', '500'],
  ['NTB-0001', 'دفتر مدرسي ١٠٠ ورقة', 'sellable', 'unit', 1, '12.50', 'BR-01', '20'],
  ['BAG-0001', 'حقيبة مدرسية', 'sellable', 'unit', 1, '150.00', 'WH-01', '120'],
  ['RIC-0001', 'أرز مصري', 'sellable', 'kg', 25, '32.75', 'WH-01', '150.5'],
  ['PEN-0001', 'قلم حبر أزرق', 'consumable', 'unit', 12, '5.50', 'WH-01', '240'],
  ['PPR-0001', 'ورق تصوير A4', 'consumable', 'ream', 5, '120.50', 'WH-01', '40'],
  ['SOP-0001', 'صابون سائل', 'consumable', 'unit', 6, '25.00', 'WH-01', '60'],
  ['FAB-0001', 'قماش قطني', 'consumable', 'متر', 1, '80.00', 'WH-01', '120.5'],
  ['CHR-0001', 'كرسي أطفال', 'asset', 'unit', 1, '450.00', 'WH-01', '30'],
  ['TBL-0001', 'طاولة نشاط', 'asset', 'unit', 1, '900.00', 'WH-01', '10'],
  ['PRJ-0001', 'جهاز عرض', 'asset', 'unit', 1, '8500.00', 'WH-01', '2'],
];
/** Minimum levels at the warehouse (some items only, on purpose). */
const MIN_LEVELS = { 'NTB-0001': 100, 'PEN-0001': 100, 'PPR-0001': 20, 'RIC-0001': 50, 'SOP-0001': 20 };

/** The importer's CSV, generated in code (docs/opening-sample.csv format). */
export function openingCsv() {
  const head = 'sku,name_ar,family,uom,pack_factor,cost_egp,location_code,qty';
  return Buffer.from([head, ...ITEMS.map((r) => r.join(','))].join('\n') + '\n', 'utf8');
}

/** Refuses a missing / short password BEFORE anything connects. Never echoes one. */
export function readPasswords(env = process.env) {
  const out = {};
  const bad = [];
  for (const [key, name] of [['owner', 'SEED_OWNER_PASSWORD'], ['manager', 'SEED_MANAGER_PASSWORD'], ['branch', 'SEED_BRANCH_PASSWORD']]) {
    const v = env[name];
    if (typeof v !== 'string' || v.length < MIN_PASSWORD) bad.push(name);
    else out[key] = v;
  }
  if (bad.length) {
    throw new Error(`refusing to seed: ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} missing or shorter than ${MIN_PASSWORD} characters (no default exists)`);
  }
  return out;
}

async function assertOwnerConnection(c) {
  const { rows } = await c.query(
    `select r.rolsuper or r.rolbypassrls as bypass,
            exists (select 1 from pg_class k where k.relname = 'tenants' and k.relnamespace = 'public'::regnamespace
                     and pg_get_userbyid(k.relowner) = current_user) as owns
       from pg_roles r where r.rolname = current_user`,
  );
  if (!rows[0] || !(rows[0].bypass || rows[0].owns)) {
    throw new Error('refusing to seed: MIGRATE_DATABASE_URL is not the database OWNER role (it cannot create a tenant)');
  }
}

async function counts(c, tenantId) {
  const one = async (sql) => Number((await c.query(sql, [tenantId])).rows[0].n);
  return {
    warehouses: await one(`select count(*) n from locations where tenant_id=$1 and type='warehouse'`),
    branches: await one(`select count(*) n from locations where tenant_id=$1 and type='branch'`),
    pseudo: await one(`select count(*) n from locations where tenant_id=$1 and type in ('transit','scrap','quarantine')`),
    vendors: await one(`select count(*) n from locations where tenant_id=$1 and type='vendor'`),
    users: await one(`select count(*) n from app_users where tenant_id=$1`),
    sellable: await one(`select count(*) n from items where tenant_id=$1 and family='sellable'`),
    consumable: await one(`select count(*) n from items where tenant_id=$1 and family='consumable'`),
    asset: await one(`select count(*) n from items where tenant_id=$1 and family='asset'`),
    movements: await one(`select count(*) n from stock_movements where tenant_id=$1`),
  };
}

/**
 * Seeds (or completes) the tenant called `name`. `passwords` = {owner, manager, branch}.
 * Returns { tenantId, alreadySeeded, counts }. Throws (a one-line message) on any refusal.
 */
export async function seedTenant({ ownerUrl, appUrl, name, passwords }) {
  if (typeof name !== 'string' || name.trim() === '' || name.length > 120) throw new Error('refusing to seed: --name must be 1-120 characters');
  const appPool = await createAppPool(appUrl); // refuses a superuser / BYPASSRLS role
  const owner = new pg.Client({ connectionString: ownerUrl });
  let tenantId;
  let created = 0;
  try {
    await owner.connect();
    await assertOwnerConnection(owner);

    // Hash first (slow, no transaction open). One hash per distinct password.
    const hashes = {};
    for (const k of ['owner', 'manager', 'branch']) hashes[k] = await hashPassword(passwords[k]);

    await owner.query('begin');
    try {
      await owner.query(`select pg_advisory_xact_lock(hashtext('seed-tenant:' || $1))`, [name]);
      const found = await owner.query('select id from tenants where name = $1', [name]);
      if (found.rows.length > 1) throw new Error('refusing to seed: more than one tenant has this name — use a unique --name');
      if (found.rows.length === 1) {
        tenantId = found.rows[0].id;
        if (tenantId === DEMO_TENANT_ID) throw new Error('refusing to seed: that name belongs to the demo tenant, which the seed never touches');
        const shape = await owner.query(
          `select (select count(*) from app_users where tenant_id=$1 and username='owner' and role='owner') as u,
                  (select count(*) from locations where tenant_id=$1 and code='WH-01') as l`,
          [tenantId],
        );
        if (Number(shape.rows[0].u) !== 1 || Number(shape.rows[0].l) !== 1) {
          throw new Error('refusing to seed: a tenant with this name exists but is not a seed tenant — use a unique --name');
        }
      } else {
        tenantId = (await owner.query('insert into tenants (name) values ($1) returning id', [name])).rows[0].id;
        created++;
      }

      const locIds = new Map();
      for (const [code, nameAr, nameEn, type] of locationPlan()) {
        const ins = await owner.query(
          `insert into locations (tenant_id, code, name_ar, name_en, type) values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, code) do nothing returning id`,
          [tenantId, code, nameAr, nameEn, type],
        );
        created += ins.rowCount;
        const row = await owner.query('select id, type from locations where tenant_id=$1 and code=$2', [tenantId, code]);
        if (row.rows[0].type !== type) throw new Error(`refusing to seed: location ${code} exists with a different type`);
        locIds.set(code, row.rows[0].id);
      }
      for (const [username, display, role, branch, pw] of userPlan()) {
        const ins = await owner.query(
          `insert into app_users (tenant_id, name, name_normalised, username, role, branch_location_id, password_hash)
           values ($1, $2, public.normalise_name($2), $3, $4, $5, $6)
           on conflict (tenant_id, username) do nothing returning id`,
          [tenantId, display, username, role, branch ? locIds.get(branch) : null, hashes[pw]],
        );
        created += ins.rowCount;
      }
      await owner.query('commit');
    } catch (err) {
      await owner.query('rollback').catch(() => {});
      throw err;
    }

    // From here on: the app role only, through the real importer.
    const result = await runOpeningImport(appPool, {
      tenantId,
      username: 'owner',
      fileName: 'seed-opening.csv',
      apply: true,
      readInput: () => openingCsv(),
    });
    if (!result.ok) {
      throw new Error('seed import failed: ' + result.errors.slice(0, 3).map((e) => escapeUnsafe(e.message ?? JSON.stringify(e))).join(' | '));
    }
    created += result.itemsToCreate + result.movementsToPost;

    await withTenant(appPool, tenantId, async (db) => {
      for (const [sku, minQty] of Object.entries(MIN_LEVELS)) {
        const { rows } = await db.query(`select item_id from item_variants where sku = $1`, [sku]);
        const wh = await db.query(`select id from locations where code = 'WH-01'`);
        await setLocationLevel(db, { itemId: rows[0].item_id, locationId: wh.rows[0].id, minQty });
      }
    });

    return { tenantId, alreadySeeded: created === 0, counts: await counts(owner, tenantId) };
  } finally {
    await owner.end().catch(() => {});
    await appPool.end().catch(() => {});
  }
}

function parseArgs(argv) {
  const out = { name: DEFAULT_NAME };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = argv[i].split(/=(.*)/s, 2);
    if (k === '--name') out.name = v !== undefined ? v : argv[++i];
    else if (k === '--help' || k === '-h') out.help = true;
    else throw new Error(`unknown option ${escapeUnsafe(String(k)).slice(0, 80)}`);
  }
  return out;
}

async function main() {
  const USAGE =
    'usage: SEED_OWNER_PASSWORD=.. SEED_MANAGER_PASSWORD=.. SEED_BRANCH_PASSWORD=.. npm run seed -- [--name "Demo Kindergarten"]\n' +
    '  needs MIGRATE_DATABASE_URL (owner, creates the tenant) and APP_DATABASE_URL (non-owner app role)';
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const passwords = readPasswords();
    const ownerUrl = process.env.MIGRATE_DATABASE_URL?.trim();
    const appUrl = process.env.APP_DATABASE_URL?.trim();
    if (!ownerUrl || !appUrl) throw new Error('refusing to seed: MIGRATE_DATABASE_URL and APP_DATABASE_URL must both be set');
    const r = await seedTenant({ ownerUrl, appUrl, name: args.name, passwords });
    const c = r.counts;
    console.log(r.alreadySeeded ? 'already seeded — nothing changed' : 'seeded');
    console.log(`tenant: ${escapeUnsafe(args.name)}  id: ${r.tenantId}`);
    console.log(`locations: ${c.warehouses} warehouse, ${c.branches} branches, ${c.pseudo} pseudo (TRANSIT/SCRAP/QUARANTINE), ${c.vendors} vendor`);
    console.log(`items: ${c.sellable} sellable, ${c.consumable} consumable, ${c.asset} asset; opening movements: ${c.movements}`);
    console.log(`users: ${c.users} (owner, manager, branch01..branch14) — passwords come from the SEED_*_PASSWORD variables`);
    return 0;
  } catch (err) {
    console.error(escapeUnsafe(err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
