import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const auth = req.headers.get('Authorization');
    if (!auth) return json({ message: 'Please sign in first.' }, 401);
    const { token } = await req.json();
    if (typeof token !== 'string' || token.length < 32)
      return json({ message: 'Invalid QR code.' }, 400);

    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: auth } },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user)
      return json({ message: 'Your session has expired. Sign in again.' }, 401);

    const db = createClient(url, service);
    const { data: profile } = await db
      .from('profiles')
      .select('id,role,is_active,shift')
      .eq('id', user.id)
      .single();
    if (!profile || profile.role !== 'employee' || !profile.is_active)
      return json(
        { message: 'This account is not active for employee attendance.' },
        403
      );

    const tokenHash = hex(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    );
    const now = new Date().toISOString();
    const { data: qr } = await db
      .from('qr_tokens')
      .select('id,expires_at')
      .eq('token_hash', tokenHash)
      .gt('expires_at', now)
      .maybeSingle();
    if (!qr)
      return json(
        { message: 'This QR code has expired. Scan the current office QR code.' },
        400
      );

    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Mogadishu',
      weekday: 'short',
    }).format(new Date());
    if (weekday === 'Fri')
      return json(
        {
          message:
            'Friday is the weekly day off. Attendance is not recorded today.',
        },
        400
      );

    const workDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Mogadishu',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const { data: existing } = await db
      .from('attendance')
      .select('id,time_in')
      .eq('employee_id', user.id)
      .eq('work_date', workDate)
      .maybeSingle();
    if (existing)
      return json({
        success: true,
        message: 'Your attendance was already recorded today.',
        time_in: existing.time_in,
        already_recorded: true,
      });

    const shift = profile.shift === 'afternoon' ? 'afternoon' : 'morning';
    const settingKey =
      shift === 'afternoon' ? 'late_after_afternoon' : 'late_after_morning';

    let lateAfter = shift === 'afternoon' ? '16:30' : '09:00';
    const { data: setting } = await db
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', settingKey)
      .maybeSingle();

    if (setting?.setting_value) {
      lateAfter = setting.setting_value;
    } else if (shift === 'morning') {
      const { data: legacy } = await db
        .from('app_settings')
        .select('setting_value')
        .eq('setting_key', 'late_after')
        .maybeSingle();
      if (legacy?.setting_value) lateAfter = legacy.setting_value;
    }

    const localTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Mogadishu',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());

    const status = localTime > lateAfter ? 'late' : 'present';

    const { data: record, error } = await db
      .from('attendance')
      .insert({
        employee_id: user.id,
        work_date: workDate,
        time_in: now,
        status,
        shift,
      })
      .select('time_in')
      .single();
    if (error) {
      if (error.code === '23505')
        return json(
          { message: 'Your attendance has already been recorded today.' },
          409
        );
      throw error;
    }

    return json({
      success: true,
      message: 'Your attendance has been recorded successfully.',
      time_in: record.time_in,
      status,
      shift,
    });
  } catch (e) {
    console.error(e);
    return json(
      { message: 'An unexpected error occurred while recording attendance.' },
      500
    );
  }
});
