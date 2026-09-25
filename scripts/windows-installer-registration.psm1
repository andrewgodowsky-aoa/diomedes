# Snapshot, compare and restore the per-user registration that the experimental installer
# (scripts/build-windows-installer.mjs) writes at fixed locations: two HKCU keys and one Start
# Menu folder. scripts/verify-windows-installer.ps1 records them before its install and hands
# them back after its uninstall, so the proof can run on a machine that already has a real
# installation. Nothing here reads or writes an installation directory.
#
# A restore replaces only what a proof produced: a key or file that is absent, that already
# matches the snapshot, that names the proof's own install target, or that holds nothing but
# snapshot data a restore stopped halfway had already written. Anything else means something
# other than the proof changed the registration, and the restore refuses before it writes anything.

# Module functions read preferences from the global scope, not from the script that calls them:
# run with & from an open session, a failed copy or listing would otherwise be reported and
# stepped past.
$ErrorActionPreference = 'Stop'
$restorableKinds = @('String', 'ExpandString', 'MultiString', 'Binary', 'DWord', 'QWord')

function ConvertTo-Base64Text([string]$Text) { [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Text)) }
function ConvertFrom-Base64Text([string]$Data) { [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Data)) }
function ConvertFrom-Ticks($Ticks) { [DateTime]::new([long]$Ticks, [DateTimeKind]::Utc) }

# String data is stored as base64 so no JSON reader can reinterpret it (PowerShell 7's
# ConvertFrom-Json turns date-shaped strings into DateTime values). Values keep the key's own
# enumeration order, so a restored key lists them exactly as the installer wrote them.
function Get-KeyRecord([string]$SubKey) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey)
  if ($null -eq $key) { return [ordered]@{ subKey = $SubKey; present = $false; values = @() } }
  try {
    if ($key.SubKeyCount -gt 0) { throw "HKCU\$SubKey has subkeys, which the installer never writes" }
    $values = foreach ($name in $key.GetValueNames()) {
      $kind = $key.GetValueKind($name).ToString()
      if ($restorableKinds -notcontains $kind) { throw "HKCU\$SubKey value '$name' has kind $kind, which cannot be restored exactly" }
      $raw = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $data = if ($kind -eq 'String' -or $kind -eq 'ExpandString') { ConvertTo-Base64Text $raw }
        elseif ($kind -eq 'MultiString') { , @($raw | ForEach-Object { ConvertTo-Base64Text $_ }) }
        elseif ($kind -eq 'Binary') { [Convert]::ToBase64String([byte[]]$raw) }
        else { [long]$raw }
      [ordered]@{ name = $name; kind = $kind; data = $data }
    }
    return [ordered]@{ subKey = $SubKey; present = $true; values = @($values) }
  } finally { $key.Close() }
}

function ConvertFrom-ValueRecord($Value) {
  if ($Value.kind -eq 'String' -or $Value.kind -eq 'ExpandString') { return (ConvertFrom-Base64Text $Value.data) }
  if ($Value.kind -eq 'MultiString') { return , [string[]]@(@($Value.data) | ForEach-Object { ConvertFrom-Base64Text $_ }) }
  if ($Value.kind -eq 'Binary') { return , [byte[]][Convert]::FromBase64String($Value.data) }
  if ($Value.kind -eq 'DWord') { return [int]$Value.data }
  return [long]$Value.data
}

# Fingerprints compare case-sensitively: base64 data differing only in case is different data.
function Get-ValueFingerprint($Value) { '{0}|{1}|{2}' -f $Value.name, $Value.kind, (@($Value.data) -join ',') }

function Get-KeyFingerprint($Record) {
  if (-not $Record.present) { return 'absent' }
  (@($Record.values | ForEach-Object { Get-ValueFingerprint $_ } | Sort-Object -CaseSensitive) -join "`n")
}

