param([string]$Snapshot)
# Hands back the registration that an interrupted scripts/verify-windows-installer.ps1 run
# recorded before its first install. Without -Snapshot it uses the pending-restore record that
# run left behind. It replaces only what that proof produced, finishes a restore that was itself
# interrupted, and refuses without writing anything if something else has changed the
# registration since. Run it before deleting the interrupted proof's folder.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'windows-installer-registration.psm1') -Force
if (-not $Snapshot) {
  $pending = Get-PendingRestore
  if (-not $pending) { 'No installer proof has a pending restore.'; exit 0 }
  $Snapshot = $pending.snapshot
}
$Snapshot = [IO.Path]::GetFullPath($Snapshot)
$directory = Split-Path -Parent $Snapshot
$result = Restore-RegistrationSnapshot (Read-RegistrationSnapshot $Snapshot) $directory
Clear-PendingRestore $Snapshot
if ($directory.StartsWith((Get-ProofStateDirectory) + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $directory -Recurse -Force }
"Registration $result from $Snapshot"
