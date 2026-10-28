import { locationLabelResponse } from '../../handler.ts';

/**
 * The printable LOCATION label, as an SVG — a barcode, the location's Arabic
 * name and its code, for a 50 x 30 mm thermal sticker.
 *
 * A THIN ADAPTER, deliberately: the gate, the read and the rendering live in
 * {@link locationLabelResponse}, shared with the variant route, so the
 * authentication check cannot be present on one label endpoint and absent on the
 * other. Returns a standard `Response` with media type `image/svg+xml`.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ locationId: string }> },
): Promise<Response> {
  const { locationId } = await context.params;
  return locationLabelResponse(request, locationId);
}
