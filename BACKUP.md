# Backups

How the Bosaso attendance database is backed up, restored, and verified.

- **Database:** Neon project `qr-attendance-system-Bossaso` (`winter-surf-70097462`)
- **Branch:** `production`
- **Method:** Neon snapshots (copy-on-write, instant, storage billed only for changed pages)
- **Daily job:** Windows scheduled task **“Bosaso DB Backup”**, every day at **02:00**
- **Retention:** 14 days of `auto-*` snapshots
- **Log:** `backups/backup.log` (git-ignored)

## What is in a snapshot

A snapshot covers the **whole branch**, so it includes:

| Schema | Contents |
| --- | --- |
| `public` | `profiles`, `attendance`, `qr_tokens`, `app_settings` + functions and triggers |
| `neon_auth` | users, credential password hashes, sessions, JWKS |

That means restoring a snapshot restores logins as well as attendance records.

## Automatic daily backup

The task runs [`scripts/backup-db.ps1`](../scripts/backup-db.ps1), which:

1. lists existing snapshots;
2. skips if a snapshot for today (UTC) already exists — so it is safe to run repeatedly;
3. creates `auto-YYYY-MM-DD` on the `production` branch;
4. deletes `auto-*` snapshots older than 14 days;
5. appends every step to `backups/backup.log`.

### Check it is scheduled

```powershell
schtasks /Query /TN "Bosaso DB Backup"
schtasks /Query /TN "Bosaso DB Backup" /FO LIST /V   # detailed
```

### Run it now (does not wait for 02:00)

```powershell
schtasks /Run /TN "Bosaso DB Backup"
# or directly:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-db.ps1
```

### Change the time

```powershell
schtasks /Change /TN "Bosaso DB Backup" /ST 01:30
```

### Remove it

```powershell
schtasks /Delete /TN "Bosaso DB Backup" /F
```

> The task is created with *StartWhenAvailable* enabled and battery restrictions
> off, so a run missed because the PC was off executes at the next opportunity.

## Manual backup

Take one before risky changes (schema migrations, bulk imports):

```bash
neon snapshots create --branch production --name "before-changes-2026-11-10"
neon snapshots list
```

Restore or delete a specific snapshot:

```bash
neon snapshots restore <snapshot-id> --name restore-check
neon snapshots delete <snapshot-id>
```

## Restore procedure

Never restore straight onto `production`. Restore into a branch, verify, then
promote:

```bash
# 1. restore into a new branch
neon snapshots restore snap-xxxxxxxx --name restore-check

# 2. point the app at it (or inspect with SQL) and confirm the data looks right
neon connection-string restore-check

# 3. when satisfied, make it the production data
neon snapshots finalize restore-check
```

For “oops, one row was deleted” cases, prefer **Time Travel** / creating a branch
from a point in time instead of restoring the whole branch.

## Off-site copy (optional)

Snapshots live inside the Neon account. For a copy that survives losing the
account:

### From CI with an API key

```bash
neon api-keys create --name github-backup      # store as NEON_API_KEY repo secret
# in GitHub Actions (daily cron):
neon snapshots create --branch production --name "auto-$(date -u +%F)"
```

### Logical dump

`pg_dump` against the direct (unpooled) connection string:

```bash
pg_dump "$DATABASE_URL_UNPOOLED" --format=custom --file=backup.dump
pg_restore --clean --if-exists --dbname="$DATABASE_URL_UNPOOLED" backup.dump
```

Postgres client tools are not installed on this machine; a Node export of the
tables to CSV/JSON can be added if a portable copy is needed.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Task does nothing | `neon` CLI not on PATH for the task's user | install with `npm i -g neon`, or edit the task command |
| `BACKUP FAILED: ...` in the log | not authenticated / `.neon` link missing | run `neon auth`, then `neon link` in the repo |
| `snapshot creation is not enabled` | plan restriction on scheduled backups | keep the local task (it uses `snapshots create`, which is allowed) |
| “A snapshot from … already exists, skipping” | daily job already ran | expected; nothing to do |
| Restore looks empty | wrong branch/database restored | check `neon branches list`, restore the `production` snapshot |

## Verification checklist

- [ ] `neon snapshots list` shows today's `auto-*` or `backup-*`
- [ ] `schtasks /Query /TN "Bosaso DB Backup"` reports **Ready** with tomorrow's run time
- [ ] `backups/backup.log` has a recent `Backup complete.` line
- [ ] A test restore into `restore-check` shows the expected tables and admin user
- [ ] `neon snapshots finalize restore-check` only after verification