function Get-FileRecord([IO.FileInfo]$File) {
  [ordered]@{
    name = $File.Name
    bytes = $File.Length
    sha256 = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    attributes = $File.Attributes.ToString()
    creationTimeUtcTicks = $File.CreationTimeUtc.Ticks
    lastWriteTimeUtcTicks = $File.LastWriteTimeUtc.Ticks
  }
}

function Get-FileFingerprint($Record) { '{0}|{1}|{2}|{3}' -f $Record.sha256, $Record.attributes, $Record.creationTimeUtcTicks, $Record.lastWriteTimeUtcTicks }

function Get-FolderRecord([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return [ordered]@{ path = $Directory; present = $false; files = @() } }
  if (@(Get-ChildItem -LiteralPath $Directory -Directory -Force).Count -gt 0) { throw "$Directory has subfolders, which the installer never creates" }
  $folder = Get-Item -LiteralPath $Directory -Force
  $files = foreach ($file in (Get-ChildItem -LiteralPath $Directory -File -Force | Sort-Object Name)) { Get-FileRecord $file }
  [ordered]@{ path = $Directory; present = $true; creationTimeUtcTicks = $folder.CreationTimeUtc.Ticks; lastWriteTimeUtcTicks = $folder.LastWriteTimeUtc.Ticks; files = @($files) }
}

function Get-ShortcutTarget([string]$Path) {
  if (-not $Path.EndsWith('.lnk', [StringComparison]::OrdinalIgnoreCase)) { return $null }
  (New-Object -ComObject WScript.Shell).CreateShortcut($Path).TargetPath
}

# WScript expands existing 8.3 components when saving a shortcut. The install
# target can retain a short profile name (for example RUNNER~1 in Windows CI).
# Expand names through Windows before comparing, without treating a failed
# resolution as ownership. Walk only missing suffixes so uninstall recovery also
# works after the proof executable has been removed.
if (-not ('DiomedesInstallerProof.PathNames' -as [type])) {
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
namespace DiomedesInstallerProof {
  public static class PathNames {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern uint GetLongPathNameW(string path, StringBuilder output, uint capacity);
  }
}
'@
}

function Get-ExpandedProofPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) { return $null }
  $remaining = [IO.Path]::GetFullPath($Path)
  $suffix = ''
  while ($remaining) {
    $buffer = [Text.StringBuilder]::new(32768)
    $length = [DiomedesInstallerProof.PathNames]::GetLongPathNameW($remaining, $buffer, [uint32]$buffer.Capacity)
    if ($length -gt 0 -and $length -lt $buffer.Capacity) {
      return $(if ($suffix) { [IO.Path]::Combine($buffer.ToString(), $suffix) } else { $buffer.ToString() })
    }
    # Access denied and every other failure remain a refusal, not a guessed path.
    if ($length -gt 0 -or [Runtime.InteropServices.Marshal]::GetLastWin32Error() -notin @(2, 3)) { return $null }
    $name = [IO.Path]::GetFileName($remaining)
    $parent = [IO.Path]::GetDirectoryName($remaining)
    if (-not $name -or -not $parent) { return $null }
    $suffix = if ($suffix) { [IO.Path]::Combine($name, $suffix) } else { $name }
    $remaining = $parent
  }
  $null
}

