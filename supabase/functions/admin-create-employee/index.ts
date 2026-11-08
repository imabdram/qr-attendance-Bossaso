import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const auth = req.headers.get('Authorization');
    if (!auth) return json({ message: 'Authentication required.' }, 401);
    const body = await req.json();
    const { full_name, employee_code, username, password, department, shift } = body;
    const cleanUsername = String(username || '').trim().toLowerCase();
    const email = cleanUsername + '@attendance-login.example.com';
    const cleanShift = shift === 'afternoon' ? 'afternoon' : 'morning';

    if (
      !full_name ||
      !employee_code ||
      !cleanUsername ||
      !/^[a-z0-9._-]{3,32}$/.test(cleanUsername) ||
      !password ||
      password.length < 8
    )
      return json(
        {
          message:
            'Complete all required fields. Password must be at least 8 characters.',
        },
        400
      );
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
    if (userErr || !user) return json({ message: 'Invalid session.' }, 401);
    const db = createClient(url, service);
    const { data: admin } = await db
      .from('profiles')
      .select('role,is_active')
      .eq('id', user.id)
      .single();
    if (admin?.role !== 'admin' || !admin.is_active)
      return json({ message: 'Administrator access required.' }, 403);
    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });
    if (createErr) throw createErr;
    const { error: profileErr } = await db.from('profiles').insert({
      id: created.user.id,
      full_name,
      employee_code,
      username: cleanUsername,
      role: 'employee',
      department: department || null,
      shift: cleanShift,
      is_active: true,
    });
    if (profileErr) {
      await db.auth.admin.deleteUser(created.user.id);
      throw profileErr;
    }
    return json({ success: true, message: 'Employee account created.' });
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : 'Could not create employee.';
    return json({ success: false, message: msg }, 400);
  }
});
