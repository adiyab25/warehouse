'use server';

import { runGatedAction } from '@/modules/auth/action-runner';
import { ActionRefusal, requirePermission, requiredField } from '@/modules/auth/guard';
import { PERMISSION } from '@/modules/auth/keys';
import { createLocation, type LocationType } from '@/modules/locations/db';

const TYPES: readonly string[] = [
  'warehouse', 'branch', 'bin', 'vendor', 'holder', 'scrap', 'quarantine',
];

/**
 * Creates a location — a WRITE, so it is gated: a role without
 * `locations:locations:manage` cannot invent a branch by posting this action.
 */
export async function createLocationAction(formData: FormData): Promise<void> {
  await runGatedAction('/locations', async (db, cookie) => {
    await requirePermission(db, cookie, PERMISSION.locationsManage);

    const type = String(formData.get('type') ?? '');
    if (!TYPES.includes(type)) {
      throw new ActionRefusal('invalid', `A location's type must be one of: ${TYPES.join(', ')}.`);
    }
    const nameEn = formData.get('nameEn');

    await createLocation(db, {
      code: requiredField(formData, 'code'),
      nameAr: requiredField(formData, 'nameAr'),
      nameEn: typeof nameEn === 'string' && nameEn.trim() !== '' ? nameEn.trim() : undefined,
      type: type as LocationType,
    });
  });
}
