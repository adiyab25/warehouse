import { isValidScannedCode, normaliseScannedCode } from '../domain/barcode.ts';
import type { Queryable } from './client.ts';
import type { Item, ItemVariant } from './types.ts';

// Re-export the GENERATED row types rather than hand-declaring copies. The
// migration is the source of truth, `src/db/types.ts` is generated from it, and
// a hand copy here would drift: add a column, regenerate, and `types.ts` gains
// it while this file's copy (the actual return type) does not — both still
// typecheck. Import + re-export makes drift impossible.
export type { Item, ItemVariant };

/** The `family` discriminator of an item, derived from the generated type. */
export type ItemFamily = Item['family'];

/**
 * The typed shape of a variant's distinguishing attributes.
 *
 * The `attrs` column is `jsonb`, so the generated row type can only say
 * `unknown` — every reader would otherwise hand-cast for size and colour and
 * drift. This names the two attributes the backbone actually keys on today;
 * {@link variantAttrs} is the one place that narrowing happens.
 */
export interface VariantAttrs {
  size?: string;
  colour?: string;
}

/**
 * Reads a variant's `attrs` as {@link VariantAttrs}.
 *
 * `attrs` is `jsonb` (generated as `unknown`), so a raw value could be a
 * string, a number, `null` or an array. The guard narrows only a real object
 * to {@link VariantAttrs} and returns `{}` for anything else — a caller never
 * has to defend against a non-object and never hand-casts.
 */
export function variantAttrs(v: ItemVariant): VariantAttrs {
  const attrs = v.attrs;
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    return attrs as VariantAttrs;
  }
  return {};
}


/** The input {@link createItem} accepts; `db` supplies the tenant. */
export interface CreateItemInput {
  nameAr: string;
  nameEn?: string;
  family: ItemFamily;
  category?: string;
  uom?: string;
  packFactor?: number;
  discrete?: boolean;
  costEgp?: number;
  supplier?: string;
  leadTimeDays?: number;
  serialised?: boolean;
  /** The variant's stock-keeping code; stored trimmed and upper-cased. */
  sku: string;
  /** The variant's scannable barcode; stored trimmed and upper-cased. */
  barcode: string;
  /** Size, colour and any other distinguishing attribute. Omitted ⇒ `{}`. */
  attrs?: Record<string, unknown>;
}

/** The input {@link setLocationLevel} accepts; `db` supplies the tenant. */
export interface SetLocationLevelInput {
  itemId: string;
  locationId: string;
  minQty?: number;
  maxQty?: number;
}

/**
 * Creates an item AND its single variant for the tenant the connection is
 * scoped to.
 *
 * An item always has exactly one variant, even when it has no size or colour:
 * the variant is created in the same call, with `attrs` defaulting to the empty
 * object rather than the call being split in two or left half-done. Every scan
 * therefore resolves to a variant, so nothing downstream special-cases the
 * "simple" products.
 *
 * `sku` and `barcode` are trimmed and upper-cased here; the database carries the
 * matching CHECK, so a value that somehow arrives un-normalised is refused
 * loudly rather than stored as a near-duplicate.
 *
 * Both codes are also validated against the SAME shape rule the scan path uses
 * ({@link isValidScannedCode}): a code that a scan would reject before lookup is
 * refused here too, so the writer can never mint a catalogue item the scanner
 * could never reach. The error names the offending field and value.
 *
 * This writes TWO rows (the item, then its variant) and is therefore NOT atomic
 * on its own: call it inside the caller's tenant-scoped transaction — the
 * `withTenant` block that scopes `app.tenant_id` — so a failure on the second
 * insert rolls the first back with it and no orphan item survives.
 *
 * The tenant is NOT a parameter: it is read from `app.tenant_id`, which
 * `withTenant` has pinned on this connection, so a caller cannot create a row
 * for a tenant it is not scoped to. Call this with the scoped `db` from inside
 * `withTenant`; never nest `withTenant` around it.
 */
