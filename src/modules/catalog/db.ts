import { isValidScannedCode, normaliseScannedCode } from './schema.ts';
import type { Queryable } from '@/modules/platform/index';
import type { Item, ItemVariant } from '@/modules/platform/index';

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
        coalesce($7, true), coalesce($8::numeric, 0), $9, $10, coalesce($11, false))
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
 * Looks a variant up by its scanned code, scoped to the current tenant, and
 * returns the variant TOGETHER WITH the item's Arabic name.
 *
 * The code is normalised first (trimmed and upper-cased), so a scan that
 * arrived padded or lower-cased still matches the canonical row. A code that
 * matches nothing returns `null` — this is a pure read and NEVER creates an
 * item, which is what keeps a mistyped barcode from minting a row.
 *
 * The NAME comes back with the variant, from ONE query, exactly as
 * {@link findVariantById} returns it: a person at the door confirms WHAT
 * resolved, and `AB-0012` alone does not tell them it is the shirt they ordered.
 * The two readers therefore agree in shape — `{ variant, itemNameAr }`.
 *
 * A DEACTIVATED item or variant resolves to `null` too: Review Focus #1 says a
 * label that has been turned off must behave exactly like an unknown code, and
 * it must therefore return NO name either. The query joins `items` and requires
 * BOTH `items.active` and `item_variants.active`, so turning either off hides
 * the scan without deleting a row (and without inventing a distinct error the
 * callers would have to handle).
 *
 * Call it with the scoped `db` from inside `withTenant`.
 */
