#!/usr/bin/env node
/**
 * MOCK DATA for trying the app out — branches, uniforms, consumables and opening
 * stock. Additive and IDEMPOTENT: run it once, run it again, nothing doubles.
 *
 *   APP_DATABASE_URL=postgresql://authenticated@…/warehouse \
 *   TENANT_ID=<tenant uuid> \
 *     node --import tsx scripts/seed-mock.mjs
 *
 * WHAT IT MAKES
 *   14 branches, BR-01…BR-14, named "Branch 1"…"Branch 14" (فرع 1 … فرع 14).
 *   Uniforms (category `Uniforms`, family `sellable`) with a SIZE on every
 *   variant — KG1 T-shirt / Pants / Sweatshirt / P.E. kit / cap.
 *   Consumables (tissue, soap, sanitiser, gloves, bin bags, A4 paper).
 *   Assets (chair, table, projector).
 *   Opening stock in the warehouse for every variant, plus a little stock at
 *   BR-01 and BR-02 so the branch screens have something to show, and minimum
 *   levels on a few items so the replenishment report is not empty.
 *
 * HOW IT STAYS SAFE TO RE-RUN
 *   * A variant is found by BARCODE, and only created when it is not there.
 *   * Every opening movement carries a fixed `idempotencyKey`
 *     (`mock-opening:<sku>`), so the LEDGER ITSELF refuses the duplicate — the
 *     second run reports "deduped" instead of doubling the stock.
 *   * Locations upsert on `(tenant_id, code)`, so a re-run only aligns names.
 *
 * WHAT IT NEVER DOES
 *   No deletes, no updates to real movements, no new tenant, no password, and
 *   nothing outside the tenant named by TENANT_ID. It runs as the APP role, so
 *   RLS applies exactly as it does in the product.
 */

import { createAppPool } from '../src/modules/platform/service.ts';
import { withTenant } from '../src/modules/platform/db.ts';
import { createItem, setLocationLevel } from '../src/modules/catalog/db.ts';
import { postMovement } from '../src/modules/ledger/db.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const pad = (n) => String(n).padStart(2, '0');

/** [code, Arabic name, English name] — 14 branches, numbered. */
export function branchPlan() {
  return Array.from({ length: 14 }, (_, i) => [
    `BR-${pad(i + 1)}`,
    `فرع ${i + 1}`,
    `Branch ${i + 1}`,
  ]);
}

/**
 * [sku, Arabic name, English name, family, uom, packFactor, costEGP, attrs, qtyAtWarehouse]
 *
 * `attrs` is what the screen shows as the size — it is stored on the VARIANT,
 * which is what a barcode resolves to.
 */
