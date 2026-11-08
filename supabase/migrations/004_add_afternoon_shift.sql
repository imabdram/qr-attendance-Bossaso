-- Migration 004: Add Afternoon Shift support and shift-specific late threshold

-- 1. Add shift column to profiles table
alter table public.profiles
add column if not exists shift text not null default 'morning' check (shift in ('morning', 'afternoon'));

-- 2. Add shift column to attendance table
alter table public.attendance
add column if not exists shift text check (shift in ('morning', 'afternoon'));

-- 3. Insert shift-specific late threshold settings
insert into public.app_settings (setting_key, setting_value, updated_at)
values ('late_after_afternoon', '16:30', now())
on conflict (setting_key) do nothing;

insert into public.app_settings (setting_key, setting_value, updated_at)
values ('late_after_morning', '09:00', now())
on conflict (setting_key) do nothing;

-- 4. Update scan_attendance database RPC function to respect employee's shift
create or replace function public.scan_attendance(p_token text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_profile public.profiles%rowtype;
  v_token_hash text;
  v_qr_id uuid;
  v_weekday text;
  v_work_date date;
  v_existing_id uuid;
  v_existing_time timestamptz;
  v_late_after text;
  v_setting_key text;
  v_local_time text;
  v_status text;
  v_new_time timestamptz;
  v_shift text;
begin
  if p_token is null or length(p_token) < 32 then
    return json_build_object('success', false, 'message', 'Invalid QR code.');
  end if;

  select * into v_profile
  from public.profiles
  where id = auth.uid();

  if v_profile.id is null or v_profile.role <> 'employee' or not v_profile.is_active then
    return json_build_object('success', false, 'message', 'This account is not active for employee attendance.');
  end if;

  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  select id into v_qr_id
  from public.qr_tokens
  where token_hash = v_token_hash and expires_at > now()
  limit 1;

  if v_qr_id is null then
    return json_build_object('success', false, 'message', 'This QR code has expired. Scan the current office QR code.');
  end if;

  -- Africa/Mogadishu is UTC+3
  v_weekday := to_char(timezone('Africa/Mogadishu', now()), 'Dy');
  if v_weekday = 'Fri' then
    return json_build_object('success', false, 'message', 'Friday is the weekly day off. Attendance is not recorded today.');
  end if;

  v_work_date := (timezone('Africa/Mogadishu', now()))::date;

  select id, time_in into v_existing_id, v_existing_time
  from public.attendance
  where employee_id = v_profile.id and work_date = v_work_date
  limit 1;

  if v_existing_id is not null then
    return json_build_object('success', true, 'message', 'Your attendance was already recorded today.', 'time_in', v_existing_time, 'already_recorded', true);
  end if;

  -- Determine employee shift (default to morning)
  v_shift := coalesce(v_profile.shift, 'morning');

  if v_shift = 'afternoon' then
    v_setting_key := 'late_after_afternoon';
  else
    v_setting_key := 'late_after_morning';
  end if;

  select setting_value into v_late_after
  from public.app_settings
  where setting_key = v_setting_key;

  -- Fallback to legacy late_after setting or defaults if not configured
  if v_late_after is null then
    if v_shift = 'afternoon' then
      v_late_after := '16:30';
    else
      select setting_value into v_late_after
      from public.app_settings
      where setting_key = 'late_after';
      if v_late_after is null then
        v_late_after := '09:00';
      end if;
    end if;
  end if;

  v_local_time := to_char(timezone('Africa/Mogadishu', now()), 'HH24:MI');
  if v_local_time > v_late_after then
    v_status := 'late';
  else
    v_status := 'present';
  end if;

  v_new_time := now();

  insert into public.attendance (employee_id, work_date, time_in, status, shift)
  values (v_profile.id, v_work_date, v_new_time, v_status, v_shift);

  return json_build_object('success', true, 'message', 'Your attendance has been recorded successfully.', 'time_in', v_new_time, 'status', v_status, 'shift', v_shift);
exception
  when unique_violation then
    return json_build_object('success', true, 'message', 'Your attendance has already been recorded today.', 'already_recorded', true);
  when others then
    return json_build_object('success', false, 'message', SQLERRM);
end;
$$;

grant execute on function public.scan_attendance(text) to authenticated;

-- 5. Update admin_update_employee RPC to allow updating employee shift
create or replace function public.admin_update_employee(
  p_employee_id uuid,
  p_full_name text,
  p_employee_code text,
  p_department text,
  p_shift text default 'morning'
)
returns json
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_is_admin boolean;
  v_clean_shift text;
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

  v_clean_shift := case when lower(trim(coalesce(p_shift, ''))) = 'afternoon' then 'afternoon' else 'morning' end;

  update public.profiles
  set full_name = trim(p_full_name),
      employee_code = trim(p_employee_code),
      department = nullif(trim(p_department), ''),
      shift = v_clean_shift
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

grant execute on function public.admin_update_employee(uuid, text, text, text, text) to authenticated;
