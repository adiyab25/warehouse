import type { Queryable } from './client.ts';

/**
 * What a row of `locations` *is*. One table holds the warehouse, its bins,
 * every branch, the in-transit bucket, vendors, scrap, and the people who hold
 * stock; `type` discriminates them.
 *
 * Kept in sync by hand with the `check (type in (…))` in
 * supabase/migrations/0003_locations.sql — the migration is the source of
 * truth and `src/db/types.ts` (generated) mirrors it as the same union.
 */
export type LocationType =
  | 'warehouse'
  | 'bin'
  | 'branch'
  | 'transit'
  | 'vendor'
  | 'scrap'
  | 'holder';

/** A row of the `locations` table. */
export interface Location {
  id: string;
  tenant_id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  type: LocationType;
  parent_id: string | null;
  active: boolean;
  created_at: Date;
}

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
 */
export async function createLocation(db: Queryable, input: CreateLocationInput): Promise<Location> {
  const { rows } = await db.query<Location>(
    `insert into locations (tenant_id, code, name_ar, name_en, type, parent_id)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5)
     returning *`,
    [input.code, input.nameAr, input.nameEn ?? null, input.type, input.parentId ?? null],
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
 */
export async function transitLocation(db: Queryable): Promise<Location> {
  await db.query(
    `insert into locations (tenant_id, code, name_ar, name_en, type)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, 'transit')
     on conflict (tenant_id, code) do nothing`,
    [TRANSIT_CODE, 'ترانزيت', 'Transit'],
  );

  const { rows } = await db.query<Location>(
    `select *
       from locations
      where code = $1
        and type = 'transit'
        and tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`,
    [TRANSIT_CODE],
  );

  const row = rows[0];
  if (!row) throw new Error('transitLocation: transit location missing after insert');
  return row;
}
