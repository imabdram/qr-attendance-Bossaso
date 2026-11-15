/**
 * Restores a backup produced by scripts/export-backup.mjs.
 *
 *   node scripts/restore-backup.mjs backups/db-2026-11-11.json.gz --confirm
 *
 * This DELETES the current rows in the restored tables and replaces them with
 * the dump. Sessions are not restored (people simply sign in again).
 * Stop the app / avoid writes while restoring.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
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

const file = process.argv[2];
const confirmed = process.argv.includes('--confirm');
if (!file) {
  const dir = new URL('../backups/', import.meta.url);
  const files = readdirSync(dir).filter((n) => n.endsWith('.json.gz')).sort().reverse();
  console.error('Usage: node scripts/restore-backup.mjs <backups/db-YYYY-MM-DD.json.gz> --confirm');
  console.error('Available:', files.length ? files.join(', ') : '(none)');
  process.exit(1);
}
if (!confirmed) {
  console.error('Refusing to overwrite data without --confirm.');
  console.error('Re-run with: node scripts/restore-backup.mjs <file> --confirm');
  process.exit(1);
}

const dump = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
console.log(`Backup from ${dump.generatedAt}`);

// Order matters: parents before children.
const ORDER = [
  'neon_auth.user',
  'neon_auth.account',
  'public.profiles',
  'public.app_settings',
  'public.qr_tokens',
  'public.attendance',
];

const quote = (id) => `"${String(id).replace(/"/g, '""')}"`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
const client = await pool.connect();

try {
  await client.query('begin');

  // Clear children first, then parents.
  await client.query(
    'truncate table public.attendance, public.qr_tokens, public.app_settings, public.profiles, neon_auth.session, neon_auth.account, neon_auth."user" cascade'
  );

  for (const key of ORDER) {
    const rows = dump.tables?.[key] ?? [];
    const [schema, table] = key.split('.');
    for (const row of rows) {
      const cols = Object.keys(row);
      const values = cols.map((c) => row[c]);
      const sql = `insert into ${quote(schema)}.${quote(table)} (${cols.map(quote).join(', ')})
                   values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`;
      await client.query(sql, values);
    }
    console.log(`  restored ${key}: ${rows.length} rows`);
  }

  await client.query('commit');
  console.log('Restore complete. Everyone must sign in again (sessions were dropped).');
} catch (err) {
  await client.query('rollback');
  console.error('RESTORE FAILED (rolled back):', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
