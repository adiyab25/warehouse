'use server';

import { createLocation } from '@/modules/locations/db';

export async function createLocationAction(formData: FormData) {
  const code = formData.get('code') as string;
  const nameAr = formData.get('nameAr') as string;
  const nameEn = formData.get('nameEn') as string;
  const type = formData.get('type') as string;

  const tenantId = process.env.TENANT_ID!;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const db = { query: (sql: string, params?: unknown[]) => client.query(sql, params) };
    await createLocation(db as any, {
      code,
      nameAr,
      nameEn: nameEn || undefined,
      type: type as any,
    });
  } finally {
    client.release();
    await pool.end();
  }
}
