import { variantLabelResponse } from '@/modules/catalog/index';

/**
 * The printable VARIANT label, as an SVG — a barcode, the item's Arabic name,
 * its size/colour and its SKU, for a 50 x 30 mm thermal sticker.
 *
 * A THIN ADAPTER, deliberately: the gate (authenticated caller), the read and
 * the rendering all live in {@link variantLabelResponse}, so the two label
 * routes cannot drift apart and the logic is driven directly by a test. This
 * route is VERSIONED-flat on purpose — a route added later that forgets the gate
 * would be the bug, so the shared handler is the only place the gate exists.
 *
 * Returns a standard `Response` (media type `image/svg+xml`); no Next-specific
 * response is needed.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ variantId: string }> },
): Promise<Response> {
  const { variantId } = await context.params;
  return variantLabelResponse(request, variantId);
}
