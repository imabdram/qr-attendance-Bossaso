import { createClient } from '@supabase/supabase-js';

// Prefer the new publishable key. If Vercel still has an old ANON key set,
// using it together with the new project URL would break authentication.
const clean = (value: unknown) => String(value ?? '').trim().replace(/^["']|["']$/g, '');

const url = clean(import.meta.env.VITE_SUPABASE_URL);
const key = clean(
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY
);

export const isSupabaseConfigured = Boolean(
  url &&
  key &&
  !url.includes('YOUR_PROJECT') &&
  !url.includes('example.supabase.co') &&
  !key.includes('YOUR_SUPABASE_ANON_KEY') &&
  !key.includes('missing-anon-key')
);

export const supabase = createClient(
  url || 'https://example.supabase.co',
  key || 'missing-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
