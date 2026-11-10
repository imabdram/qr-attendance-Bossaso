/**
 * Break-glass password reset — no admin login required.
 *
 *   node scripts/reset-password.mjs <email-or-username> <new-password>
 *
 * Use this when the only administrator has forgotten their password (the app's
 * Reset password screen needs an existing admin session, and the shared SMTP
 * cannot deliver to @attendance-login.example.com addresses).
 *
 * It writes the same scrypt hash Better Auth verifies directly into
 * neon_auth.account, then drops that user's sessions.
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

const [identifier, newPassword] = process.argv.slice(2);
if (!identifier || !newPassword) {
  console.error('Usage: node scripts/reset-password.mjs <email-or-username> <new-password>');
  process.exit(1);
}
if (newPassword.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

/** Better Auth scrypt format: <32 hex salt>:<128 hex key>. */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  }).toString('hex');
  return `${salt}:${key}`;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
try {
  const { rows } = await pool.query(
    `select u.id, u.email, p.username, p.full_name, p.role
       from neon_auth.user u
       left join public.profiles p on p.id = u.id
      where lower(u.email) = lower($1) or lower(p.username) = lower($1)
      limit 1`,
    [identifier]
  );
  const user = rows[0];
  if (!user) {
    console.error(`No account found for "${identifier}" (tried email and username).`);
    process.exit(1);
  }

  const hash = hashPassword(newPassword);
  const updated = await pool.query(
    `update neon_auth.account
        set password = $1, "updatedAt" = now()
      where "userId" = $2 and "providerId" = 'credential'`,
    [hash, user.id]
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `insert into neon_auth.account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       values (gen_random_uuid(), $1::text, 'credential', $1, $2, now(), now())`,
      [user.id, hash]
    );
  }
  await pool.query('delete from neon_auth.session where "userId" = $1', [user.id]);

  console.log(`Password reset for ${user.email}${user.username ? ` (username ${user.username})` : ''} — role ${user.role ?? 'unknown'}.`);
  console.log('Existing sessions were signed out. Sign in with the new password.');
} catch (err) {
  console.error('Reset failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