export function itemPlan() {
  const uniforms = [
    ['UNI-KG1-TS-S', 'تي شيرت KG1 (S)', 'KG1 T-shirt (S)', 'S', 90],
    ['UNI-KG1-TS-M', 'تي شيرت KG1 (M)', 'KG1 T-shirt (M)', 'M', 120],
    ['UNI-KG1-TS-L', 'تي شيرت KG1 (L)', 'KG1 T-shirt (L)', 'L', 70],
    ['UNI-KG1-PN-S', 'بنطلون KG1 (S)', 'KG1 Pants (S)', 'S', 85],
    ['UNI-KG1-PN-M', 'بنطلون KG1 (M)', 'KG1 Pants (M)', 'M', 110],
    ['UNI-KG1-PN-L', 'بنطلون KG1 (L)', 'KG1 Pants (L)', 'L', 60],
    ['UNI-KG1-SW-M', 'سويت شيرت KG1 (M)', 'KG1 Sweatshirt (M)', 'M', 45],
    ['UNI-KG1-SW-L', 'سويت شيرت KG1 (L)', 'KG1 Sweatshirt (L)', 'L', 40],
    ['UNI-KG1-PE-M', 'طقم رياضة KG1 (M)', 'KG1 P.E. kit (M)', 'M', 55],
    ['UNI-KG1-CAP', 'كاب KG1', 'KG1 Cap', 'one size', 30],
  ].map(([sku, nameAr, nameEn, size, qty]) => ({
    sku,
    nameAr,
    nameEn,
    family: 'sellable',
    category: 'Uniforms',
    uom: 'unit',
    costEgp: 180,
    attrs: { size },
    qty,
  }));

  const consumables = [
    ['CON-TIS-01', 'مناديل ورقية', 'Tissue box', 'box', 6, 28, 240],
    ['CON-SOP-01', 'صابون سائل', 'Liquid soap', 'bottle', 6, 35, 180],
    ['CON-SAN-01', 'مطهر يدين', 'Hand sanitiser', 'bottle', 12, 22, 300],
    ['CON-GLV-01', 'قفازات', 'Gloves', 'pair', 100, 3.5, 900],
    ['CON-BAG-01', 'أكياس قمامة', 'Bin bags', 'roll', 10, 18, 120],
    ['CON-PPR-01', 'ورق طباعة A4', 'A4 paper', 'ream', 5, 120, 60],
  ].map(([sku, nameAr, nameEn, uom, packFactor, costEgp, qty]) => ({
    sku,
    nameAr,
    nameEn,
    family: 'consumable',
    category: 'Consumables',
    uom,
    packFactor,
    costEgp,
    attrs: {},
    qty,
  }));

  const assets = [
    ['AST-CHR-01', 'كرسي أطفال', 'Child chair', 24, 450],
    ['AST-TBL-01', 'طاولة نشاط', 'Activity table', 8, 900],
    ['AST-PRJ-01', 'جهاز عرض', 'Projector', 2, 8500],
  ].map(([sku, nameAr, nameEn, qty, costEgp]) => ({
    sku,
    nameAr,
    nameEn,
    family: 'asset',
    category: 'Assets',
    uom: 'unit',
    costEgp,
    attrs: {},
    qty,
  }));

  return [...uniforms, ...consumables, ...assets];
}

/** Minimum levels, so the replenishment screen has something to say. */
export const MIN_LEVELS = {
  'UNI-KG1-TS-M': 50,
  'UNI-KG1-PN-M': 50,
  'CON-SAN-01': 100,
  'CON-PPR-01': 30,
};

/**
 * A little stock at two branches, so a branch's own screens are not empty.
 * `transfer` is how it got there in the story; the ledger only needs the row.
 */
export const BRANCH_STOCK = [
  ['UNI-KG1-TS-S', 'BR-01', 8],
  ['UNI-KG1-TS-M', 'BR-01', 10],
  ['UNI-KG1-PN-M', 'BR-02', 6],
  ['CON-TIS-01', 'BR-02', 12],
];

