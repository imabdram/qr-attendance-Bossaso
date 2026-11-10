# Bosaso Attendance Portal

QR-based employee **Time In** for the Bosaso branch. A rotating office QR code is
shown on the admin dashboard; employees scan it from their phones to record
attendance. Admins manage accounts, monitor today's arrivals, and export
date-filtered Excel reports.

## Stack

- React 19 + TypeScript + Vite (PWA)
- **Neon Lakebase Postgres** (project `qr-attendance-system-Bossaso` / `winter-surf-70097462`, branch `production`)
- **Neon Auth** (Managed Better Auth) for sign-in, sessions, and JWT issuance
- **Neon Data API** (PostgREST-compatible) for tables and stored functions, guarded by RLS
- Supabase JS used **only** as the PostgREST transport for the Data API
- `html5-qrcode` scanner, `qrcode.react` display, `xlsx` export

## Architecture

```
Browser (React SPA)
   │  sign-in / session cookie
   ├──────────────► Neon Auth  /neondb/auth
   │                   └─ issues short-lived JWT (GET /token)
   │  Bearer <JWT>
   └──────────────► Neon Data API  /neondb/rest/v1
                       ├─ tables (profiles, attendance, qr_tokens, app_settings)
                       └─ RPCs (create_qr_token, scan_attendance, admin_*)
```

Row Level Security still applies: `auth.uid()` comes from the JWT, and every
admin RPC re-checks `public.is_admin()`.

## Environment

Copy `.env.example` to `.env.local`:

```env
VITE_NEON_AUTH_URL=https://<endpoint>.neonauth.c-2.eu-west-2.aws.neon.tech/neondb/auth
VITE_NEON_DATA_API_URL=https://<endpoint>.apirest.c-2.eu-west-2.aws.neon.tech/neondb/rest/v1
```

Server-side only (migrations/scripts, never bundled):

```env
DATABASE_URL=postgresql://…            # pooled
DATABASE_URL_UNPOOLED=postgresql://…   # direct, used by scripts
```

Both `VITE_` values have production defaults baked into `src/lib/neon.ts`, so a
Vercel build works even if the variables are not set — but setting them per
environment is recommended.

