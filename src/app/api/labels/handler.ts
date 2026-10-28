import { SESSION_COOKIE } from '../../../auth/cookie.ts';
import { currentUser } from '../../../auth/current-user.ts';
import { configuredTenantId } from '../../../auth/tenant.ts';
import { getAppPool } from '../../../db/app-pool.ts';
import { withTenant } from '../../../db/client.ts';
import { findVariantById, variantAttrs } from '../../../db/items.ts';
import { findLocationById } from '../../../db/locations.ts';
import { locationLabelSvg, variantLabelSvg } from '../../../domain/labels.ts';

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
