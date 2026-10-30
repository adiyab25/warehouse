'use server';

import { runGatedAction } from '@/modules/auth/action-runner';
import { ActionRefusal, requirePermission, requiredField } from '@/modules/auth/guard';
import { PERMISSION } from '@/modules/auth/keys';
import { openCount } from '@/modules/counts/db';

/**
 * Opens a count session — a WRITE, so it is gated like one.
 *
 * `startedBy` used to come from a form field, which let whoever posted it name
 * somebody else as the counter. It is now the SESSION's user: the ledger records
 * who really opened the sheet.
 */
export async function openCountAction(formData: FormData): Promise<void> {
  await runGatedAction('/counts', async (db, cookie) => {
    const user = await requirePermission(db, cookie, PERMISSION.countsCreate);
    const locationId = requiredField(formData, 'locationId');
    await openCount(db, { locationId, startedBy: user.userId });
  });
}
