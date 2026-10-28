import type { Queryable } from './client.ts';
import { encodeCursor } from '../api/params.ts';

/**
 * READ-ONLY queries behind `/api/v1/*` (SERVER-ONLY: takes the scoped `db`).
 *
 * Why these are not `usage.ts`'s readers: those return display-shaped rows (names
 * only; no ids/barcode/codes; no keyset cursor). The API needs ids, codes and a
 * cursor, so these are SELECTs over the same `on_hand` view / tables.
 * Nothing here writes. Every joined column is ALIASED to the camelCase key it is
 * returned under and every row is mapped EXPLICITLY. Quantities stay decimal
 * STRINGS (consumers must not use floats). Cost (`cost_egp`) is deliberately
 * never selected: pricing/costing is out of scope for outside systems in v1.
 */

export interface Page<T> {
  data: T[];
  /** Opaque; `null` when there are no more rows. */
  nextCursor: string | null;
}

/** Callers fetch `limit + 1` rows; the extra one proves there is a next page. */
function page<T>(rows: T[], limit: number, cursorOf: (last: T) => Record<string, string>): Page<T> {
  const more = rows.length > limit;
  const data = more ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeCursor(cursorOf(last)) : null };
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (col: string, alias: string) => `to_char(${col} at time zone 'UTC', ${ISO}) as "${alias}"`;

// ---------------------------------------------------------------- on-hand

export interface OnHandApiRow {
  variantId: string;
  sku: string;
  barcode: string;
  nameAr: string;
  itemId: string;
  locationId: string;
  locationCode: string;
  location: string;
  /** Decimal string, numeric(12,3). */
  onHand: string;
  /** Equal to `onHand` in v1; reservations later will make it differ WITHOUT changing the shape. */
  available: string;
}

export async function listOnHand(
  db: Queryable,
  f: { variantId?: string; sku?: string; locationId?: string; limit: number; cursor?: { v: string; l: string } },
): Promise<Page<OnHandApiRow>> {
  const { rows } = await db.query<OnHandApiRow>(
    `select oh.variant_id as "variantId",
            v.sku as "sku",
            v.barcode as "barcode",
            i.name_ar as "nameAr",
            i.id as "itemId",
            oh.location_id as "locationId",
            l.code as "locationCode",
            l.name_ar as "location",
            oh.qty::text as "onHand",
            oh.qty::text as "available"
       from on_hand oh
       join item_variants v on v.id = oh.variant_id
       join items i on i.id = v.item_id and i.tenant_id = v.tenant_id
       join locations l on l.id = oh.location_id and l.tenant_id = v.tenant_id
      where oh.qty <> 0
        and ($1::uuid is null or oh.variant_id = $1)
        and ($2::text is null or v.sku = upper($2))
        and ($3::uuid is null or oh.location_id = $3)
        and ($4::uuid is null or (oh.variant_id, oh.location_id) > ($4::uuid, $5::uuid))
      order by oh.variant_id, oh.location_id
      limit $6`,
    [f.variantId ?? null, f.sku ?? null, f.locationId ?? null, f.cursor?.v ?? null, f.cursor?.l ?? null, f.limit + 1],
  );
  const mapped = rows.map((r) => ({
    variantId: r.variantId,
    sku: r.sku,
    barcode: r.barcode,
    nameAr: r.nameAr,
    itemId: r.itemId,
    locationId: r.locationId,
    locationCode: r.locationCode,
    location: r.location,
    onHand: r.onHand,
    available: r.available,
  }));
  return page(mapped, f.limit, (r) => ({ v: r.variantId, l: r.locationId }));
}

// ------------------------------------------------------------------ items

export interface ItemApiRow {
  id: string;
  nameAr: string;
  nameEn: string | null;
  family: string;
  category: string | null;
  uom: string;
  discrete: boolean;
  active: boolean;
  variants: Array<{ id: string; sku: string; barcode: string; attrs: unknown; active: boolean }>;
}

export async function listItems(
  db: Queryable,
  f: { family?: string; limit: number; cursor?: { i: string } },
): Promise<Page<ItemApiRow>> {
  const { rows } = await db.query<ItemApiRow>(
    `select i.id as "id",
            i.name_ar as "nameAr",
            i.name_en as "nameEn",
            i.family as "family",
            i.category as "category",
            i.uom as "uom",
            i.discrete as "discrete",
            i.active as "active",
            coalesce((select json_agg(json_build_object(
                        'id', v.id, 'sku', v.sku, 'barcode', v.barcode,
                        'attrs', v.attrs, 'active', v.active) order by v.sku, v.id)
                        from item_variants v
                       where v.item_id = i.id and v.tenant_id = i.tenant_id), '[]'::json) as "variants"
       from items i
      where ($1::text is null or i.family = $1)
        and ($2::uuid is null or i.id > $2)
      order by i.id
      limit $3`,
    [f.family ?? null, f.cursor?.i ?? null, f.limit + 1],
  );
  const mapped = rows.map((r) => ({
    id: r.id,
    nameAr: r.nameAr,
    nameEn: r.nameEn,
    family: r.family,
    category: r.category,
    uom: r.uom,
    discrete: r.discrete,
    active: r.active,
    variants: r.variants,
  }));
  return page(mapped, f.limit, (r) => ({ i: r.id }));
}

