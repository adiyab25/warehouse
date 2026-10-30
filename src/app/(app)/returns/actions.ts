'use server';

import { runGatedAction } from '@/modules/auth/action-runner';
import { ActionRefusal, requirePermission, requiredField } from '@/modules/auth/guard';
import { PERMISSION } from '@/modules/auth/keys';
import { postReturn, type ReturnDisposition } from '@/modules/returns/db';

/** The dispositions a return may name — the same set the database accepts. */
const DISPOSITIONS: readonly string[] = ['restock', 'quarantine', 'scrap'];

/**
 * Posts a return — a WRITE that moves stock, so it is gated like one.
 *
 * The ACTOR is the session's user. It used to be the all-zeros uuid: every
 * return this screen posted was recorded as "nobody", in a system whose one
 * stated rule is that every ledger row has an actor.
 */
export async function createReturnAction(formData: FormData): Promise<void> {
  await runGatedAction('/returns', async (db, cookie) => {
    const user = await requirePermission(db, cookie, PERMISSION.returnsCreate);

    const variantId = requiredField(formData, 'variantId');
    const fromLocationId = requiredField(formData, 'fromLocationId');
    const qty = Number(formData.get('qty'));
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new ActionRefusal('invalid', 'A return needs a quantity greater than zero.');
    }

    const disposition = String(formData.get('disposition') ?? '');
    if (!DISPOSITIONS.includes(disposition)) {
      throw new ActionRefusal(
        'invalid',
        `A return must say what happens to the goods (one of: ${DISPOSITIONS.join(', ')}).`,
      );
    }

    const notes = formData.get('notes');
    await postReturn(db, {
      variantId,
      qty,
      fromLocationId,
      disposition: disposition as ReturnDisposition,
      notes: typeof notes === 'string' && notes.trim() !== '' ? notes.trim() : undefined,
      // One key per submission: a retry of THIS intent would carry the same key
      // if the form supplied one; generated here, the screen's in-flight guard
      // is what stops a double tap (same trade-off as the request form).
      idempotencyKey: crypto.randomUUID(),
      actorUserId: user.userId,
    });
  });
}
