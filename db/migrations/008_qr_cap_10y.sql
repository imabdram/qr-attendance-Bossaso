-- ============================================================
-- Migration 008: raise the token ceiling to 10 years
-- ============================================================
-- The "Changed by Hand" mode is meant to stay put indefinitely ("even if it is
-- never changed"). A 1-year cap would silently expire a poster that nobody
-- touched, so the ceiling is now 10 years. Rotation intervals stay well under it.
--
-- Run: node scripts/apply-sql.mjs db/migrations/008_qr_cap_10y.sql
-- Then: neon data-api refresh-schema
-- ============================================================

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
  if v_duration < 30 then
    v_duration := 30;
  end if;
  -- Hard ceiling: ten years ("stays until changed by hand").
  if v_duration > 315360000 then
    v_duration := 315360000;
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

notify pgrst, 'reload schema';
