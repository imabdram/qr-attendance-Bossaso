import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL || '') as string;
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '') as string;

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
