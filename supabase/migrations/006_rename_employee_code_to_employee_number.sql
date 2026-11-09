-- ============================================================
-- Migration 006: rename profiles.employee_code to employee_number
-- and recreate the RPCs that used the old name.
--
-- Run this ENTIRE file in the Supabase SQL Editor.
-- If the editor reports a partial statement error, run the four
-- numbered sections below one at a time instead.
-- ============================================================

-- ============ SECTION 1: rename the column ===================
do $do$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'employee_code'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'employee_number'
  ) then
    alter table public.profiles rename column employee_code to employee_number;
  end if;
end
$do$;

-- ============ SECTION 2: admin_update_employee ================
drop function if exists public.admin_update_employee(uuid, text, text, text);
drop function if exists public.admin_update_employee(uuid, text, text, text, text);

create or replace function public.admin_update_employee(
  p_employee_id uuid,
  p_full_name text,
  p_employee_number text,
  p_department text,
  p_shift text default 'morning'
)
returns json
language plpgsql
security definer
set search_path = public, auth, extensions
as $body$
declare
  v_is_admin boolean;
  v_clean_shift text;
begin
  select public.is_admin() into v_is_admin;
  if not coalesce(v_is_admin, false) then
    return json_build_object('success', false, 'message', 'Unauthorized: Admin access required.');
  end if;

  if trim(coalesce(p_full_name, '')) = '' or trim(coalesce(p_employee_number, '')) = '' then
    return json_build_object('success', false, 'message', 'Full name and Phone Number cannot be empty.');
  end if;

  if exists (
    select 1 from public.profiles
    where employee_number = trim(p_employee_number)
      and id <> p_employee_id
  ) then
    return json_build_object('success', false, 'message', 'Phone Number is already in use by another person.');
  end if;

  v_clean_shift := case when lower(trim(coalesce(p_shift, ''))) = 'afternoon' then 'afternoon' else 'morning' end;

  update public.profiles
  set full_name = trim(p_full_name),
      employee_number = trim(p_employee_number),
      department = nullif(trim(p_department), ''),
      shift = v_clean_shift
  where id = p_employee_id;

  update auth.users
  set raw_user_meta_data = jsonb_set(coalesce(raw_user_meta_data, '{}'::jsonb), '{full_name}', to_jsonb(trim(p_full_name))),
      updated_at = now()
  where id = p_employee_id;

  return json_build_object('success', true, 'message', 'Employee profile updated successfully.');
exception
  when others then
    return json_build_object('success', false, 'message', SQLERRM);
end;
$body$;

grant execute on function public.admin_update_employee(uuid, text, text, text, text) to authenticated;

-- ============ SECTION 3: admin_create_user ====================
drop function if exists public.admin_create_user(text, text, text, text, text, text, text);

create or replace function public.admin_create_user(
  p_full_name text,
  p_employee_number text,
  p_username text,
  p_password text,
  p_role text default 'employee',
  p_shift text default 'morning',
  p_department text default null
)
returns json
language plpgsql
security definer
set search_path = public, auth, extensions
as $body$
declare
  v_is_admin boolean;
  v_new_id uuid;
  v_clean_username text;
  v_clean_role text;
  v_clean_shift text;
  v_email text;
  v_encrypted_pw text;
begin
  select public.is_admin() into v_is_admin;
  if not coalesce(v_is_admin, false) then
    return json_build_object('success', false, 'message', 'Unauthorized: Admin access required.');
  end if;

  v_clean_username := lower(trim(coalesce(p_username, '')));
  if v_clean_username = '' or length(v_clean_username) < 3 then
    return json_build_object('success', false, 'message', 'Username must be at least 3 characters.');
  end if;

  if trim(coalesce(p_full_name, '')) = '' or trim(coalesce(p_employee_number, '')) = '' then
    return json_build_object('success', false, 'message', 'Full name and Phone Number cannot be empty.');
  end if;

  if length(coalesce(p_password, '')) < 8 then
    return json_build_object('success', false, 'message', 'Password must be at least 8 characters.');
  end if;

  v_clean_role := case when lower(trim(coalesce(p_role, ''))) = 'admin' then 'admin' else 'employee' end;
  v_clean_shift := case when lower(trim(coalesce(p_shift, ''))) = 'afternoon' then 'afternoon' else 'morning' end;

  if exists (select 1 from public.profiles where username = v_clean_username) then
    return json_build_object('success', false, 'message', 'Username is already taken.');
  end if;

  if exists (select 1 from public.profiles where employee_number = trim(p_employee_number)) then
    return json_build_object('success', false, 'message', 'Phone Number is already taken.');
  end if;

  v_email := v_clean_username || '@attendance-login.example.com';
  v_new_id := gen_random_uuid();
  v_encrypted_pw := extensions.crypt(p_password, extensions.gen_salt('bf'));

  insert into auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at
  ) values (
    v_new_id,
    '00000000-0000-0000-0000-000000000000',
    v_email,
    v_encrypted_pw,
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', trim(p_full_name)),
    'authenticated',
    'authenticated',
    now(),
    now()
  );

  insert into public.profiles (
    id, full_name, employee_number, username, role,
    department, shift, is_active, created_at
  ) values (
    v_new_id,
    trim(p_full_name),
    trim(p_employee_number),
    v_clean_username,
    v_clean_role,
    nullif(trim(p_department), ''),
    v_clean_shift,
    true,
    now()
  );

  return json_build_object(
    'success', true,
    'message', case when v_clean_role = 'admin' then 'Admin account created successfully.' else 'Employee account created successfully.' end,
    'id', v_new_id
  );
exception
  when others then
    return json_build_object('success', false, 'message', SQLERRM);
end;
$body$;

grant execute on function public.admin_create_user(text, text, text, text, text, text, text) to authenticated;

-- ============ SECTION 4: reload schema cache ==================
notify pgrst, 'reload schema';

-- Verify:
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'profiles'
  and column_name in ('employee_code', 'employee_number');
