-- Migration 007: allow admins to insert app settings (needed for upsert from the dashboard)
drop policy if exists "admin insert settings" on public.app_settings;

create policy "admin insert settings"
on public.app_settings
for insert
to authenticated
with check (public.is_admin());