async function main() {
  const url = process.env.APP_DATABASE_URL;
  const tenantId = process.env.TENANT_ID;
  if (!url) throw new Error('seed-mock: APP_DATABASE_URL is not set (the app role, not the owner)');
  if (!tenantId) throw new Error('seed-mock: TENANT_ID is not set');

  const pool = await createAppPool(url);
  const summary = { branches: 0, items: 0, movements: 0, deduped: 0, levels: 0, skipped: [] };

  try {
    await withTenant(pool, tenantId, async (db) => {
      // --- 1. branches -------------------------------------------------
      for (const [code, nameAr, nameEn] of branchPlan()) {
        const { rowCount } = await db.query(
          `insert into locations (tenant_id, code, name_ar, name_en, type)
           values (${TENANT}, $1, $2, $3, 'branch')
           on conflict (tenant_id, code) do update
             set name_ar = excluded.name_ar,
                 name_en = excluded.name_en,
                 active = true`,
          [code, nameAr, nameEn],
        );
        summary.branches += rowCount ?? 0;
      }

      // --- 2. the warehouse, and who signs the movements ----------------
      const { rows: warehouses } = await db.query(
        `select id from locations where tenant_id = ${TENANT} and type = 'warehouse' order by code limit 1`,
      );
      const warehouse = warehouses[0];
      if (!warehouse) throw new Error('seed-mock: this tenant has no warehouse location — run `npm run seed` first');

      const actorName = process.env.MOCK_ACTOR ?? 'admin';
      const { rows: actors } = await db.query(
        `select id from app_users
          where tenant_id = ${TENANT} and username = $1 and active
            and role in ('owner', 'warehouse_manager')
          limit 1`,
        [actorName],
      );
      let actor = actors[0]?.id;
      if (!actor) {
        const { rows: fallback } = await db.query(
          `select id from app_users
            where tenant_id = ${TENANT} and active and role in ('owner', 'warehouse_manager')
            order by (role = 'owner') desc, created_at limit 1`,
        );
        actor = fallback[0]?.id;
      }
      if (!actor) throw new Error('seed-mock: no active owner/warehouse manager to sign the opening movements');

      const { rows: branchRows } = await db.query(
        `select code, id from locations where tenant_id = ${TENANT} and type = 'branch'`,
      );
      const branchByCode = new Map(branchRows.map((row) => [row.code, row.id]));

      // --- 3. items + opening stock ------------------------------------
      for (const item of itemPlan()) {
        // A variant is the unit of stock; its barcode is how we know it exists.
        const { rows: existing } = await db.query(
          `select id from item_variants where tenant_id = ${TENANT} and barcode = $1`,
          [item.sku],
        );

        let variantId = existing[0]?.id;
        let itemId;
        if (variantId) {
          const { rows: owned } = await db.query(
            `select item_id from item_variants where id = $1`,
            [variantId],
          );
          itemId = owned[0]?.item_id;
          summary.skipped.push(item.sku);
        } else {
          const created = await createItem(db, {
            nameAr: item.nameAr,
            nameEn: item.nameEn,
            family: item.family,
            category: item.category,
            uom: item.uom,
            packFactor: item.packFactor,
            costEgp: item.costEgp,
            sku: item.sku,
            barcode: item.sku,
            attrs: item.attrs,
          });
          variantId = created.variant.id;
          itemId = created.item.id;
          summary.items += 1;
        }

        const posted = await postMovement(db, {
          variantId,
          qty: item.qty,
          reason: 'opening_balance',
          toLocationId: warehouse.id,
          actorUserId: actor,
          // THE guard that makes a re-run harmless: the same key lands once.
          idempotencyKey: `mock-opening:${item.sku}`,
          refType: 'MOCK-SEED',
          notes: 'Mock opening balance (seed-mock)',
        });
        if (posted.deduped) summary.deduped += 1;
        else summary.movements += 1;

        if (MIN_LEVELS[item.sku] !== undefined && itemId) {
          await setLocationLevel(db, {
            itemId,
            locationId: warehouse.id,
            minQty: MIN_LEVELS[item.sku],
          });
          summary.levels += 1;
        }
      }

      // --- 4. a little branch stock ------------------------------------
      for (const [sku, branchCode, qty] of BRANCH_STOCK) {
        const branchId = branchByCode.get(branchCode);
        if (!branchId) continue;
        const { rows: variant } = await db.query(
          `select id from item_variants where tenant_id = ${TENANT} and barcode = $1`,
          [sku],
        );
        if (!variant[0]) continue;
        const posted = await postMovement(db, {
          variantId: variant[0].id,
          qty,
          reason: 'opening_balance',
          toLocationId: branchId,
          actorUserId: actor,
          idempotencyKey: `mock-opening:${sku}:${branchCode}`,
          refType: 'MOCK-SEED',
          notes: 'Mock branch opening (seed-mock)',
        });
        if (posted.deduped) summary.deduped += 1;
        else summary.movements += 1;
      }
    });
  } finally {
    await pool.end();
  }

  console.log('seed-mock: done');
  console.table({
    branches_upserted: summary.branches,
    items_created: summary.items,
    movements_posted: summary.movements,
    already_there: summary.deduped + summary.skipped.length,
    min_levels_set: summary.levels,
  });
  if (summary.skipped.length) {
    console.log(`seed-mock: ${summary.skipped.length} item(s) already existed and were left alone`);
  }
}

main().catch((err) => {
  console.error(`seed-mock: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
