/**
 * Bootstrap the first administrator on a fresh Neon project.
 *
 *   node scripts/bootstrap-admin.mjs
 *
 * Creates the Neon Auth (Better Auth) user with ADMIN_EMAIL / ADMIN_PASSWORD from
 * .env.local, then inserts the matching row in public.profiles with role=admin.
 * Safe to re-run: an existing account is reused and promoted.
 */
import { readFileSync } from 'node:fs';
import { Pool } from '@neondatabase/serverless';

function loadEnvLocal() {
  const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    process.env[m[1]] ??= v;
  }
}
loadEnvLocal();

const AUTH = process.env.NEON_AUTH_BASE_URL.replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const ORIGIN = process.env.APP_ORIGIN || 'http://localhost:5173';

if (!EMAIL || !PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env.local');
  process.exit(1);
}

const post = (path, body) =>
  fetch(`${AUTH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(body),
  });

let userId = null;
let res = await post('/sign-up/email', { email: EMAIL, password: PASSWORD, name: 'Bossaso Administrator' });

if (res.ok) {
  const data = await res.json();
  userId = data?.user?.id ?? null;
  console.log('Created Neon Auth user', EMAIL);
} else {
  const body = await res.text();
  // Already created on a previous run: sign in to recover the id.
  res = await post('/sign-in/email', { email: EMAIL, password: PASSWORD });
  if (!res.ok) {
    console.error(`Sign-up failed (${body}); sign-in also failed: ${await res.text()}`);
    process.exit(1);
  }
  const cookie = res.headers.getSetCookie?.()[0]?.split(';')[0];
  const session = await fetch(`${AUTH}/get-session`, { headers: { Origin: ORIGIN, Cookie: cookie } });
  const data = await session.json();
  userId = data?.user?.id ?? data?.session?.user?.id ?? null;
  console.log('Neon Auth user already existed; reusing', EMAIL);
}

if (!userId) {
  console.error('Could not determine the Auth user id.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
try {
  await pool.query(
    `insert into public.profiles (id, full_name, employee_number, username, role, department, shift, is_active)
     values ($1, 'Bossaso Administrator', 'ADMIN-001', 'admin', 'admin', 'Management', 'morning', true)
     on conflict (id) do update
       set role = 'admin', is_active = true, full_name = excluded.full_name`,
    [userId]
  );
  const { rows } = await pool.query('select id, username, role, is_active from public.profiles where id = $1', [userId]);
  console.log('Admin profile:', JSON.stringify(rows[0]));
} finally {
  await pool.end();
}
