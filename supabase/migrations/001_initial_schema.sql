-- Run this schema in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  employee_number text not null unique,
  username text not null unique,
  role text not null default 'employee' check(role in ('admin','employee')),
  department text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete restrict,
  work_date date not null,
  time_in timestamptz not null default now(),
  status text not null check(status in ('present','late')),
  created_at timestamptz not null default now(),
  unique(employee_id, work_date)
);

create index if not exists attendance_work_date_idx on public.attendance(work_date);
create index if not exists attendance_employee_date_idx on public.attendance(employee_id, work_date desc);

create table if not exists public.qr_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists qr_tokens_expiry_idx on public.qr_tokens(expires_at);

create table if not exists public.app_settings (
  setting_key text primary key,
  setting_value text not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings(setting_key, setting_value)
values('late_after', '09:00')
on conflict(setting_key) do nothing;

alter table public.profiles enable row level security;
alter table public.attendance enable row level security;
alter table public.qr_tokens enable row level security;
alter table public.app_settings enable row level security;

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles where id=auth.uid() and role='admin' and is_active=true);
$$;

-- Drop policies before re-creating to ensure idempotent runs
drop policy if exists "profile self read" on public.profiles;
create policy "profile self read" on public.profiles for select to authenticated using(id=auth.uid());

drop policy if exists "admin read profiles" on public.profiles;
create policy "admin read profiles" on public.profiles for select to authenticated using(public.is_admin());

drop policy if exists "admin update profiles" on public.profiles;
create policy "admin update profiles" on public.profiles for update to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "employee read own attendance" on public.attendance;
create policy "employee read own attendance" on public.attendance for select to authenticated using(employee_id=auth.uid());

drop policy if exists "admin read attendance" on public.attendance;
create policy "admin read attendance" on public.attendance for select to authenticated using(public.is_admin());

drop policy if exists "authenticated read settings" on public.app_settings;
create policy "authenticated read settings" on public.app_settings for select to authenticated using(true);

drop policy if exists "admin update settings" on public.app_settings;
create policy "admin update settings" on public.app_settings for update to authenticated using(public.is_admin()) with check(public.is_admin());

-- Safely add attendance to supabase_realtime publication
do $$
begin
  if not exists (
    select 1 from pg_publication_tables 
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attendance'
  ) then
    alter publication supabase_realtime add table public.attendance;
  end if;
end $$;

-- Database Functions (RPC) as high-performance, zero-cold-start alternatives to Edge Functions:
create or replace function public.create_qr_token(p_duration_seconds integer default 45)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_role text;
  v_is_active boolean;
  v_token text;
  v_token_hash text;
  v_expires_at timestamptz;
  v_duration int;
begin
  select role, is_active into v_user_role, v_is_active
  from public.profiles
  where id = auth.uid();

  if v_user_role is distinct from 'admin' or v_is_active is not true then
    return json_build_object('error', 'Administrator access required.');
  end if;

  v_duration := coalesce(p_duration_seconds, 45);
  if v_duration < 5 then
    v_duration := 5;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
  v_expires_at := now() + (v_duration || ' seconds')::interval;

  insert into public.qr_tokens (token_hash, expires_at)
  values (v_token_hash, v_expires_at);

  delete from public.qr_tokens where expires_at < now() - interval '1 hour';

  return json_build_object('token', v_token, 'expires_at', v_expires_at);
end;
$$;

grant execute on function public.create_qr_token(integer) to authenticated;

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
  v_local_time text;
  v_status text;
  v_new_time timestamptz;
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

  select setting_value into v_late_after
  from public.app_settings
  where setting_key = 'late_after';

  if v_late_after is null then
    v_late_after := '09:00';
  end if;

  v_local_time := to_char(timezone('Africa/Mogadishu', now()), 'HH24:MI');
  if v_local_time > v_late_after then
    v_status := 'late';
  else
    v_status := 'present';
  end if;

  v_new_time := now();

  insert into public.attendance (employee_id, work_date, time_in, status)
  values (v_profile.id, v_work_date, v_new_time, v_status);

  return json_build_object('success', true, 'message', 'Your attendance has been recorded successfully.', 'time_in', v_new_time, 'status', v_status);
exception
  when unique_violation then
    return json_build_object('success', true, 'message', 'Your attendance has already been recorded today.', 'already_recorded', true);
  when others then
    return json_build_object('success', false, 'message', SQLERRM);
end;
$$;

grant execute on function public.scan_attendance(text) to authenticated;
