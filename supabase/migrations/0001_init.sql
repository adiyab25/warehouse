-- 0001_init: migration bookkeeping and the shared updated_at trigger helper.
--
-- Nothing domain-specific lives here yet. `schema_migrations` is also created
-- by scripts/migrate.mjs before it applies anything; the `if not exists` keeps
-- this file safe to apply on a database the runner has already touched, and
-- records the very first applied migration by filename.

create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

-- Attach as `before update ... execute function set_updated_at()` on any table
-- that carries an `updated_at timestamptz` column. Every later migration that
-- needs it uses this one function; nothing duplicates it.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
