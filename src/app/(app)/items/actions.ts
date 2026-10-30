'use server';

import { runGatedAction } from '@/modules/auth/action-runner';
import { ActionRefusal, requirePermission, requiredField } from '@/modules/auth/guard';
import { PERMISSION } from '@/modules/auth/keys';
import { createItem, type ItemFamily } from '@/modules/catalog/db';

const FAMILIES: readonly string[] = ['sellable', 'consumable', 'asset'];

/**
 * Creates an item and its first variant — a WRITE, so it is gated: a role
 * without `catalog:items:manage` (a branch, for instance) cannot mint products
 * by posting this action directly.
 */
export async function createItemAction(formData: FormData): Promise<void> {
  await runGatedAction('/items', async (db, cookie) => {
    await requirePermission(db, cookie, PERMISSION.itemsManage);

    const family = String(formData.get('family') ?? '');
    if (!FAMILIES.includes(family)) {
      throw new ActionRefusal('invalid', `An item's family must be one of: ${FAMILIES.join(', ')}.`);
    }
    const cost = Number(formData.get('unitCost'));

    await createItem(db, {
      nameAr: requiredField(formData, 'nameAr'),
      family: family as ItemFamily,
      sku: requiredField(formData, 'sku'),
      barcode: requiredField(formData, 'barcode'),
      uom: String(formData.get('uom') ?? 'unit') || 'unit',
      costEgp: Number.isFinite(cost) && cost > 0 ? cost : undefined,
    });
  });
}
