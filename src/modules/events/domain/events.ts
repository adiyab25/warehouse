import type { Queryable } from '@/modules/platform/index';

/**
 * Domain events — the OUTBOX.
 *
 * `emit` appends a row to `domain_events` through the CALLER'S scoped `db`, so
 * it commits or rolls back WITH whatever it announces (a posted movement). It is
 * the only writer of that table. Delivery to subscribers is not built yet.
 *
 * Payload rules: ids, codes and quantities as STRINGS (a numeric never becomes a
 * float); NEVER a token, secret, hash, password or email. `emit` refuses a
 * payload that contains such a key, at any depth.
 */
export const EVENT_TYPES = ['movement.posted', 'requisition.status_changed', 'stock.low'] as const;

export type DomainEvent = {
  type: (typeof EVENT_TYPES)[number];
  tenantId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
};

const FORBIDDEN_KEY = /token|secret|hash|password|e-?mail/i;

function assertSafePayload(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafePayload(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) throw new Error(`emit: ${path}.${k} may not appear in an event payload`);
      assertSafePayload(v, `${path}.${k}`);
    }
  }
}

/** Appends `event` to `domain_events` inside the caller's transaction. */
export async function emit(db: Queryable, event: DomainEvent): Promise<void> {
  if (!(EVENT_TYPES as readonly string[]).includes(event.type)) {
    throw new Error(`emit: unknown event type ${JSON.stringify(event.type)}`);
  }
  assertSafePayload(event.payload);
  await db.query(
    `insert into domain_events (tenant_id, type, payload, occurred_at)
     values ($1, $2, $3::jsonb, $4::timestamptz)`,
    [event.tenantId, event.type, JSON.stringify(event.payload), event.occurredAt],
  );
}
