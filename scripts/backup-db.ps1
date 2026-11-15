# Daily backup for the Bosaso attendance database.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-db.ps1
#
# Two layers:
#   1. LOGICAL DUMP (primary): scripts/export-backup.mjs writes
#      backups/db-YYYY-MM-DD.json.gz and keeps 14 days. Works on every Neon plan
#      and is independent of the snapshot quota.
#   2. NEON SNAPSHOT (secondary, best effort): one snapshot per day. The Free
#      plan allows only ONE manual snapshot, so if creation hits the quota the
#      oldest auto-* snapshot is deleted and the create is retried once.
#
# Registered as the Windows scheduled task "Bosaso DB Backup" (daily 02:00).
# Log: backups\backup.log

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$neon = Join-Path $env:APPDATA 'npm\neon.cmd'
if (-not (Test-Path $neon)) { $neon = 'neon' }
$node = 'node'

$logDir = Join-Path $root 'backups'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'backup.log'

function Write-Log($message) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Write-Output $line
  Add-Content -Path $log -Value $line
}

try {
  # ---------- 1) logical dump (always runs) ----------
  Write-Log 'Exporting logical backup ...'
  $export = & $node 'scripts/export-backup.mjs' 2>&1
  Write-Log ($export -join "`n")
  if ($LASTEXITCODE -ne 0) { throw "Logical export failed (exit $LASTEXITCODE)." }

  # ---------- 2) snapshot (best effort) ----------
  $today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
  $snapshotName = "auto-$today"

  $listOutput = & $neon snapshots list 2>&1
  $rows = @($listOutput | Where-Object { $_ -match '^snap-' })
  $takenToday = $rows | Where-Object { $_ -match $today }

  if ($takenToday) {
    Write-Log "Snapshot $snapshotName already exists, skipping."
  } else {
    Write-Log "Creating snapshot $snapshotName ..."
    $created = & $neon snapshots create --branch production --name $snapshotName 2>&1
    $createOk = $LASTEXITCODE -eq 0

    if (-not $createOk -and (($created -join ' ') -match 'limit exceeded')) {
      # Free plan: only one manual snapshot. Rotate the oldest auto-* and retry.
      $auto = @($rows | Where-Object { $_ -match 'auto-' } | Sort-Object)
      if ($auto.Count -gt 0) {
        $oldest = $auto[0] -split '\s{2,}'
        Write-Log "Snapshot quota reached; deleting oldest ($($oldest[1])) and retrying ..."
        & $neon snapshots delete $oldest[0] 2>&1 | Out-Null
        $created = & $neon snapshots create --branch production --name $snapshotName 2>&1
        $createOk = $LASTEXITCODE -eq 0
      }
    }

    if ($createOk) {
      Write-Log ($created -join ' ')
    } else {
      # The logical dump above is still a valid backup; do not fail the run.
      Write-Log "Snapshot skipped: $(($created -join ' ').Trim())"
    }
  }

  # Retention: keep 14 days of auto-* snapshots (only meaningful on paid plans;
  # on the Free plan there is at most one).
  $cutoff = (Get-Date).ToUniversalTime().AddDays(-14)
  foreach ($row in $rows) {
    $cols = $row -split '\s{2,}'
    if ($cols.Count -lt 4) { continue }
    $id = $cols[0]
    $nameCol = $cols[1]
    $createdAt = $cols[3]
    if ($nameCol -notlike 'auto-*') { continue }
    $parsed = [datetime]::MinValue
    if (-not [datetime]::TryParse($createdAt, [ref]$parsed)) { continue }
    if ($parsed.ToUniversalTime() -lt $cutoff) {
      Write-Log "Deleting old snapshot $nameCol ($id)"
      & $neon snapshots delete $id 2>&1 | Out-Null
    }
  }

  Write-Log 'Backup complete.'
} catch {
  Write-Log "BACKUP FAILED: $($_.Exception.Message)"
  exit 1
}
