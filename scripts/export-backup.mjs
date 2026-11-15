/**
 * Daily logical backup: exports the app + auth tables to a gzipped JSON file.
 *
 *   node scripts/export-backup.mjs
 *
 * Why JSON and not snapshots: the Neon Free plan allows only ONE manual
 * snapshot, so snapshot history cannot be kept. These dumps are independent of
 * that quota, portable, and small (attendance data is a few hundred KB/year).
 *
 * Output: backups/db-YYYY-MM-DD.json.gz (git-ignored), 14-day retention.
 */
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const RETENTION_DAYS = 14;
const OUT_DIR = fileURLToPath(new URL('../backups/', import.meta.url));

// Order matters for restore (foreign keys).
const TABLES = [
  ['neon_auth', 'user'],
  ['neon_auth', 'account'],
  ['neon_auth', 'session'],
  ['public', 'profiles'],
  ['public', 'app_settings'],
  ['public', 'qr_tokens'],
  ['public', 'attendance'],
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
const dump = { generatedAt: new Date().toISOString(), tables: {} };

try {
  for (const [schema, table] of TABLES) {
    const { rows } = await pool.query(`select * from "${schema}"."${table}"`);
    dump.tables[`${schema}.${table}`] = rows;
    console.log(`  ${schema}.${table}: ${rows.length} rows`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const file = join(OUT_DIR, `db-${today}.json.gz`);
  const raw = JSON.stringify(dump);
  writeFileSync(file, gzipSync(Buffer.from(raw, 'utf8'), { level: 9 }));
  const sizeKb = (statSync(file).size / 1024).toFixed(1);
  console.log(`Wrote backups/db-${today}.json.gz (${sizeKb} KB, ${raw.length} bytes raw)`);

  // Retention: delete db-*.json.gz older than RETENTION_DAYS.
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  for (const name of readdirSync(OUT_DIR)) {
    if (!/^db-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(name)) continue;
    const path = join(OUT_DIR, name);
    if (statSync(path).mtimeMs < cutoff) {
      unlinkSync(path);
      console.log(`Pruned old dump ${name}`);
    }
  }
  console.log('Backup complete.');
} catch (err) {
  console.error('BACKUP FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
