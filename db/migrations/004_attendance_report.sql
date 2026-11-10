-- ============================================================
-- Migration 004: attendance report with Present / Late / Absent
-- ============================================================
-- The Reports screen used to list only attendance rows, so an employee who
-- never checked in simply did not appear. This function builds the full grid:
-- every employee × every working day in the range (Friday is the weekly day
-- off), left-joined to attendance, with status = 'absent' when no row exists.
-- It is admin-only and SECURITY DEFINER so RLS cannot hide other employees.
--
-- Run: node scripts/apply-sql.mjs db/migrations/004_attendance_report.sql
-- Then: neon data-api refresh-schema
-- ============================================================

create or replace function public.attendance_report(p_from date, p_to date)
returns table (
  work_date date,
  employee_id uuid,
  full_name text,
  employee_number text,
  department text,
  shift text,
  time_in timestamptz,
  status text
)
language sql
stable
security definer
set search_path = public
as $$
  with days as (
    select g::date as work_date
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
    -- Friday is the weekly day off; it is neither present nor absent.
    where to_char(g, 'Dy') <> 'Fri'
  ),
  emps as (
    select p.id, p.full_name, p.employee_number, p.department, p.shift, p.created_at
    from public.profiles p
    where p.role = 'employee'
      and (
        p.is_active
        or exists (
          select 1
          from public.attendance a
          where a.employee_id = p.id
            and a.work_date between p_from and p_to
        )
      )
  )
  select d.work_date,
         e.id as employee_id,
         e.full_name,
         e.employee_number,
         e.department,
         coalesce(a.shift, e.shift) as shift,
         a.time_in,
         coalesce(a.status, 'absent') as status
  from days d
  join emps e on e.created_at::date <= d.work_date
  left join public.attendance a
    on a.employee_id = e.id
   and a.work_date = d.work_date
  where public.is_admin()
  order by d.work_date, e.full_name;
$$;

grant execute on function public.attendance_report(date, date) to authenticated;

notify pgrst, 'reload schema';
