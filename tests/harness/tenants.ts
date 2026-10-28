import { Client } from 'pg';

import { migrateUrl } from './sql.ts';

/**
 * Provisioning helper for the auth tests.
 *
 * Tenants are created over the OWNER connection on purpose: the `tenants`
 * policy is keyed on the row's own id (`id = current_setting('app.tenant_id')`),
 * so a fresh tenant can never satisfy it and the app role can never create one
 * (see 0002). Everything the app does afterwards runs as the non-superuser
 * `authenticated` role through `withDb`.
 */

export type Fixture = {
  /** Tenant one. */
  t1: string;
  /** Tenant two — the "other" tenant a forgery would try to impersonate. */
  t2: string;
  /** An `owner` app_user in tenant one. */
  u1: string;
  /** An `owner` app_user in tenant two. */
  u2: string;
};

const created: string[] = [];

/** Creates two tenants, each with one `owner` app_user, over the OWNER connection. */
export async function provisionTenants(): Promise<Fixture> {
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    const {
      rows: [t1],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Guard One') returning id");
    const {
      rows: [t2],
    } = await owner.query<{ id: string }>("insert into tenants (name) values ('Guard Two') returning id");

    const userIds: Record<string, string> = {};
    for (const [id, name] of [
      [t1!.id, 'Owner One'],
      [t2!.id, 'Owner Two'],
    ] as const) {
      const {
        rows: [u],
      } = await owner.query<{ id: string }>(
        "insert into app_users (tenant_id, name, role, password_hash) values ($1, $2, 'owner', 'x') returning id",
        [id, name],
      );
      userIds[id] = u!.id;
    }

    created.push(t1!.id, t2!.id);
    return { t1: t1!.id, t2: t2!.id, u1: userIds[t1!.id]!, u2: userIds[t2!.id]! };
  } finally {
    await owner.end();
  }
}

/** Deletes everything {@link provisionTenants} created, child rows first. */
export async function cleanupTenants(): Promise<void> {
  if (created.length === 0 || !migrateUrl()) return;
  const owner = new Client({ connectionString: migrateUrl()! });
  await owner.connect();
  try {
    await owner.query('delete from sessions where tenant_id = any($1)', [created]);
    await owner.query('delete from api_clients where tenant_id = any($1)', [created]);
    await owner.query('delete from app_users where tenant_id = any($1)', [created]);
    await owner.query('delete from tenants where id = any($1)', [created]);
  } finally {
    await owner.end();
  }
}
