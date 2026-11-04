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
    if (!auth) return json({ message: 'Authentication required.' }, 401);

    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) return json({ message: 'Invalid session.' }, 401);

    const db = createClient(url, service);
    const { data: profile } = await db
      .from('profiles')
      .select('role,is_active')
      .eq('id', user.id)
      .single();
    if (profile?.role !== 'admin' || !profile.is_active) {
      return json({ message: 'Administrator access required.' }, 403);
    }

    let durationMs = 45000;
    try {
      const text = await req.text();
      if (text) {
        const body = JSON.parse(text);
        if (typeof body.duration_seconds === 'number' && body.duration_seconds > 0) {
          durationMs = body.duration_seconds * 1000;
        }
      }
    } catch {
      // Body was empty or non-JSON, default to 45 seconds
    }

    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = hex(bytes.buffer);
    const tokenHash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    const expiresAt = new Date(Date.now() + durationMs).toISOString();

    const { error } = await db.from('qr_tokens').insert({ token_hash: tokenHash, expires_at: expiresAt });
    if (error) throw error;

    // Delete expired tokens older than 1 hour (only if they are short-lived expired tokens)
    await db.from('qr_tokens').delete().lt('expires_at', new Date(Date.now() - 3600000).toISOString());

    return json({ token, expires_at: expiresAt });
  } catch (e) {
    console.error(e);
    return json({ message: 'Could not generate a QR token.' }, 500);
  }
});