function Test-ProofShortcutTarget([string]$Actual, [string]$Expected) {
  if ([string]::IsNullOrWhiteSpace($Actual)) { return $false }
  if ([string]::Equals($Actual, $Expected, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  $actualPath = Get-ExpandedProofPath $Actual
  $expectedPath = Get-ExpandedProofPath $Expected
  $actualPath -and $expectedPath -and [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)
}

function Test-KeyOwnedByProof($Record, [string]$InstallTarget) {
  foreach ($value in @($Record.values)) {
    if (($value.name -eq 'InstallDir' -or $value.name -eq 'InstallLocation') -and $value.kind -eq 'String' -and (ConvertFrom-Base64Text $value.data) -eq $InstallTarget) { return $true }
  }
  $false
}

# A key that a stopped restore was writing holds nothing but values the snapshot holds.
function Test-KeyWithinSnapshot($Record, $Expected) {
  if (-not $Expected.present) { return $false }
  $wanted = @($Expected.values | ForEach-Object { Get-ValueFingerprint $_ })
  @($Record.values | Where-Object { $wanted -cnotcontains (Get-ValueFingerprint $_) }).Count -eq 0
}

<#
.SYNOPSIS
  Read the registration as it is now. Throws, before anything is changed, if it holds
  something a restore could not reproduce exactly.
#>
function Get-RegistrationSnapshot([string[]]$SubKeys, [string]$ShortcutDirectory, [string]$InstallTarget) {
  [ordered]@{
    schemaVersion = 1
    installTarget = $InstallTarget
    takenAt = (Get-Date).ToUniversalTime().ToString('o')
    keys = @($SubKeys | ForEach-Object { Get-KeyRecord $_ })
    startMenu = Get-FolderRecord $ShortcutDirectory
  }
}

function Test-RegistrationPresent($Snapshot) { [bool](@($Snapshot.keys | Where-Object { $_.present }).Count -or $Snapshot.startMenu.present) }

# Writes snapshot.json and a byte copy of every Start Menu file, and checks each copy's hash.
function Save-RegistrationSnapshot($Snapshot, [string]$Directory) {
  $copies = Join-Path $Directory 'start-menu'
  New-Item -ItemType Directory -Force -Path $copies | Out-Null
  foreach ($file in @($Snapshot.startMenu.files)) {
    $copy = Join-Path $copies $file.name
    Copy-Item -LiteralPath (Join-Path $Snapshot.startMenu.path $file.name) -Destination $copy
    if ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Start Menu file changed while it was being saved: $($file.name)" }
  }
  $path = Join-Path $Directory 'snapshot.json'
  $Snapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding utf8
  $path
}

function Read-RegistrationSnapshot([string]$Path) {
  $snapshot = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  if ($snapshot.schemaVersion -ne 1) { throw "Unsupported registration snapshot: $Path" }
  $snapshot
}

# Compares the live registration with the snapshot and decides, item by item, whether the
# difference is a proof's own doing (and so may be replaced) or a refusal.
function Get-RestorePlan($Snapshot) {
  $plan = [ordered]@{ differences = [Collections.Generic.List[string]]::new(); refusals = [Collections.Generic.List[string]]::new(); actions = [Collections.Generic.List[object]]::new() }
  foreach ($expected in @($Snapshot.keys)) {
    $label = "HKCU\$($expected.subKey)"
    try { $actual = Get-KeyRecord $expected.subKey } catch { $plan.differences.Add($label); $plan.refusals.Add($_.Exception.Message); continue }
    if ((Get-KeyFingerprint $actual) -ceq (Get-KeyFingerprint $expected)) { continue }
    $plan.differences.Add($label)
    if ($actual.present -and -not (Test-KeyOwnedByProof $actual $Snapshot.installTarget) -and -not (Test-KeyWithinSnapshot $actual $expected)) { $plan.refusals.Add("$label was changed by something other than this proof"); continue }
    $plan.actions.Add([ordered]@{ kind = 'key'; record = $expected })
  }

  $folder = $Snapshot.startMenu
  $ownedExe = Join-Path $Snapshot.installTarget 'app\nectovia.exe'
  $exists = Test-Path -LiteralPath $folder.path -PathType Container
  $current = @{}
  if ($exists) {
    foreach ($dir in @(Get-ChildItem -LiteralPath $folder.path -Directory -Force)) { $plan.differences.Add($dir.FullName); $plan.refusals.Add("$($dir.FullName) was created by something other than this proof") }
    foreach ($file in @(Get-ChildItem -LiteralPath $folder.path -File -Force)) { $current[$file.Name] = $file }
  }
  $wanted = @{}
  foreach ($file in @($folder.files)) { $wanted[$file.name] = $file }
  if ($folder.present -and -not $exists) { $plan.differences.Add($folder.path); $plan.actions.Add([ordered]@{ kind = 'folder-create' }) }
  foreach ($name in (@($current.Keys) + @($wanted.Keys) | Sort-Object -Unique)) {
    $live = if ($current[$name]) { Get-FileRecord $current[$name] } else { $null }
    $want = $wanted[$name]
    $path = Join-Path $folder.path $name
    if ($live -and $want -and (Get-FileFingerprint $live) -ceq (Get-FileFingerprint $want)) { continue }
    $plan.differences.Add($path)
    # Replaceable: the proof's own shortcut, or the snapshot's bytes that a stopped restore wrote.
    if ($live -and -not (Test-ProofShortcutTarget (Get-ShortcutTarget $current[$name].FullName) $ownedExe) -and -not ($want -and $live.sha256 -eq $want.sha256)) { $plan.refusals.Add("$path was changed by something other than this proof"); continue }
    $plan.actions.Add([ordered]@{ kind = $(if ($want) { 'file-restore' } else { 'file-remove' }); name = $name; record = $want })
  }
  if (-not $folder.present -and $exists) {
    $plan.differences.Add($folder.path)
    $plan.actions.Add([ordered]@{ kind = 'folder-remove' })
  }
  if ($folder.present) {
    $item = if ($exists) { Get-Item -LiteralPath $folder.path -Force } else { $null }
    $timesDiffer = [bool]$item -and ($item.CreationTimeUtc.Ticks -ne [long]$folder.creationTimeUtcTicks -or $item.LastWriteTimeUtc.Ticks -ne [long]$folder.lastWriteTimeUtcTicks)
    if ($timesDiffer) { $plan.differences.Add("$($folder.path) timestamps") }
    # Any change inside the folder moves its last-write time, so its times are set last.
    if ($timesDiffer -or @($plan.actions | Where-Object { $_.kind -ne 'key' }).Count) { $plan.actions.Add([ordered]@{ kind = 'folder-times' }) }
  }
  $plan
}

function Compare-RegistrationSnapshot($Snapshot) { @((Get-RestorePlan $Snapshot).differences) }

<#
.SYNOPSIS
  Put the registration back exactly as the snapshot recorded it, then read it back.
  Returns 'unchanged' or 'restored'; throws without writing if any difference is not a
  proof's own, and throws if the read-back still differs. Safe to run again after it stops.
#>
function Restore-RegistrationSnapshot($Snapshot, [string]$SnapshotDirectory) {
  $plan = Get-RestorePlan $Snapshot
  if ($plan.refusals.Count) { throw ('Refusing to restore the registration: ' + ($plan.refusals -join '; ')) }
  if ($plan.actions.Count -eq 0) { return 'unchanged' }
  $folder = $Snapshot.startMenu
  foreach ($kind in 'key', 'folder-create', 'file-restore', 'file-remove', 'folder-remove', 'folder-times') {
    foreach ($action in @($plan.actions | Where-Object { $_.kind -eq $kind })) {
      if ($kind -eq 'key') {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($action.record.subKey, $false)
        if ($action.record.present) {
          $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($action.record.subKey)
          try { foreach ($value in @($action.record.values)) { $key.SetValue($value.name, (ConvertFrom-ValueRecord $value), [Microsoft.Win32.RegistryValueKind]$value.kind) } } finally { $key.Close() }
        }
      } elseif ($kind -eq 'folder-create') {
        New-Item -ItemType Directory -Force -Path $folder.path | Out-Null
      } elseif ($kind -eq 'file-restore') {
        $target = Join-Path $folder.path $action.name
        if (Test-Path -LiteralPath $target) { [IO.File]::SetAttributes($target, [IO.FileAttributes]::Normal) }
        [IO.File]::Copy((Join-Path (Join-Path $SnapshotDirectory 'start-menu') $action.name), $target, $true)
        [IO.File]::SetCreationTimeUtc($target, (ConvertFrom-Ticks $action.record.creationTimeUtcTicks))
        [IO.File]::SetLastWriteTimeUtc($target, (ConvertFrom-Ticks $action.record.lastWriteTimeUtcTicks))
        [IO.File]::SetAttributes($target, [IO.FileAttributes]$action.record.attributes)
      } elseif ($kind -eq 'file-remove') {
        Remove-Item -LiteralPath (Join-Path $folder.path $action.name) -Force
      } elseif ($kind -eq 'folder-remove') {
        if (@(Get-ChildItem -LiteralPath $folder.path -Force).Count -eq 0) { Remove-Item -LiteralPath $folder.path }
      } else {
        [IO.Directory]::SetCreationTimeUtc($folder.path, (ConvertFrom-Ticks $folder.creationTimeUtcTicks))
        [IO.Directory]::SetLastWriteTimeUtc($folder.path, (ConvertFrom-Ticks $folder.lastWriteTimeUtcTicks))
      }
    }
  }
  $remaining = Compare-RegistrationSnapshot $Snapshot
  if ($remaining.Count) { throw ('The restored registration still differs from the snapshot: ' + ($remaining -join '; ')) }
  'restored'
}

# Read-only witnesses: files of an installation directory, and every taskbar pin.
function Get-DirectoryListing([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Container)) { return @() }
  $root = (Get-Item -LiteralPath $Path).FullName.TrimEnd('\')
  @(Get-ChildItem -LiteralPath $root -Recurse -Force -File | Sort-Object FullName | ForEach-Object { '{0}|{1}|{2}' -f $_.FullName.Substring($root.Length + 1), $_.Length, $_.LastWriteTimeUtc.Ticks })
}

function Get-TaskbarPinListing([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return @() }
  @(Get-ChildItem -LiteralPath $Directory -Recurse -Force -File | Sort-Object FullName | ForEach-Object { '{0}|{1}|{2}' -f $_.FullName, (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), (Get-ShortcutTarget $_.FullName) })
}

# Per user and shared by every checkout: the snapshot of a proof in progress and the record that
# points at it. Both are written before the proof's first install and removed only once its
# restore reads back equal, so neither deleting a proof's folder nor killing the proof loses the
# registration it found, and the next proof refuses to run past an unfinished one.
function Get-ProofStateDirectory { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Diomedes Installer Proof' }
function Get-PendingRestorePath { Join-Path (Get-ProofStateDirectory) 'pending-restore.json' }

function Get-PendingRestore([string]$Path = (Get-PendingRestorePath)) {
  if (Test-Path -LiteralPath $Path) { Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json }
}

function Set-PendingRestore([string]$SnapshotPath, [string]$Path = (Get-PendingRestorePath)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $bytes = [Text.Encoding]::UTF8.GetBytes(([ordered]@{ snapshot = $SnapshotPath; pid = $PID; recordedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json))
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}

function Clear-PendingRestore([string]$SnapshotPath, [string]$Path = (Get-PendingRestorePath)) {
  $pending = Get-PendingRestore $Path
  if ($pending -and $pending.snapshot -eq $SnapshotPath) { Remove-Item -LiteralPath $Path -Force }
}

Export-ModuleMember -Function Get-RegistrationSnapshot, Test-RegistrationPresent, Save-RegistrationSnapshot, Read-RegistrationSnapshot, Compare-RegistrationSnapshot, Restore-RegistrationSnapshot, Get-DirectoryListing, Get-TaskbarPinListing, Get-ShortcutTarget, Get-ProofStateDirectory, Get-PendingRestorePath, Get-PendingRestore, Set-PendingRestore, Clear-PendingRestore
