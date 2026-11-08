-- Functions for Employee Management by Admin

-- 1. Delete Employee
create or replace function public.admin_delete_employee(p_employee_id uuid)
returns json
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_is_admin boolean;
  v_target_role text;
begin
  select public.is_admin() into v_is_admin;
  if not coalesce(v_is_admin, false) then
    return json_build_object('success', false, 'message', 'Unauthorized: Admin access required.');
  end if;

  select role into v_target_role from public.profiles where id = p_employee_id;
  if v_target_role is null then
    return json_build_object('success', false, 'message', 'Employee not found.');
  end if;

  if v_target_role = 'admin' then
    return json_build_object('success', false, 'message', 'Cannot delete an administrator account.');
  end if;

  -- Delete attendance records
  delete from public.attendance where employee_id = p_employee_id;

  -- Delete profile
  delete from public.profiles where id = p_employee_id;

  -- Delete auth user
  delete from auth.users where id = p_employee_id;

  return json_build_object('success', true, 'message', 'Employee and associated records deleted successfully.');
exception
  when others then
    return json_build_object('success', false, 'message', SQLERRM);
end;
$$;

-- 2. Reset Employee Password
create or replace function public.admin_reset_password(p_employee_id uuid, p_new_password text)
returns json
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_is_admin boolean;
  v_target_role text;
begin
  select public.is_admin() into v_is_admin;
  if not coalesce(v_is_admin, false) then
    return json_build_object('success', false, 'message', 'Unauthorized: Admin access required.');
  end if;

  if length(coalesce(p_new_password, '')) < 8 then
    return json_build_object('success', false, 'message', 'Password must be at least 8 characters long.');
  end if;

  select role into v_target_role from public.profiles where id = p_employee_id;
  if v_target_role is null then
    return json_build_object('success', false, 'message', 'Employee not found.');
  end if;

  update auth.users
  set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
      updated_at = now()
  where id = p_employee_id;

  return json_build_object('success', true, 'message', 'Password reset successfully.');
exception
  when others then
    return json_build_object('success', false, 'message', SQLERRM);
end;
$$;

-- 3. Update Employee Profile
create or replace function public.admin_update_employee(
  p_employee_id uuid,
  p_full_name text,
  p_employee_code text,
  p_department text
)
returns json
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_is_admin boolean;
begin
  select public.is_admin() into v_is_admin;
  if not coalesce(v_is_admin, false) then
    return json_build_object('success', false, 'message', 'Unauthorized: Admin access required.');
  end if;

  if trim(coalesce(p_full_name, '')) = '' or trim(coalesce(p_employee_code, '')) = '' then
    return json_build_object('success', false, 'message', 'Full name and Employee ID cannot be empty.');
  end if;

  -- Check if employee_code is taken by someone else
  if exists (select 1 from public.profiles where employee_code = trim(p_employee_code) and id <> p_employee_id) then
    return json_build_object('success', false, 'message', 'Employee ID is already in use by another person.');
  end if;

  update public.profiles
  set full_name = trim(p_full_name),
      employee_code = trim(p_employee_code),
      department = nullif(trim(p_department), '')
  where id = p_employee_id;

  -- Also update raw_user_meta_data if present
  update auth.users
  set raw_user_meta_data = jsonb_set(coalesce(raw_user_meta_data, '{}'::jsonb), '{full_name}', to_jsonb(trim(p_full_name))),
      updated_at = now()
  where id = p_employee_id;

  return json_build_object('success', true, 'message', 'Employee profile updated successfully.');
exception
  when others then
    return json_build_object('success', false, 'message', SQLERRM);
end;
$$;
