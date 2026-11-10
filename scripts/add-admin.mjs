/**
 * Create an administrator (or reset an existing admin's password).
 *
 *   node scripts/add-admin.mjs <email> <password> ["Full Name"] [username]
 *
 * Example:
 *   node scripts/add-admin.mjs name@example.com 'A-Strong-Password' "Full Name"
 *
 * Running it again with the same email sets a new password.
 *
 * This writes directly to the database with DATABASE_URL_UNPOOLED. The web app
 * intentionally cannot create administrators: `admin_create_user` rejects
 * `p_role = 'admin'`, and a trigger blocks role changes from PostgREST.
 */
import { scryptSync, randomBytes } from 'node:crypto';
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

const [email, password, fullName, usernameArg] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/add-admin.mjs <email> <password> ["Full Name"] [username]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const local = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
const username = (usernameArg || local).toLowerCase();
const name = fullName || local;
const phone = 'ADMIN-' + username.toUpperCase();

/** Better Auth scrypt format: <32 hex salt>:<128 hex key>. */
function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(pw.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  }).toString('hex');
  return `${salt}:${key}`;
}

const hash = hashPassword(password);
const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
const client = await pool.connect();

try {
  await client.query('begin');

  const existing = await client.query(
    'select id from neon_auth.user where lower(email) = lower($1)',
    [email]
  );

  let userId;
  if (existing.rowCount > 0) {
    userId = existing.rows[0].id;
    await client.query('update neon_auth.user set name = $2, "updatedAt" = now() where id = $1', [
      userId,
      name,
    ]);
    console.log(`Account ${email} already existed — updating it.`);
  } else {
    const inserted = await client.query(
      `insert into neon_auth.user (id, name, email, "emailVerified", role, banned, "createdAt", "updatedAt")
       values (gen_random_uuid(), $1, $2, true, 'user', false, now(), now())
       returning id`,
      [name, email]
    );
    userId = inserted.rows[0].id;
  }

  const updated = await client.query(
    `update neon_auth.account
        set password = $1, "updatedAt" = now()
      where "userId" = $2 and "providerId" = 'credential'`,
    [hash, userId]
  );
  if (updated.rowCount === 0) {
    await client.query(
      `insert into neon_auth.account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       values (gen_random_uuid(), $1::text, 'credential', $2::uuid, $3, now(), now())`,
      [userId, userId, hash]
    );
  }

  await client.query(
    `insert into public.profiles (id, full_name, employee_number, username, role, department, shift, is_active)
     values ($1, $2, $3, $4, 'admin', 'Management', 'morning', true)
     on conflict (id) do update
       set role = 'admin',
           is_active = true,
           full_name = excluded.full_name`,
    [userId, name, phone, username]
  );

  await client.query('delete from neon_auth.session where "userId" = $1', [userId]);
  await client.query('commit');

  console.log(`Admin ready: ${email} (username ${username})`);
  console.log('Password set. Sign in with the full email address.');
} catch (err) {
  await client.query('rollback');
  if (err.code === '23505') {
    console.error('Failed: that username or admin ID is already used by another profile.');
  } else {
    console.error('Failed:', err.message);
  }
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
