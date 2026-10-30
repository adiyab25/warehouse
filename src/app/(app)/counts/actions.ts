'use server';

import { openCount } from '@/modules/counts/db';

export async function openCountAction(formData: FormData) {
  const locationId = formData.get('locationId') as string;
  const startedBy = formData.get('startedBy') as string;

  const tenantId = process.env.TENANT_ID!;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const db = { query: (sql: string, params?: unknown[]) => client.query(sql, params) };
    await openCount(db as any, { locationId, startedBy });
  } finally {
    client.release();
    await pool.end();
  }
}
