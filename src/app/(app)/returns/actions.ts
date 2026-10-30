'use server';

import { postReturn } from '@/modules/returns/db';

export async function createReturnAction(formData: FormData) {
  const variantId = formData.get('variantId') as string;
  const qty = Number(formData.get('qty'));
  const fromLocationId = formData.get('fromLocationId') as string;
  const disposition = formData.get('disposition') as string;
  const notes = formData.get('notes') as string;

  const tenantId = process.env.TENANT_ID!;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const db = { query: (sql: string, params?: unknown[]) => client.query(sql, params) };
    await postReturn(db as any, {
      variantId,
      qty,
      fromLocationId,
      disposition: disposition as any,
      notes: notes || undefined,
      idempotencyKey: crypto.randomUUID(),
      actorUserId: '00000000-0000-0000-0000-000000000000',
    });
  } finally {
    client.release();
    await pool.end();
  }
}
