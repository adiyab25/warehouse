'use server';

import { withTenant } from '@/modules/platform/db';
import { createItem } from '@/modules/catalog/db';

export async function createItemAction(formData: FormData) {
  const nameAr = formData.get('nameAr') as string;
  const sku = formData.get('sku') as string;
  const barcode = formData.get('barcode') as string;
  const family = formData.get('family') as string;
  const uom = formData.get('uom') as string;
  const unitCost = formData.get('unitCost') as string;

  const tenantId = process.env.TENANT_ID!;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const db = {
      query: (sql: string, params?: unknown[]) => client.query(sql, params),
    };
    await createItem(db as any, {
      nameAr,
      sku,
      barcode,
      family: family as any,
      uom: uom || 'unit',
      costEgp: unitCost ? Number(unitCost) : undefined,
    });
  } finally {
    client.release();
    await pool.end();
  }
}