export async function findByBarcode(
  db: Queryable,
  code: string,
): Promise<{ variant: ItemVariant; itemNameAr: string } | null> {
  const { rows } = await db.query<ItemVariant & { item_name_ar: string }>(
    `select v.*, i.name_ar as item_name_ar
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
  const row = rows[0];
  if (!row) return null;

  const { item_name_ar: itemNameAr, ...variant } = row;
  return { variant, itemNameAr };
}

/**
 * Looks a variant up by its primary key, scoped to the current tenant, and
 * returns the variant TOGETHER WITH the item's Arabic name.
 *
 * A label needs both halves at once — the item's Arabic name and the variant's
 * SKU/barcode/attrs — so they come back from ONE query rather than two reads
 * that a delete could slip between. `active` is required on BOTH the item and
 * the variant, exactly as {@link findByBarcode} requires it: a label for a
 * deactivated product must behave like a label for one that does not exist.
 *
 * A variant the caller cannot see — another tenant's, or a missing id — is
 * `null`, never an error. Call it with the scoped `db` from inside `withTenant`.
 */
export async function findVariantById(
  db: Queryable,
  id: string,
): Promise<{ variant: ItemVariant; itemNameAr: string } | null> {
  const { rows } = await db.query<ItemVariant & { item_name_ar: string }>(
    `select v.*, i.name_ar as item_name_ar
       from item_variants v
       join items i
         on i.id = v.item_id
        and i.tenant_id = v.tenant_id
      where v.id = $1
        and v.active
        and i.active
        and v.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  const { item_name_ar: itemNameAr, ...variant } = row;
  return { variant, itemNameAr };
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
import { SESSION_COOKIE } from '@/modules/auth/schema';
import { currentUser } from '@/modules/auth/index';
import { configuredTenantId } from '@/modules/auth/index';
import { getAppPool } from '@/modules/platform/index';
import { withTenant } from '@/modules/platform/index';
import { findLocationById } from '@/modules/locations/index';
import { locationLabelSvg, variantLabelSvg } from './schema.ts';

/**
 * The label endpoints' logic, shared by the two thin route files.
 *
 * WHY THIS IS NOT INLINE IN `route.ts`: both labels resolve a caller and read a
 * row inside ONE `withTenant` boundary, and copying that gate into two routes is
 * exactly how one of them ends up with the check quietly dropped. There is one
 * gate here; both routes call it.
 *
 * ---- THE GATE ---------------------------------------------------------------
 * A label route is PUBLIC-ISH and easy to forget: it returns a picture, so it
 * feels harmless — but an open label endpoint is a catalogue ENUMERATOR. Anyone
 * who can walk `variantId` can mine every product's name and SKU, and anyone who
 * can walk `locationId` learns the shelf layout. So a label is fetched with a
 * session, resolved by the SAME mechanism as the rest of the app:
 * {@link currentUser} over the request's {@link SESSION_COOKIE}, inside the one
 * `withTenant` scope that also does the read. An unauthenticated request never
 * reaches a row — it is refused with 401.
 *
 * WHY THE ROUTES RETURN A PLAIN `Response` AND NOT `NextResponse`: nothing here
 * needs a Next-specific response, and a standard `Response` keeps the route
 * importable and driven directly by a test (`node --test`), which is how the
 * unauthenticated and 404 paths are proven rather than assumed.
 *
 * `withTenant` is NOT re-entrant and the pool is `await getAppPool()` (Task 11b):
 * one boundary per request, opened here, never nested.
 */

/** The session cookie's value from a request's `Cookie` header, or `undefined`. */
function sessionCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/**
 * The code, reduced to a filename fragment safe to put in a header value.
 *
 * A `Content-Disposition` filename is a header — a code containing a CR, a
 * quote or a path separator could split the header or steer the save dialog, and
 * a stored code is caller-influenced. Everything outside `[A-Za-z0-9._-]` is
 * dropped, and an empty result falls back to `label`.
 */
function safeFilename(code: string): string {
  const cleaned = code.replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned === '' ? 'label' : cleaned;
}

/** An SVG body with the media type a browser and a printer both expect. */
function svgResponse(svg: string, code: string): Response {
  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `inline; filename="label-${safeFilename(code)}.svg"`,
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Answers `GET /api/labels/variant/[variantId]` — the printable variant label.
 *
 * 401 when there is no live session, 404 when the id resolves to nothing the
 * caller may see, 400 when a row is somehow unusable as a label (a blank
 * barcode, a code too long to print), 200 with `image/svg+xml` otherwise.
 *
 * THE AUTH GATE IS FIRST. An earlier version answered an empty id with a 400
 * BEFORE it looked at the session, which let an anonymous caller tell a missing
 * id (400) from a well-formed one (401) — a shape oracle on a public endpoint.
 * The gate is now the very first thing inside the request.
 */
export async function variantLabelResponse(request: Request, variantId: string): Promise<Response> {
  return withTenant(await getAppPool(), configuredTenantId(), async (db) => {
    const user = await currentUser(db, sessionCookie(request));
    if (!user) return new Response('unauthenticated', { status: 401 });

    if (!variantId) return new Response('missing variant id', { status: 400 });

    const found = await findVariantById(db, variantId);
    if (!found) return new Response('no such variant', { status: 404 });

    const attrs = variantAttrs(found.variant);
    let svg: string;
    try {
      svg = variantLabelSvg({
        nameAr: found.itemNameAr,
        size: attrs.size,
        colour: attrs.colour,
        barcode: found.variant.barcode,
        // The internal code too: `item_variants.sku` is a SEPARATE column that
        // may differ from `barcode`, and the label prints it when it does.
        sku: found.variant.sku,
      });
    } catch {
      // A stored row with no usable barcode, or a code too long to print in
      // full, is not a label (see domain/labels.ts).
      return new Response('label cannot be rendered', { status: 400 });
    }

    return svgResponse(svg, found.variant.barcode);
  });
}

/**
 * Answers `GET /api/labels/location/[locationId]` — the printable location
 * label. Same gate (first) and same status meanings as
 * {@link variantLabelResponse}.
 */
export async function locationLabelResponse(request: Request, locationId: string): Promise<Response> {
  return withTenant(await getAppPool(), configuredTenantId(), async (db) => {
    const user = await currentUser(db, sessionCookie(request));
    if (!user) return new Response('unauthenticated', { status: 401 });

    if (!locationId) return new Response('missing location id', { status: 400 });

    const location = await findLocationById(db, locationId);
    if (!location) return new Response('no such location', { status: 404 });

    let svg: string;
    try {
      svg = locationLabelSvg({ nameAr: location.name_ar, code: location.code });
    } catch {
      return new Response('label cannot be rendered', { status: 400 });
    }

    return svgResponse(svg, location.code);
  });
}