export async function createItem(
  db: Queryable,
  input: CreateItemInput,
): Promise<{ item: Item; variant: ItemVariant }> {
  if (!isValidScannedCode(input.sku)) {
    throw new Error(
      `createItem: sku ${JSON.stringify(input.sku)} is not a valid scanned code ` +
        '(expected PREFIX-SEQ, e.g. AB-0012)',
    );
  }
  if (!isValidScannedCode(input.barcode)) {
    throw new Error(
      `createItem: barcode ${JSON.stringify(input.barcode)} is not a valid scanned code ` +
        '(expected PREFIX-SEQ, e.g. AB-0012)',
    );
  }

  const { rows: itemRows } = await db.query<Item>(
    `insert into items
       (tenant_id, name_ar, name_en, family, category, uom, pack_factor,
        discrete, cost_egp, supplier, lead_time_days, serialised)
     values
       (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5, $6,
        coalesce($7, true), coalesce($8, 0), $9, $10, coalesce($11, false))
     returning *`,
    [
      input.nameAr,
      input.nameEn ?? null,
      input.family,
      input.category ?? null,
      input.uom ?? 'unit',
      input.packFactor ?? null,
      input.discrete ?? null,
      input.costEgp ?? null,
      input.supplier ?? null,
      input.leadTimeDays ?? null,
      input.serialised ?? null,
    ],
  );

  const item = itemRows[0];
  if (!item) throw new Error(`createItem: no item row returned for sku ${input.sku}`);

  const { rows: variantRows } = await db.query<ItemVariant>(
    `insert into item_variants (tenant_id, item_id, sku, barcode, attrs)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4::jsonb)
     returning *`,
    [
      item.id,
      normaliseScannedCode(input.sku),
      normaliseScannedCode(input.barcode),
      JSON.stringify(input.attrs ?? {}),
    ],
  );

  const variant = variantRows[0];
  if (!variant) throw new Error(`createItem: no variant row returned for sku ${input.sku}`);

  return { item, variant };
}

/**
 * Looks a variant up by its scanned code, scoped to the current tenant.
 *
 * The code is normalised first (trimmed and upper-cased), so a scan that
 * arrived padded or lower-cased still matches the canonical row. A code that
 * matches nothing returns `null` — this is a pure read and NEVER creates an
 * item, which is what keeps a mistyped barcode from minting a row.
 *
 * A DEACTIVATED item or variant resolves to `null` too: Review Focus #1 says a
 * label that has been turned off must behave exactly like an unknown code. The
 * query joins `items` and requires BOTH `items.active` and
 * `item_variants.active`, so turning either off hides the scan without deleting
 * a row (and without inventing a distinct error the callers would have to
 * handle).
 *
 * Call it with the scoped `db` from inside `withTenant`.
 */
export async function findByBarcode(db: Queryable, code: string): Promise<ItemVariant | null> {
  const { rows } = await db.query<ItemVariant>(
    `select v.*
       from item_variants v
       join items i
         on i.id = v.item_id
        and i.tenant_id = v.tenant_id
      where v.barcode = $1
        and v.active
        and i.active
        and v.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`,
    [normaliseScannedCode(code)],
  );
  return rows[0] ?? null;
}

/**
 * Sets (or updates) the min/max level for one (item, location) pair in the
 * current tenant.
 *
 * Upserts on the `unique (tenant_id, item_id, location_id)` index, so calling it
 * twice for the same pair updates the one row rather than racing a second into
 * existence. An omitted `minQty`/`maxQty` is stored as NULL — "no bound on this
 * side" — not as 0, which is a real, different level. Call it with the scoped
 * `db` from inside `withTenant`.
 */
export async function setLocationLevel(db: Queryable, input: SetLocationLevelInput): Promise<void> {
  await db.query(
    `insert into location_levels (tenant_id, item_id, location_id, min_qty, max_qty)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4)
     on conflict (tenant_id, item_id, location_id)
     do update set min_qty = excluded.min_qty, max_qty = excluded.max_qty`,
    [input.itemId, input.locationId, input.minQty ?? null, input.maxQty ?? null],
  );
}
