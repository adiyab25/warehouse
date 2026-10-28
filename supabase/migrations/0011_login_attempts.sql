-- 0011_login_attempts: the audit trail behind the sign-in lockout.
--
-- One row per sign-in ATTEMPT — success or failure. It is what lets
-- src/auth/login.ts refuse a locked identifier: five failures for the same
-- normalised name inside a 15-minute window lock it out, and a success clears
-- the failures for that name. Keeping the attempts (rather than just a counter)
-- means the lockout window is a plain `attempted_at > now() - interval` query
-- and the history is auditable.
--
-- Copies the RLS shape every migration since 0002 has repeated:
--   * `tenant_id uuid not null references tenants(id)` + `unique (tenant_id, id)`
--   * a policy `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
--     carrying BOTH `using` and `with check`
--   * `alter table <t> force row level security`
--   * explicit `grant select, insert, update, delete` to `authenticated`, and an
--     explicit revoke of TRUNCATE / REFERENCES / TRIGGER (RLS cannot govern them
--     and `public`'s default ACL is additive).
--
-- The `tenant_id -> tenants(id)` key is deliberately a PLAIN (non-composite) FK.
-- Every OTHER cross-table FK in this schema is COMPOSITE on `(tenant_id, …)`,
-- which is the rule; the sole exception is a reference to `tenants` itself,
-- because `tenants` has only its primary key `id` and no `unique (tenant_id,
-- id)` to point a composite key at. There is no other FK here.
--
-- ---- NORMALISATION ----------------------------------------------------------
-- `identifier` records the name that was TRIED, and it is stored NORMALISED —
-- trimmed and upper-cased — because it is compared against itself to count
-- failures, and `'Ahmed'`, `'ahmed'` and `'  Ahmed '` must count as ONE
-- identifier or the lockout is trivially bypassed by changing a letter's case.
-- src/auth/login.ts normalises in code AND the CHECK below refuses a raw insert
-- that bypasses the module (the same discipline 0003/0004/0005/0010 applied to
-- codes, skus, refs and names).

create table login_attempts (
  id uuid primary key default gen_random_uuid(),
  -- The tenant the attempt was made in. Plain FK — see the note above.
  tenant_id uuid not null references tenants(id),
  -- The name that was tried, NORMALISED (trim + upper). The CHECK is what makes
  -- that a property of the DATA, not just of src/auth/login.ts: a raw insert of
  -- '  Ahmed ' or 'ahmed' is refused outright.
  identifier text not null
    constraint login_attempts_identifier_normalised_check
    check (identifier = upper(btrim(identifier)) and identifier <> ''),
  -- Did this attempt sign in? A success clears the failures for the identifier.
  succeeded boolean not null,
  -- When it happened. Drives the rolling lockout window.
  attempted_at timestamptz not null default now(),
  -- Redundant against the primary key alone, but the house shape every table
  -- carries so a future composite FK can point at exactly these columns.
  unique (tenant_id, id)
);

alter table login_attempts enable row level security;
alter table login_attempts force row level security;

create policy login_attempts_tenant_isolation on login_attempts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on login_attempts to authenticated;

-- TRUNCATE is not governed by RLS at all, so one `truncate public.login_attempts`
-- as the app role would erase the lockout trail for EVERY tenant at once;
-- REFERENCES/TRIGGER would let the app role bolt constraints and triggers on.
revoke truncate, references, trigger on login_attempts from authenticated;

-- The lockout read: "how many failures for THIS identifier in the window?".
create index login_attempts_lookup_idx on login_attempts (tenant_id, identifier, attempted_at desc);
