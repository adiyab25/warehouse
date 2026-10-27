import type { Queryable } from './client.ts';
import type { Location } from './types.ts';

// Re-export the GENERATED row type rather than hand-declaring a copy. The
// migration is the source of truth, `src/db/types.ts` is generated from it, and
// a hand copy here would drift: add a column, regenerate, and `types.ts` gains
// it while this file's copy (the actual return type) does not — both still
// typecheck. Import + re-export makes drift impossible.
export type { Location };

/** The `type` discriminator of a location row, derived from the generated type. */
export type LocationType = Location['type'];

/** The input {@link createLocation} accepts; `db` supplies the tenant. */
export interface CreateLocationInput {
  code: string;
  nameAr: string;
  nameEn?: string;
  type: LocationType;
  parentId?: string;
}

/**
 * The code of the tenant's singleton transit location — the pseudo-location
 * stock belongs to while it is between the warehouse and a branch. Unique per
 * tenant, so `transitLocation` can resolve it with an upsert.
 */
export const TRANSIT_CODE = 'TRANSIT';

/**
 * Creates a location for the tenant the connection is currently scoped to.
 *
 * The tenant is NOT a parameter: it is read from `app.tenant_id`, which
 * `withTenant` has pinned on this connection, so a caller cannot create a row
 * for a tenant it is not scoped to — the `with check` half of the policy would
 * refuse it anyway. Call this with the scoped `db` from inside `withTenant`;
 * never nest `withTenant` around it.
 *
 * Called OUTSIDE a `withTenant` scope (no `app.tenant_id` pinned) it fails with
 * Postgres `42501 new row violates row-level security policy for table
 * "locations"` — byte-identical to the error a genuine cross-tenant insert
 * attempt produces. The two are indistinguishable at the database, so callers
 * MUST open a tenant scope first; the error is not a signal that a tenant was
 * chosen wrongly.
 */
export async function createLocation(db: Queryable, input: CreateLocationInput): Promise<Location> {
  const { rows } = await db.query<Location>(
    `insert into locations (tenant_id, code, name_ar, name_en, type, parent_id)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5)
     returning *`,
    [input.code.trim().toUpperCase(), input.nameAr, input.nameEn ?? null, input.type, input.parentId ?? null],
  );

  const row = rows[0];
  if (!row) throw new Error(`createLocation: no row returned for code ${input.code}`);
  return row;
}

/**
 * Returns the tenant's singleton transit location, creating it if it is missing.
 *
 * Safe to call concurrently: the insert is
 * `on conflict (tenant_id, code) do nothing` against the per-tenant unique code,
 * so two callers racing cannot create two transit rows — the loser's insert
 * becomes a no-op and both then select the one surviving row. Call it with the
 * scoped `db` from inside `withTenant`.
 *
 * Called OUTSIDE a `withTenant` scope it fails with Postgres `42501 new row
 * violates row-level security policy for table "locations"` — identical to a
 * genuine cross-tenant insert attempt; callers must open a tenant scope first.
 */
export async function transitLocation(db: Queryable): Promise<Location> {
  await db.query(
    `insert into locations (tenant_id, code, name_ar, name_en, type)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, 'transit')
     on conflict (tenant_id, code) do nothing`,
    [TRANSIT_CODE, 'ترانزيت', 'Transit'],
  );

  // Select by CODE alone (not `type = 'transit'`): if the code is already taken
  // by a non-transit row, the `on conflict do nothing` above swallowed the
  // insert and a `type = 'transit'` filter would find nothing — reporting a
  // missing transit row when the real cause is an occupied code.
  const { rows } = await db.query<Location>(
    `select *
       from locations
      where code = $1
        and tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`,
    [TRANSIT_CODE],
  );

  const row = rows[0];
  if (!row) {
    throw new Error(
      `transitLocation: transit location missing after insert (code ${TRANSIT_CODE})`,
    );
  }
  if (row.type !== 'transit') {
    throw new Error(
      `transitLocation: code ${TRANSIT_CODE} is occupied by a ${row.type} location, not the transit location`,
    );
  }
  return row;
}