## Local development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build
npm run preview
```

## Database

Schema objects live in `db/migrations/` (the historical `supabase/migrations`
files document the original schema and are no longer applied).

```bash
node scripts/apply-sql.mjs db/migrations/001_neon_auth_scrypt_rpcs.sql
neon data-api refresh-schema      # after adding/removing functions
```

### Stored functions

| Function | Purpose |
| --- | --- |
| `create_qr_token(p_duration_seconds)` | Issues a QR token (30 s – 24 h), stores only its SHA-256 hash |
| `revoke_qr_tokens()` | Admin-only: invalidates every active QR code at once |
| `attendance_report(p_from, p_to)` | Admin-only grid of every employee × working day, with `status = 'absent'` where nothing was recorded |
| `scan_attendance(p_token)` | Validates the token and writes a Time In row (Mogadishu date, shift-aware late detection) |
| `admin_create_user(...)` | Creates `neon_auth.user` + credential account + `public.profiles` row |
| `admin_update_employee(...)` | Updates name / phone / department / shift |
| `admin_reset_password(...)` | Replaces the credential hash and drops existing sessions |
| `admin_delete_employee(...)` | Deletes attendance, profile, account, sessions, and the auth user |
| `is_admin()` | RLS helper backed by the JWT |

### Passwords

Neon Auth (Better Auth) verifies **scrypt** hashes (`<32 hex salt>:<128 hex key>`,
N=16384, r=16, p=1, dkLen=64). The browser hashes the password
(`hashPassword()` in `src/lib/neon.ts`) and the RPC stores the hash, so no
plaintext password ever reaches the database. Older bcrypt hashes cannot be
verified by Better Auth — use *Reset password* in the Employees screen to migrate
an account.

## Backups

Full runbook: [`BACKUP.md`](BACKUP.md). Short version: one snapshot per day via the
Windows task **Bosaso DB Backup** (02:00, 14-day retention, log in
`backups/backup.log`), plus `neon snapshots create` for manual backups.

The database lives on Neon; backups are Neon snapshots (copy-on-write, so they cost
only the storage of changed pages).

### Automatic (this machine)

`scripts/backup-db.ps1` takes one snapshot per day and keeps 14 days of them:

- Windows scheduled task: **Bosaso DB Backup**, daily at **02:00** local time.
- Snapshots are named `auto-YYYY-MM-DD`; older `auto-*` ones are pruned.
- Log: `backups/backup.log` (git-ignored).
- Missed runs (PC off) execute at the next opportunity; battery restrictions are off.

Manage it:

```powershell
schtasks /Query /TN "Bosaso DB Backup"
schtasks /Run   /TN "Bosaso DB Backup"     # run now
schtasks /Delete /TN "Bosaso DB Backup" /F # remove
powershell -NoProfile -File scripts\backup-db.ps1   # manual run
```

Neon's own automatic backup schedule is **not enabled** for this project (plan
limitation); the local task fills that gap. The project still has its short
point-in-time restore window for "oops, deleted a row" recovery.

### Manual snapshot before risky changes

```bash
neon snapshots create --branch production --name "before-changes-$(date +%F)"
neon snapshots list
```

### Restore

Always restore into a new branch first, verify, then switch over:

```bash
neon snapshots restore <snapshot-id> --name restore-check
neon snapshots finalize restore-check   # when the restored branch looks right
```

### Off-site copy (optional)

For a backup that does not depend on this PC, run the same command from CI:

```bash
neon snapshots create --branch production --name "auto-$(date -u +%F)"
```

Create an API key with `neon api-keys create --name github-backup`, store it as the
`NEON_API_KEY` repository secret, and run the command from a GitHub Actions cron
job. Snapshots include the `neon_auth` schema, so administrator and employee
logins are covered as well as attendance.

## Accounts

- Admins sign in with their real email (or `admin` for the bootstrap account).
- Employees sign in with a **username**; the app appends
  `@attendance-login.example.com` before calling Neon Auth.
- **The web app can only create employees.** Employees → *Add Employee* has no
  admin option, `createEmployeeAccount` hard-codes `p_role: 'employee'`, and the
  database rejects `admin_create_user(p_role => 'admin')` plus any profile role
  change coming from PostgREST.
- Administrators are created **server-side only**: `scripts/add-admin.mjs`, the
  Neon SQL Editor, or the Neon platform. The Employees list therefore shows
  employees only.
- Use *Reset password* (key icon) to set a new password for an employee; admins
  are reset with `scripts/reset-password.mjs`.

### Adding an admin (server-side only)

```bash
node scripts/add-admin.mjs dhomdesign@gmail.com 'SomeStrongPassword!' "Dhom Design"
```

Re-running the same command with the same email **changes that admin's password**.
It writes straight to the database with `DATABASE_URL_UNPOOLED`, so no admin
session or `ADMIN_EMAIL` / `ADMIN_PASSWORD` is needed:

```env
DATABASE_URL_UNPOOLED=postgresql://…
```

### Forgotten password (break-glass)

The Reset password screen needs an existing admin session, and the shared SMTP
cannot deliver to `@attendance-login.example.com`, so a locked-out admin is
recovered from the database instead:

```bash
node scripts/reset-password.mjs admin@attendance-login.example.com 'NewStrongPassword!'
node scripts/reset-password.mjs yacquub 'AnotherStrongPassword!'   # username also works
```

It writes the scrypt hash Better Auth expects straight into
`neon_auth.account` and deletes that user's sessions — no login required, only
`DATABASE_URL_UNPOOLED` from `.env.local` (or any machine holding the connection
string). Use it for employees too.

In the Neon SQL Editor the same thing needs a hash generated outside Postgres
(`crypt()` is bcrypt, which Better Auth rejects):

```bash
node -e "const {scryptSync,randomBytes}=require('node:crypto');const p=process.argv[1];const s=randomBytes(16).toString('hex');console.log(s+':'+scryptSync(p.normalize('NFKC'),s,64,{N:16384,r:16,p:1,maxmem:128*16384*16*2}).toString('hex'))" 'NewStrongPassword!'
```

```sql
update neon_auth.account set password = '<paste-hash>', "updatedAt" = now()
 where "providerId" = 'credential'
   and "userId" = (select id from neon_auth.user where email = 'admin@attendance-login.example.com');
delete from neon_auth.session
 where "userId" = (select id from neon_auth.user where email = 'admin@attendance-login.example.com');
```

### QR code lifetime

Every QR code expires within **24 hours** (rotating codes expire within a minute).
There is no permanent option: a photographed permanent poster would allow check-in
from anywhere. For a printed poster use the **24-Hour QR** mode and reprint daily,
or press **Revoke QR Codes** if a code leaks.

## Deployment (Vercel)

1. Push this repository to GitHub.
2. Import the repo in Vercel (framework preset **Vite**, build `npm run build`,
   output `dist`).
3. Add `VITE_NEON_AUTH_URL` and `VITE_NEON_DATA_API_URL` for Production and Preview.
4. Register the deployment domain as a Neon Auth trusted origin:

   ```bash
   neon neon-auth domain add https://<project>.vercel.app
   neon neon-auth domain list
   ```

5. `vercel.json` rewrites every path to `index.html` so client-side routes work.

Without a registered origin, Neon Auth rejects browser sign-in requests from the
deployed domain.

## Verification

```bash
# ADMIN_EMAIL / ADMIN_PASSWORD must be set (shell or .env.local)
node scripts/e2e-neon.mjs              # auth + RPC + RLS + QR cap/revoke checks
node scripts/ui-login.mjs admin 'the-password' out.png
```

`scripts/` also contains local helpers (`audit-neon.mjs`, `apply-sql.mjs`,
`cdp-check.mjs`, UI drivers). They are development tools, not part of the bundle.
