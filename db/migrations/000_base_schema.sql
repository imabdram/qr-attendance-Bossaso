-- ============================================================
-- Migration 000: base schema for Neon (Lakebase Postgres) + Neon Auth
-- ============================================================
-- The hosted starter was built on Supabase, where `auth.users` and `auth.uid()`
-- came from Supabase Auth. On Neon the equivalent pieces are:
--   * users          -> neon_auth.user        (Managed Better Auth)
--   * auth.uid()     -> provided by pg_session_jwt (Data API sets the claims)
--   * Data API       -> PostgREST-compatible endpoint; RLS still applies
--
-- Run with: node scripts/apply-sql.mjs db/migrations/000_base_schema.sql
-- Then:     neon data-api refresh-schema
-- ============================================================

create extension if not exists pgcrypto;

-- 1) Tables ------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references neon_auth."user"(id) on delete cascade,
  full_name text not null,
  employee_number text not null unique,       -- the app labels this "Phone Number"
  username text not null unique,
  role text not null default 'employee' check (role in ('admin', 'employee')),
  department text,
  shift text not null default 'morning' check (shift in ('morning', 'afternoon')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null,
  work_date date not null,
  time_in timestamptz not null default now(),
  status text not null check (status in ('present', 'late')),
  shift text check (shift in ('morning', 'afternoon')),
  created_at timestamptz not null default now(),
  constraint attendance_employee_id_fkey
    foreign key (employee_id) references public.profiles(id) on delete restrict,
  constraint attendance_employee_id_work_date_key unique (employee_id, work_date)
);

create index if not exists attendance_work_date_idx on public.attendance (work_date);
create index if not exists attendance_employee_date_idx on public.attendance (employee_id, work_date desc);

create table if not exists public.qr_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists qr_tokens_expiry_idx on public.qr_tokens (expires_at);

create table if not exists public.app_settings (
  setting_key text primary key,
  setting_value text not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (setting_key, setting_value)
values
  ('late_after_morning', '09:00'),
  ('late_after_afternoon', '16:30'),
  ('late_after', '09:00')
on conflict (setting_key) do nothing;

-- 2) Helper used by the RLS policies --------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active = true
  );
$$;

-- 3) Row Level Security -------------------------------------------------

alter table public.profiles enable row level security;
alter table public.attendance enable row level security;
alter table public.qr_tokens enable row level security;
alter table public.app_settings enable row level security;

drop policy if exists "profile self read" on public.profiles;
create policy "profile self read" on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists "admin read profiles" on public.profiles;
create policy "admin read profiles" on public.profiles
  for select to authenticated using (public.is_admin());

drop policy if exists "admin update profiles" on public.profiles;
create policy "admin update profiles" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "employee read own attendance" on public.attendance;
create policy "employee read own attendance" on public.attendance
  for select to authenticated using (employee_id = auth.uid());

drop policy if exists "admin read attendance" on public.attendance;
create policy "admin read attendance" on public.attendance
  for select to authenticated using (public.is_admin());

drop policy if exists "authenticated read settings" on public.app_settings;
create policy "authenticated read settings" on public.app_settings
  for select to authenticated using (true);

drop policy if exists "admin update settings" on public.app_settings;
create policy "admin update settings" on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- qr_tokens deliberately has no policies: only SECURITY DEFINER functions touch it.

-- 4) Functions ----------------------------------------------------------

-- Employee check-in: validates the scanned QR hash, blocks Friday, decides
-- on-time/late in Africa/Mogadishu time, and enforces one row per day.
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

  v_shift := coalesce(v_profile.shift, 'morning');
  if v_shift = 'afternoon' then
    v_setting_key := 'late_after_afternoon';
  else
    v_setting_key := 'late_after_morning';
  end if;

  select setting_value into v_late_after
  from public.app_settings
  where setting_key = v_setting_key;

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
set search_path = public, neon_auth
as $$
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
    where employee_number = trim(p_employee_number) and id <> p_employee_id
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

  update neon_auth."user"
  set name = trim(p_full_name),
      "updatedAt" = now()
  where id = p_employee_id;

  return json_build_object('success', true, 'message', 'Employee profile updated successfully.');
exception
  when others then
    return json_build_object('success', false, 'message', SQLERRM);
end;
$$;

create or replace function public.admin_delete_employee(p_employee_id uuid)
returns json
language plpgsql
security definer
set search_path = public, neon_auth
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

  delete from public.attendance where employee_id = p_employee_id;
  delete from public.profiles where id = p_employee_id;
  delete from neon_auth.account where "userId" = p_employee_id;
  delete from neon_auth.session where "userId" = p_employee_id;
  delete from neon_auth."user" where id = p_employee_id;

  return json_build_object('success', true, 'message', 'Employee and associated records deleted successfully.');
exception
  when others then
    return json_build_object('success', false, 'message', SQLERRM);
end;
$$;

-- 5) Data API grants ----------------------------------------------------
-- RLS decides which rows are visible; these grants decide which operations
-- the PostgREST roles may attempt at all.

grant usage on schema public to authenticated, anonymous;

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.attendance to authenticated;
grant select on public.attendance to anonymous;
grant select on public.profiles to anonymous;
grant select, insert, update, delete on public.qr_tokens to authenticated;
grant select, insert, update, delete on public.app_settings to authenticated;
grant select on public.app_settings to anonymous;

grant execute on function public.is_admin() to authenticated, anonymous;
grant execute on function public.scan_attendance(text) to authenticated;
grant execute on function public.admin_update_employee(uuid, text, text, text, text) to authenticated;
grant execute on function public.admin_delete_employee(uuid) to authenticated;

notify pgrst, 'reload schema';