// -------------------------------------------------------------- locations

export interface LocationApiRow {
  id: string;
  code: string;
  name: string;
  nameEn: string | null;
  type: string;
  parentId: string | null;
  active: boolean;
}

export async function listLocations(
  db: Queryable,
  f: { type?: string; limit: number; cursor?: { c: string; i: string } },
): Promise<Page<LocationApiRow>> {
  const { rows } = await db.query<LocationApiRow>(
    `select l.id as "id",
            l.code as "code",
            l.name_ar as "name",
            l.name_en as "nameEn",
            l.type as "type",
            l.parent_id as "parentId",
            l.active as "active"
       from locations l
      where ($1::text is null or l.type = $1)
        and ($2::text is null or (l.code, l.id) > ($2::text, $3::uuid))
      order by l.code, l.id
      limit $4`,
    [f.type ?? null, f.cursor?.c ?? null, f.cursor?.i ?? null, f.limit + 1],
  );
  const mapped = rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    nameEn: r.nameEn,
    type: r.type,
    parentId: r.parentId,
    active: r.active,
  }));
  return page(mapped, f.limit, (r) => ({ c: r.code, i: r.id }));
}

// ----------------------------------------------------------- requisitions

export interface RequisitionApiRow {
  id: string;
  status: string;
  branch: { id: string; code: string; name: string };
  /** The requester's NAME (never a user id). */
  requestedByName: string;
  requestedAt: string;
  approvedAt: string | null;
  issuedAt: string | null;
  receivedAt: string | null;
  closedAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  notes: string | null;
  /** Quantities are decimal strings. */
  lines: Array<{
    id: string;
    variantId: string;
    sku: string;
    requestedQty: string;
    approvedQty: string | null;
    issuedQty: string;
    receivedQty: string;
    status: string;
  }>;
}

type RequisitionSqlRow = {
  id: string;
  status: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  requestedByName: string;
  requestedAt: string;
  approvedAt: string | null;
  issuedAt: string | null;
  receivedAt: string | null;
  closedAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  notes: string | null;
  lines: RequisitionApiRow['lines'];
  cursorTs: string;
};

export async function listRequisitions(
  db: Queryable,
  f: { status?: string; branchLocationId?: string; limit: number; cursor?: { t: string; i: string } },
): Promise<Page<RequisitionApiRow>> {
  const { rows } = await db.query<RequisitionSqlRow>(
    `select r.id as "id",
            r.status as "status",
            b.id as "branchId",
            b.code as "branchCode",
            b.name_ar as "branchName",
            u.name as "requestedByName",
            ${iso('r.requested_at', 'requestedAt')},
            ${iso('r.approved_at', 'approvedAt')},
            ${iso('r.issued_at', 'issuedAt')},
            ${iso('r.received_at', 'receivedAt')},
            ${iso('r.closed_at', 'closedAt')},
            ${iso('r.rejected_at', 'rejectedAt')},
            r.rejected_reason as "rejectedReason",
            r.notes as "notes",
            r.requested_at::text as "cursorTs",
            coalesce((select json_agg(json_build_object(
                        'id', rl.id, 'variantId', rl.variant_id, 'sku', v.sku,
                        'requestedQty', rl.requested_qty::text,
                        'approvedQty', rl.approved_qty::text,
                        'issuedQty', rl.issued_qty::text,
                        'receivedQty', rl.received_qty::text,
                        'status', rl.status) order by v.sku, rl.id)
                        from requisition_lines rl
                        join item_variants v on v.id = rl.variant_id and v.tenant_id = rl.tenant_id
                       where rl.requisition_id = r.id and rl.tenant_id = r.tenant_id), '[]'::json) as "lines"
       from requisitions r
       join locations b on b.id = r.branch_location_id and b.tenant_id = r.tenant_id
       join app_users u on u.id = r.requested_by and u.tenant_id = r.tenant_id
      where ($1::text is null or r.status = $1)
        and ($2::uuid is null or r.branch_location_id = $2)
        and ($3::text is null or (r.requested_at, r.id) < ($3::timestamptz, $4::uuid))
      order by r.requested_at desc, r.id desc
      limit $5`,
    [f.status ?? null, f.branchLocationId ?? null, f.cursor?.t ?? null, f.cursor?.i ?? null, f.limit + 1],
  );
  const mapped = rows.map((r) => ({
    row: {
      id: r.id,
      status: r.status,
      branch: { id: r.branchId, code: r.branchCode, name: r.branchName },
      requestedByName: r.requestedByName,
      requestedAt: r.requestedAt,
      approvedAt: r.approvedAt,
      issuedAt: r.issuedAt,
      receivedAt: r.receivedAt,
      closedAt: r.closedAt,
      rejectedAt: r.rejectedAt,
      rejectedReason: r.rejectedReason,
      notes: r.notes,
      lines: r.lines,
    } satisfies RequisitionApiRow,
    ts: r.cursorTs,
  }));
  const p = page(mapped, f.limit, (m) => ({ t: m.ts, i: m.row.id }));
  return { data: p.data.map((m) => m.row), nextCursor: p.nextCursor };
}

