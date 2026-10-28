/**
 * Which tenant THIS DEPLOYMENT serves.
 *
 * v1 is ONE DEPLOYMENT PER CLIENT, so the tenant is deployment CONFIGURATION,
 * not something the app discovers at runtime: the id is handed to the process at
 * boot in the `TENANT_ID` environment variable, and this module is the single
 * place that reads it. Task 11 (the auth shell) needs a tenant BEFORE any
 * session exists — to pin `app.tenant_id` on a `withTenant` connection so it can
 * read `app_users` and check a password, and to read back a session cookie — and
 * this is what supplies it.
 *
 * WHY IT CANNOT BE RESOLVED FROM THE DATABASE (yet): `tenants` has only
 * `(id, name, created_at)` — no host and no slug column — and its policy is
 * `id = current_setting('app.tenant_id')`, so a connection with no tenant pinned
 * cannot look ANY tenant up (and a scoped one can only see the tenant it is
 * already scoped to). There is deliberately NO host/subdomain → tenant resolver
 * and no second SECURITY DEFINER function: adding one is a real, separate design
 * decision for the SaaS end state (many tenants behind one host, resolved per
 * request), and it should be made explicitly rather than smuggled in behind the
 * auth shell. A host/subdomain mapping is therefore a LATER, deliberate
 * addition; until then the tenant is configuration.
 */

/** A plain uuid v4-ish shape check — enough to reject a placeholder or a name. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenant id this deployment serves, from `TENANT_ID`.
 *
 * Returns the trimmed value, or THROWS a clear, actionable error when it is
 * unset or malformed: a deployment that does not know its tenant cannot resolve
 * a login, and failing loudly at boot beats failing quietly on the first request
 * (or, worse, scoping to the wrong tenant). Callers should let the error
 * propagate — it is a misconfiguration, never a user-facing condition.
 */
export function configuredTenantId(): string {
  const raw = process.env.TENANT_ID?.trim() ?? '';
  if (!raw) {
    throw new Error(
      'configuredTenantId: TENANT_ID is not set — one deployment serves one tenant ' +
        'and the tenant id is deployment configuration (see README, "Which tenant this ' +
        'deployment serves"). Set TENANT_ID to the tenant uuid at boot.',
    );
  }
  if (!UUID.test(raw)) {
    throw new Error(
      `configuredTenantId: TENANT_ID must be a tenant uuid (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}
