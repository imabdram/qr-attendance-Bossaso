-- Migration 008: make accounts created by the app able to sign in.
-- GoTrue expects token columns to be empty strings, not NULL, and requires
-- an auth.identities row for the email provider.

-- Repair existing users created by admin_create_user.
update auth.users
set confirmation_token = coalesce(confirmation_token, ''),
    recovery_token = coalesce(recovery_token, ''),
    email_change_token_new = coalesce(email_change_token_new, ''),
    email_change = coalesce(email_change, '')
where confirmation_token is null
   or recovery_token is null
   or email_change_token_new is null
   or email_change is null;

insert into auth.identities (
  id,
  provider_id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
select
  gen_random_uuid(),
  u.id::text,
  u.id,
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', u.email_confirmed_at is not null,
    'phone_verified', false
  ),
  'email',
  now(),
  now(),
  now()
from auth.users u
left join auth.identities i
  on i.user_id = u.id and i.provider = 'email'
where u.email is not null
  and i.id is null
on conflict (provider_id, provider) do nothing;

-- Recreate admin_create_user with the required auth columns + identity row.
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
    confirmation_token, recovery_token, email_change_token_new, email_change,
    raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at
  ) values (
    v_new_id,
    '00000000-0000-0000-0000-000000000000',
    v_email,
    v_encrypted_pw,
    now(),
    '', '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', trim(p_full_name)),
    'authenticated',
    'authenticated',
    now(),
    now()
  );

  insert into auth.identities (
    id, provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(),
    v_new_id::text,
    v_new_id,
    jsonb_build_object(
      'sub', v_new_id::text,
      'email', v_email,
      'email_verified', true,
      'phone_verified', false
    ),
    'email',
    now(), now(), now()
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

notify pgrst, 'reload schema';
