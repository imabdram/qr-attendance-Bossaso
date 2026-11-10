-- ============================================================
-- Migration 005: administrators cannot be created from the frontend
-- ============================================================
-- The browser talks to PostgREST with the `authenticated` role, so any RPC it
-- can call is effectively "frontend". Two locks:
--   1. admin_create_user rejects p_role = 'admin' and always writes 'employee'.
--   2. A trigger refuses role changes made by any role other than the table
--      owner (neondb_owner), which is what scripts and the SQL Editor use.
-- Admins are therefore created only via scripts/add-admin.mjs, the SQL Editor,
-- or the Neon platform — never from the web app.
--
-- Run: node scripts/apply-sql.mjs db/migrations/005_lock_admin_creation.sql
-- Then: neon data-api refresh-schema
-- ============================================================

create or replace function public.prevent_profile_role_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role and current_user <> 'neondb_owner' then
    raise exception 'Changing a profile role is not allowed from the application.';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_role_lock on public.profiles;
create trigger profiles_role_lock
  before update on public.profiles
  for each row
  execute function public.prevent_profile_role_change();

drop function if exists public.admin_create_user(text, text, text, text, text, text, text, text);

create or replace function public.admin_create_user(
  p_full_name text,
  p_employee_number text,
  p_username text,
  p_password_hash text,
  p_role text default 'employee',
  p_shift text default 'morning',
  p_department text default null,
  p_email text default null
)
returns json
language plpgsql
security definer
set search_path = public, neon_auth
as $$
declare
  v_is_admin boolean;
  v_new_id uuid := gen_random_uuid();
  v_clean_username text;
  v_clean_shift text;
  v_email text;
begin
  select public.is_admin() into v_is_admin;
  if not coalesce(v_is_admin, false) then
    return json_build_object('success', false, 'message', 'Unauthorized: Admin access required.');
  end if;

  -- Frontend lock: this function is callable by any signed-in admin session,
  -- so it must never mint another administrator.
  if lower(trim(coalesce(p_role, ''))) = 'admin' or p_email is not null then
    return json_build_object(
      'success', false,
      'message', 'Administrator accounts cannot be created from the application. Use the server-side script.'
    );
  end if;

  v_clean_username := lower(trim(coalesce(p_username, '')));
  if length(v_clean_username) < 3 then
    return json_build_object('success', false, 'message', 'Username must be at least 3 characters.');
  end if;
  if v_clean_username !~ '^[a-z0-9._-]+$' then
    return json_build_object('success', false, 'message', 'Username may only contain letters, numbers, dots, dashes and underscores.');
  end if;

  if trim(coalesce(p_full_name, '')) = '' or trim(coalesce(p_employee_number, '')) = '' then
    return json_build_object('success', false, 'message', 'Full name and Phone Number cannot be empty.');
  end if;

  if coalesce(p_password_hash, '') !~ '^[0-9a-f]{32}:[0-9a-f]{128}$' then
    return json_build_object('success', false, 'message', 'Invalid password hash provided.');
  end if;

  v_clean_shift := case when lower(trim(coalesce(p_shift, ''))) = 'afternoon' then 'afternoon' else 'morning' end;

  if exists (select 1 from public.profiles where username = v_clean_username) then
    return json_build_object('success', false, 'message', 'Username is already taken.');
  end if;
  if exists (select 1 from public.profiles where employee_number = trim(p_employee_number)) then
    return json_build_object('success', false, 'message', 'Phone Number is already taken.');
  end if;

  v_email := v_clean_username || '@attendance-login.example.com';
  if exists (select 1 from neon_auth.user where lower(email) = v_email) then
    return json_build_object('success', false, 'message', 'An account with that email already exists.');
  end if;

  insert into neon_auth.user (id, name, email, "emailVerified", role, banned, "createdAt", "updatedAt")
  values (v_new_id, trim(p_full_name), v_email, true, 'user', false, now(), now());

  insert into neon_auth.account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
  values (gen_random_uuid(), v_new_id::text, 'credential', v_new_id, p_password_hash, now(), now());

  insert into public.profiles (id, full_name, employee_number, username, role, department, shift, is_active, created_at)
  values (
    v_new_id,
    trim(p_full_name),
    trim(p_employee_number),
    v_clean_username,
    'employee',
    nullif(trim(p_department), ''),
    v_clean_shift,
    true,
    now()
  );

  return json_build_object(
    'success', true,
    'message', 'Employee account created successfully.',
    'id', v_new_id,
    'email', v_email
  );
exception
  when others then
    return json_build_object('success', false, 'message', SQLERRM);
end;
$$;

grant execute on function public.admin_create_user(text, text, text, text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