// -------------------------------------------------------------- movements

export interface MovementApiRow {
  /** bigint as a string; monotonic insertion order. */
  seq: string;
  /** Raw closed-list code — a STABLE machine contract. */
  reason: string;
  /** Decimal string, numeric(12,3), a positive magnitude. */
  qty: string;
  variantId: string;
  sku: string;
  fromLocation: { id: string; code: string; name: string } | null;
  toLocation: { id: string; code: string; name: string } | null;
  actor: { type: 'user' | 'api_client' | 'system'; name: string };
  occurredAt: string;
  refType: string | null;
  refId: string | null;
}

type MovementSqlRow = {
  seq: string;
  reason: string;
  qty: string;
  variantId: string;
  sku: string;
  fromId: string | null;
  fromCode: string | null;
  fromName: string | null;
  toId: string | null;
  toCode: string | null;
  toName: string | null;
  actorType: 'user' | 'api_client' | 'system';
  actorName: string;
  occurredAt: string;
  refType: string | null;
  refId: string | null;
};

export async function listMovements(
  db: Queryable,
  f: {
    variantId?: string;
    reason?: string;
    from?: string;
    to?: string;
    limit: number;
    cursor?: { s: string };
  },
): Promise<Page<MovementApiRow>> {
  const { rows } = await db.query<MovementSqlRow>(
    `select m.seq::text as "seq",
            m.reason as "reason",
            m.qty::text as "qty",
            m.variant_id as "variantId",
            v.sku as "sku",
            fl.id as "fromId", fl.code as "fromCode", fl.name_ar as "fromName",
            tl.id as "toId", tl.code as "toCode", tl.name_ar as "toName",
            case when m.actor_user_id is not null then 'user'
                 when m.actor_api_client_id is not null then 'api_client'
                 else 'system' end as "actorType",
            coalesce(u.name, c.name, 'system') as "actorName",
            ${iso('m.occurred_at', 'occurredAt')},
            m.ref_type as "refType",
            m.ref_id::text as "refId"
       from stock_movements m
       join item_variants v on v.id = m.variant_id and v.tenant_id = m.tenant_id
       left join locations fl on fl.id = m.from_location_id and fl.tenant_id = m.tenant_id
       left join locations tl on tl.id = m.to_location_id and tl.tenant_id = m.tenant_id
       left join app_users u on u.id = m.actor_user_id and u.tenant_id = m.tenant_id
       left join api_clients c on c.id = m.actor_api_client_id and c.tenant_id = m.tenant_id
      where ($1::uuid is null or m.variant_id = $1)
        and ($2::text is null or m.reason = $2)
        and ($3::timestamptz is null or m.occurred_at >= $3)
        and ($4::timestamptz is null or m.occurred_at < $4)
        and ($5::bigint is null or m.seq < $5)
      order by m.seq desc
      limit $6`,
    [f.variantId ?? null, f.reason ?? null, f.from ?? null, f.to ?? null, f.cursor?.s ?? null, f.limit + 1],
  );
  const mapped = rows.map((r) => ({
    seq: r.seq,
    reason: r.reason,
    qty: r.qty,
    variantId: r.variantId,
    sku: r.sku,
    fromLocation: r.fromId ? { id: r.fromId, code: r.fromCode!, name: r.fromName! } : null,
    toLocation: r.toId ? { id: r.toId, code: r.toCode!, name: r.toName! } : null,
    actor: { type: r.actorType, name: r.actorName },
    occurredAt: r.occurredAt,
    refType: r.refType,
    refId: r.refId,
  }));
  return page(mapped, f.limit, (r) => ({ s: r.seq }));
}
