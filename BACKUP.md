# Backups

How the Bosaso attendance database is backed up, restored, and verified.

- **Database:** Neon project `qr-attendance-system-Bossaso`, branch `production`
- **Layer 1 (primary):** daily **logical dump** → `backups/db-YYYY-MM-DD.json.gz`, 14-day retention
- **Layer 2 (secondary):** one **Neon snapshot**, rotated daily (Free plan allows only **1 manual snapshot**)
- **Daily trigger:** Windows task **“Bosaso DB Backup”** at **02:00**
- **Catch-up trigger:** `bosaso-backup.cmd` in the Startup folder — runs the same idempotent script at logon when the PC was off at 02:00
- **Log:** `backups/backup.log`

> Why not daily snapshots? The Neon **Free** plan allows one manual snapshot
> ([quota FAQ](https://neon.com/faqs/free-plan-limits-and-quotas)); the Launch
> plan allows 100. Until then, history lives in the JSON dumps.

## What is backed up

| Source | Tables |
| --- | --- |
| `public` | `profiles`, `attendance`, `qr_tokens`, `app_settings` |
| `neon_auth` | `user`, `account` (scrypt password hashes), `session` |

Restoring a dump restores logins as well as attendance. Sessions are exported but
not restored — everyone signs in again.

The snapshots cover the **whole branch**, including functions, triggers, and RLS.

## Daily run (what happens)

`scripts/backup-db.ps1`:

1. runs `scripts/export-backup.mjs` → writes today’s `.json.gz` and prunes dumps older than 14 days;
2. lists snapshots and creates `auto-YYYY-MM-DD` unless today already has one;
3. if snapshot creation hits the Free-plan quota, deletes the oldest `auto-*` and retries once;
4. logs every step to `backups\backup.log`.

Both steps are idempotent — running it twice in a day is safe.

## Check that it is working

```powershell
Get-ChildItem backups | Select-Object Name, Length, LastWriteTime
Get-Content backups\backup.log -Tail 15
schtasks /Query /TN "Bosaso DB Backup" /FO LIST
neon snapshots list
```

Healthy output: a `db-<today>.json.gz` (a few KB), a log ending in
`Backup complete.`, task state **Ready**, and one `auto-*` snapshot from today.

## Manual backup

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-db.ps1
```

Snapshot only:

```bash
neon snapshots create --branch production --name "before-changes-2026-11-15"
neon snapshots list
```

## Restore

### From a JSON dump (recommended on the Free plan)

```bash
node scripts/restore-backup.mjs backups/db-2026-11-15.json.gz --confirm
```

This **replaces** the current rows in the restored tables (it truncates first) and
drops sessions, so everyone signs in again. Stop writes to the app while it runs.
Without `--confirm` it refuses to touch anything.

### From a snapshot (whole branch)

```bash
neon snapshots restore <snapshot-id> --name restore-check
# verify the restored branch, then:
neon snapshots finalize restore-check
```

Never restore straight onto `production` without checking the new branch first.

## Off-site copy (optional)

Dumps and snapshots live on this PC / in the Neon account. For a copy that
survives both:

- push `backups/*.json.gz` to cloud storage or a private repo (they contain
  password hashes — keep them private), or
- run the snapshot from CI with a `NEON_API_KEY` secret:
  ```bash
  neon snapshots create --branch production --name "auto-$(date -u +%F)"
  ```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Log: `snapshots limit exceeded` | Free plan = 1 manual snapshot | handled automatically (rotation); dumps still run |
| Task `Last Result: -1073741510` (0xC000013A) | task was terminated (logoff/shutdown) mid-run | the Startup catch-up runs it again at next logon |
| Missing dumps for several days | PC was off and no logon happened | run the script manually; logon catch-up covers future gaps |
| `BACKUP FAILED: ENOENT ... C:\C:\...` | old path bug | fixed; update the repo |
| `EPERM ... .config\neon\*.lock` | CLI cache write blocked by a sandbox | run from a normal terminal |
| Restore fails on `profiles` | FK order / duplicate rows | the restore script inserts parents first; check the dump has `neon_auth.user` |
| `Access is denied` editing the task | Task Scheduler needs elevation | use the Startup catch-up or run `schtasks` as admin |

## Verification checklist

- [ ] `backups\db-<today>.json.gz` exists
- [ ] `backups\backup.log` ends with `Backup complete.`
- [ ] `neon snapshots list` shows today’s `auto-*`
- [ ] `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\bosaso-backup.cmd` exists
- [ ] A test restore into `restore-check` shows the expected tables and admin user
