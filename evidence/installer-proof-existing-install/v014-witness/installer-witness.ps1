param([Parameter(Mandatory=$true)][string]$Out)

# An independent read-only witness of everything the installer proof promises not to change.
#
# It is deliberately NOT the proof's own bookkeeping. The proof records the registration it
# finds and hands it back; this is taken outside it, before and after, so the hand-back can be
# checked against something the proof never wrote. Nothing here writes to the registry, the
# Start Menu, the taskbar or the installation.

$ErrorActionPreference = 'Stop'
$product = 'Diomedes.Experimental.8c27d61a-1919-4b12-9df7-20260909e001'

function Read-Key([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $item = Get-Item -LiteralPath $path
  $values = [ordered]@{}
  foreach ($name in ($item.GetValueNames() | Sort-Object)) {
    $kind = $item.GetValueKind($name)
    $data = $item.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
    if ($data -is [byte[]]) { $data = [Convert]::ToBase64String($data) }
    elseif ($data -is [string[]]) { $data = ($data -join "`u{241E}") }
    $values[$(if ($name -eq '') { '(default)' } else { $name })] = @{ kind = "$kind"; data = "$data" }
  }
  return @{ subKeyCount = $item.SubKeyCount; values = $values }
}

function Hash-Of([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Diomedes Experimental 20260909'
$startMenu  = Join-Path ([Environment]::GetFolderPath('Programs')) 'Diomedes Experimental 20260909'
$pinDir     = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$taskband   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband'

$installFiles = @()
if (Test-Path -LiteralPath $installDir) {
  $installFiles = Get-ChildItem -LiteralPath $installDir -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    ForEach-Object { @{ path = $_.FullName.Substring($installDir.Length + 1); bytes = $_.Length; sha256 = Hash-Of $_.FullName } }
}

$startMenuFiles = @()
if (Test-Path -LiteralPath $startMenu) {
  $startMenuFiles = Get-ChildItem -LiteralPath $startMenu -Recurse -File -Force -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    ForEach-Object { @{ path = $_.Name; bytes = $_.Length; sha256 = Hash-Of $_.FullName; lastWrite = $_.LastWriteTimeUtc.ToString('o'); created = $_.CreationTimeUtc.ToString('o') } }
}

$pins = @()
if (Test-Path -LiteralPath $pinDir) {
  $pins = Get-ChildItem -LiteralPath $pinDir -File -Force -ErrorAction SilentlyContinue |
    Sort-Object Name |
    ForEach-Object { @{ name = $_.Name; bytes = $_.Length; sha256 = Hash-Of $_.FullName } }
}

$taskbandValues = Read-Key $taskband

$witness = [ordered]@{
  takenAt        = (Get-Date).ToUniversalTime().ToString('o')
  productKey     = Read-Key ('HKCU:\Software\Diomedes\Experimental\' + $product)
  uninstallKey   = Read-Key ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $product)
  installDir     = $installDir
  installPresent = (Test-Path -LiteralPath $installDir)
  installFileCount = $installFiles.Count
  installFiles   = $installFiles
  startMenuDir   = $startMenu
  startMenuFiles = $startMenuFiles
  taskbarPins    = $pins
  taskband       = $taskbandValues
}

$witness | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Out -Encoding utf8
"witness written: $Out"
"  install files : $($installFiles.Count)"
"  start menu    : $($startMenuFiles.Count)"
"  taskbar pins  : $($pins.Count)"
"  product key   : $(if ($witness.productKey) { 'present' } else { 'absent' })"
"  uninstall key : $(if ($witness.uninstallKey) { 'present' } else { 'absent' })"
