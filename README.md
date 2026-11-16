# Bosaso Attendance Portal

QR check-in for employees. Admins show (or print) a QR code; employees scan it
with their phone to record **Time In**. One check-in per person per day, Friday
is off, and late/on-time is decided in **Africa/Mogadishu** time.

**Live:** https://qr-attendance-bossaso.vercel.app

## What we use

| Piece | What for |
| --- | --- |
| **React 19 + TypeScript + Vite** | The app (SPA, installable PWA) |
| **Neon Postgres** | Tables, functions, RLS — project `winter-surf-70097462`, branch `production` |
| **Neon Auth** (Managed Better Auth) | Sign-in, sessions, JWT (`/neondb/auth`) |
| **Neon Data API** (PostgREST) | Tables + RPCs from the browser (`/neondb/rest/v1`) |
| **supabase-js** | HTTP transport to the Data API only (every request sends the Neon JWT) |
| **Vercel** | Hosting (static build) |
| `html5-qrcode` / `qrcode.react` | Camera scanner / QR rendering |
| `xlsx` | Excel reports |

There is no app server: RLS + `SECURITY DEFINER` functions enforce access.

## How it works

- **Admin** → QR Display → *Changed by hand* (30-day code, printable) or
  *Auto every X* (1 min … 1 day, or custom sec/min/hours/days). Changing the code
  asks for confirmation.
- **Employee** → sign in → scan → a row is written with the Mogadishu date/time.
  Duplicate scans are rejected by a unique `(employee_id, work_date)`.
- **Dashboard / Reports** — today's arrivals, late count, missing people, and an
  Excel export with Present / Late / **Absent** (absences are computed per
  employee per working day).
- Shift late thresholds live in `app_settings` (`late_after_morning`,
  `late_after_afternoon`) and can be edited on the dashboard.

## Project layout

```
src/pages/       Login, Admin (dashboard/employees/QR/reports), Employee scanner
src/lib/         neon.ts (auth + JWT + Data API client), api.ts (RPC wrappers), date.ts
db/migrations/   000 base schema … 008 (tokens, reports, admin lock, 10y cap)
scripts/         migrations, admin/password, e2e tests, backups
BACKUP.md        backup + restore runbook
```

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc -b && vite build  → dist/
npm run preview
```

`.env.local` (never commit):

```env
VITE_NEON_AUTH_URL=https://<host>/neondb/auth
VITE_NEON_DATA_API_URL=https://<host>/neondb/rest/v1
DATABASE_URL=postgresql://…            # pooled
DATABASE_URL_UNPOOLED=postgresql://…   # direct (scripts/migrations)
ADMIN_EMAIL=admin@attendance-login.example.com
ADMIN_PASSWORD=…
```

If you build the database from scratch:

```bash
neon link --project-id <id> --branch production
neon deploy                                  # Auth + Data API from neon.ts
for f in db/migrations/*.sql; do node scripts/apply-sql.mjs "$f"; done
neon data-api refresh-schema                 # after new functions
node scripts/bootstrap-admin.mjs             # first admin
```

## Accounts

- **Employees** are created in the app: *Employees → Add Employee* (username +
  password). The frontend can only create employees.
- **Admins are server-side only** (by design):

  ```bash
  node scripts/add-admin.mjs you@company.com 'StrongPass123!' "Your Name"
  ```

  They sign in with the full email. Re-running resets the password.
- **Forgot a password?** `node scripts/reset-password.mjs admin 'NewPass123!'`
  (no login needed; writes the Better Auth scrypt hash directly).

## Database rules worth knowing

- `auth.uid()` comes from the Neon JWT; `is_admin()` reads `profiles.role`.
- `admin_create_user` **rejects** `role='admin'`, and a trigger blocks role
  changes coming through the Data API — admins can't be minted from the browser.
- QR tokens are stored as SHA-256 hashes only. Lifetimes: auto = interval + 25 s,
  changed-by-hand = 30 days, hard cap 10 years.
- Run `neon data-api refresh-schema` after adding/renaming functions, or you get
  `PGRST202`.

## Backups

Daily JSON dumps (14 days) + a rotated Neon snapshot. Full runbook:
[BACKUP.md](BACKUP.md).

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-db.ps1
node scripts/restore-backup.mjs backups/db-YYYY-MM-DD.json.gz --confirm
```

## Deploy (Vercel)

1. Import the repo; preset **Vite**, build `npm run build`, output `dist`.
2. Set `VITE_NEON_AUTH_URL` and `VITE_NEON_DATA_API_URL` (Production + Preview).
3. Trust the domain in **both** places:

   ```bash
   neon neon-auth domain add https://<project>.vercel.app     # sign-in
   neon data-api update --server-cors-allowed-origins "https://<project>.vercel.app"  # data
   ```

   Missing either one shows "Failed to fetch" or a 403 on login.
4. `vercel.json` handles SPA rewrites and no-cache for `index.html`/`sw.js`.

## Checks

```bash
node scripts/e2e-neon.mjs        # 18 backend checks (auth, RLS, RPCs, QR, report)
node scripts/ui-login.mjs admin 'password' out.png /admin
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| “Signed in, profile did not load / Failed to fetch” | Data API CORS: `neon data-api update --server-cors-allowed-origins …` |
| Login 403 / “Failed to fetch” on sign-in | Trusted origin: `neon neon-auth domain add https://…` (no trailing slash) |
| `PGRST202 could not find the function` | `neon data-api refresh-schema` |
| Admin action says “Unauthorized” | `is_admin()` drifted; re-apply `db/migrations/007_restore_is_admin.sql` |
| Old UI after deploy | Hard refresh (service worker) |
