-- Local development seed. Runs automatically after migrations on `npm run db:reset`
-- (config.toml `[db.seed] enabled = true`, `sql_paths = ["./seed.sql"]`).
--
-- WHY THIS EXISTS: `db reset` drops and recreates the whole Postgres instance, and
-- Supabase's `auth.users` lives in that same instance — so every reset used to take
-- the developer's login with it, leaving the app unusable until someone hand-created
-- a user AND remembered to promote its role. This file makes a reset self-healing.
--
-- LOCAL ONLY. `supabase db push` does not run seed files, so this never reaches a
-- deployed project. The credentials below are deliberately worthless and are for a
-- database that only ever listens on 127.0.0.1.
--
-- NOTE ON RESETS: a reset is for proving migrations replay cleanly from zero. To
-- simply apply new migrations to the database you already have — keeping all data —
-- use `npm run db:migrate` (supabase migration up). That is also how production
-- works: migrations are forward-applied against `supabase_migrations.schema_migrations`,
-- never replayed.

-- The dev account. `role = 'developer'` matters: the mobile "Test Live" tab is hidden
-- for `customer` (adr-0008), which is the DEFAULT for a new profile — so a plain
-- signup leaves you staring at an app with no Live screen.
--
--   email:    dev@nova.test
--   password: nova-dev-1234
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change
)
values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4111-8111-111111111111',
  'authenticated',
  'authenticated',
  'dev@nova.test',
  -- bcrypt via pgcrypto (shipped in the `extensions` schema on this stack).
  extensions.crypt ('nova-dev-1234', extensions.gen_salt ('bf')),
  -- Non-null => already confirmed, so sign-in works with no email round trip.
  now(),
  now(),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  '',
  '',
  '',
  ''
)
on conflict (id) do nothing;

-- GoTrue resolves a password login through `auth.identities`, not `auth.users`
-- alone; without this row the account exists but cannot sign in.
insert into auth.identities (
  provider_id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values (
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111',
  '{"sub":"11111111-1111-4111-8111-111111111111","email":"dev@nova.test","email_verified":true,"phone_verified":false}'::jsonb,
  'email',
  now(),
  now(),
  now()
)
on conflict (provider, provider_id) do nothing;

-- `public.handle_new_user` already inserted the profile via the on_auth_user_created
-- trigger; promote it out of the default 'customer' so the Live tab is reachable.
-- Written as an UPDATE (not an insert) precisely because the trigger owns the row.
update public.profiles
set role = 'developer',
    display_name = 'Nova Dev'
where id = '11111111-1111-4111-8111-111111111111';
