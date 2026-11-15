-- ============================================================
-- Migration 007: restore is_admin() for this application
-- ============================================================
-- The database was shared with another schema: is_admin() had been redefined to
-- read public.users (auth_user_id / active), a table that is empty for this app.
-- That made every admin check return false — admin RPCs, QR revocation, and the
-- admin RLS policies all failed with "Unauthorized: Admin access required".
--
-- This restores the attendance-app definition: a profile row with role='admin'.
--
-- Run: node scripts/apply-sql.mjs db/migrations/007_restore_is_admin.sql
-- Then: neon data-api refresh-schema
-- ============================================================

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and is_active = true
  );
$$;

grant execute on function public.is_admin() to authenticated, anonymous;

notify pgrst, 'reload schema';
