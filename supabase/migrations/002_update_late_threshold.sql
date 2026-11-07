-- Update late_after threshold to 09:00
update public.app_settings
set setting_value = '09:00',
    updated_at = now()
where setting_key = 'late_after';

-- In case row does not exist yet
insert into public.app_settings (setting_key, setting_value, updated_at)
values ('late_after', '09:00', now())
on conflict (setting_key) do update
set setting_value = excluded.setting_value,
    updated_at = excluded.updated_at;
