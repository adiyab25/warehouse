-- 0012_usernames: sign-in by an ASSIGNED username, names that survive Arabic,
-- and a bounded audit trail.
--
-- Three review findings against 0002/0011 are fixed here, in the schema rather
-- than in the application, because each is a property of the DATA:
--
--   1. `app_users.name` had NO unique constraint while src/auth/login.ts looked
--      a person up by name — so two employees called "أحمد علي" were ONE
--      identity: one person's password was checked against the other's hash and
--      they shared one lockout bucket. The fix is that sign-in uses a SHORT
--      ASSIGNED USERNAME, unique per tenant; the person's real name stays as
--      display data.
--   2. `normaliseIdentifier` was `trim().toUpperCase()`, a NO-OP for Arabic,
--      and `btrim` strips ASCII space only. The stored `أحمد علي` rejected
--      `احمد علي` (the ordinary spelling) and `أحمد  علي` (double space).
--      `normalise_name(text)` below is the ONE normaliser, and the CHECK on
--      `name_normalised` makes the database agree with src/domain/text.ts.
--   3. `login_attempts` grew without bound and had no retention story.
--      `purge_login_attempts(interval)` is the sweep a scheduled job calls.
--
-- This migration ADDS; it does not rewrite 0001-0011. The only existing object
-- it touches is the `login_attempts` identifier CHECK, which must change: the
-- identifier is now a USERNAME (lowercase), not an upper-cased name, and the
-- old rule `identifier = upper(btrim(identifier))` would refuse every username
-- the app now writes.

-- ---- 1. THE SHARED NORMALISER ------------------------------------------------
-- One implementation, in SQL, that src/domain/text.ts::normaliseName mirrors
-- step for step. See that file for what each fold is and why; the ORDER matters
-- (NFKC first, then the folds, then whitespace) and is the same in both.
--
-- `translate(from => ..., to => ...)` is ONE pass: the alef family (4 code
-- points) and ى/ة fold to their targets, and TATWEEL is listed LAST in `from`
-- with no corresponding character in `to`, which is how `translate` is told to
-- DELETE it rather than replace it.
--
-- EXECUTE is deliberately left at Postgres's default (PUBLIC). This is a pure,
-- data-free text function, it is called by a CHECK expression — so every role
-- that may INSERT into `app_users` needs to execute it, not just `postgres` and
-- `authenticated` — and there is nothing behind it to protect: it reads no
-- table and takes no privilege. (The function that DOES need its grants locked
-- down, because it bypasses RLS, is authenticate_api_token in 0010.)
create or replace function public.normalise_name(raw text)
returns text
language sql
immutable
strict
as $$
  select btrim(
           regexp_replace(
             translate(
               normalize(raw, NFKC),
               U&'\0623\0625\0622\0671\0649\0629\0640',  -- أ إ آ ٱ ى ة tatweel
               'اااايه'                                  -- ا ا ا ا ي ه  (tatweel dropped)
             ),
             '[[:space:]]+', ' ', 'g'
           )
         );
$$;

-- ---- 2. THE ASSIGNED USERNAME -----------------------------------------------
alter table app_users add column username text;
alter table app_users add column name_normalised text;

-- A pre-0012 row has NO assigned username, and inventing one (from the name, or
-- from the id) would silently mint a credential for a real person. Refuse
-- loudly instead, with an instruction: this is a provisioning gap, not a data
-- repair. `npm run db:reset` on a development database is the intended path.
do $$
begin
  if exists (select 1 from app_users) then
    raise exception '0012: % app_users row(s) predate this migration and carry '
      'no assigned username or normalised name. Inventing an identity for a '
      'real person is not something a migration may do: provision each user a '
      'unique username (and its normalised name) and re-run.',
      (select count(*) from app_users);
  end if;
end $$;

alter table app_users alter column username set not null;
alter table app_users alter column name_normalised set not null;

-- The username is STORED NORMALISED — trimmed and lower-cased — and bounded to
-- a safe, printable charset. Both halves are enforced here so a writer that
-- bypasses src/domain/text.ts::normaliseUsername cannot store a second spelling
-- of an existing account (the whole of finding 1): `'Owner1'`, `' owner1 '` and
-- `'owner1'` are refused unless they are already `'owner1'`.
alter table app_users
  add constraint app_users_username_normalised_check
  check (username = lower(btrim(username)) and username <> '');

-- Starts alphanumeric, then 2-31 of a-z 0-9 . _ -  (3-32 characters total).
-- A leading digit is allowed; a leading separator is not, so a username is
-- never a bare `.`/`..` path fragment or a shell flag.
alter table app_users
  add constraint app_users_username_charset_check
  check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');

-- THE CONSTRAINT THAT MAKES TWO PEOPLE TWO PEOPLE. Scoped to the tenant, so two
-- clients may each have `owner1`, but one client cannot have two.
alter table app_users
  add constraint app_users_tenant_username_key unique (tenant_id, username);

-- The normalised display name, alongside the name AS TYPED. The CHECK is what
-- makes "normalised" a property of the row rather than a promise from the
-- application: it must be exactly what normalise_name() returns for `name`.
alter table app_users
  add constraint app_users_name_normalised_check
  check (name_normalised = public.normalise_name(name));

-- ---- 3. THE LOCKOUT IDENTIFIER IS A USERNAME --------------------------------
-- Was `identifier = upper(btrim(identifier))` (an ASCII name). Sign-in is by
-- username now, so the identifier records the LOWER-CASED username, and the
-- same "store it canonical" discipline applies with the other case rule.
alter table login_attempts drop constraint login_attempts_identifier_normalised_check;
alter table login_attempts
  add constraint login_attempts_identifier_normalised_check
  check (identifier = lower(btrim(identifier)) and identifier <> '');

-- ---- 4. RETENTION ----------------------------------------------------------
-- A success no longer DELETES the failures that preceded it (that destroyed the
-- record of the brute force), so the table needs a bounded lifetime instead of
-- an accidental one. This index is what the sweep deletes by; the lockout read
-- keeps using login_attempts_lookup_idx from 0011.
create index login_attempts_age_idx on login_attempts (tenant_id, attempted_at);

-- Deletes every attempt older than `older_than` and returns how many went.
--
-- TENANT-SCOPED BY CONSTRUCTION: the function is SECURITY INVOKER (the default)
-- and `login_attempts` carries forced RLS, so a call made inside a
-- `withTenant` transaction can only delete the pinned tenant's rows — one
-- tenant's sweep can never touch another's audit trail. Called WITHOUT a pinned
-- tenant it deletes nothing (the policy matches no rows), which is the safe
-- failure.
--
-- THIS IS NOT SCHEDULED HERE. Nothing calls it yet: a later task wires it to a
-- scheduled job (pg_cron, or the deployment's own cron) with the agreed window.
create function public.purge_login_attempts(older_than interval)
returns integer
language sql
as $$
  with gone as (
    delete from login_attempts
     where attempted_at < now() - older_than
     returning 1
  )
  select count(*)::int from gone;
$$;

revoke all on function public.purge_login_attempts(interval) from public;
grant execute on function public.purge_login_attempts(interval) to authenticated;
