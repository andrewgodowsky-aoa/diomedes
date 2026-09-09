param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ProofRoot,
  [Parameter(Mandatory=$true)][string]$Payload
)
$ErrorActionPreference = 'Stop'
$proofPath = [IO.Path]::GetFullPath($ProofRoot)
$payloadPath = (Resolve-Path -LiteralPath $Payload).Path
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$allowedRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../test-results')).Path
if (-not $proofPath.StartsWith($allowedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Proof must be inside this checkout test-results' }
if (Test-Path -LiteralPath $proofPath) { throw 'Proof root must be new' }
$product = 'Diomedes.Experimental.8c27d61a-1919-4b12-9df7-20260909e001'
$keys = @(('HKCU:\Software\Diomedes\Experimental\' + $product), ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $product))
$shortcutDirectory = Join-Path ([Environment]::GetFolderPath('Programs')) 'Diomedes Experimental 20260909'
foreach ($key in $keys) { if (Test-Path -LiteralPath $key) { throw ('Experimental registration already exists: ' + $key) } }
if (Test-Path -LiteralPath $shortcutDirectory) { throw 'Experimental shortcut already exists' }
New-Item -ItemType Directory -Path $proofPath | Out-Null
$installTarget = Join-Path $proofPath 'installation'
$proof = [ordered]@{ startedAt=(Get-Date).ToUniversalTime().ToString('o'); installer=$installerPath; installerSha256=(Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant(); installTarget=$installTarget; registryKeys=$keys; checks=@(); passed=$false }
try {
  $process = Start-Process -FilePath $installerPath -ArgumentList @('/S', ('/D=' + $installTarget)) -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw ('Install failed: ' + $process.ExitCode) }
  $marker = Join-Path $installTarget '.diomedes-experimental-20260909'
  if ((Get-Content -LiteralPath $marker -Raw) -ne $product) { throw 'Unexpected install ownership marker' }
  $payloadFiles = @(Get-ChildItem -LiteralPath $payloadPath -File -Recurse)
  foreach ($file in $payloadFiles) {
    $relative = $file.FullName.Substring($payloadPath.Length + 1)
    $installed = Join-Path (Join-Path $installTarget 'app') $relative
    if ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw ('Installed payload differs: ' + $relative) }
  }
  foreach ($key in $keys) { if (-not (Test-Path -LiteralPath $key)) { throw ('Registration missing: ' + $key) } }
  $shortcut = Join-Path $shortcutDirectory 'Diomedes Experimental.lnk'
  if (-not (Test-Path -LiteralPath $shortcut)) { throw 'Shortcut missing' }
  $proof.payloadFileCount = $payloadFiles.Count
  $proof.checks += 'Installed all payload files with identical SHA-256, current-user keys and shortcut'
  $runtimeProof = Join-Path $proofPath 'runtime-proof'
  & node (Join-Path $PSScriptRoot 'connections-desktop-smoke.mjs') (Join-Path $installTarget 'app/Diomedes.exe') $runtimeProof
  if ($LASTEXITCODE -ne 0) { throw ('Installed app smoke failed: ' + $LASTEXITCODE) }
  $proof.runtime = Join-Path $runtimeProof 'proof.json'
  $proof.checks += 'Installed executable passed full Connections desktop/crash/restart smoke with isolated profile'
  $sentinel = Join-Path $installTarget 'app/user-retained.txt'
  [IO.File]::WriteAllText($sentinel, 'Unowned data must survive uninstall.')
  $profileMarker = Join-Path $runtimeProof 'profile/retained-profile-proof.txt'
  [IO.File]::WriteAllText($profileMarker, 'Isolated profile must survive uninstall.')
  $process = Start-Process -FilePath $installerPath -ArgumentList @('/S', ('/D=' + $installTarget)) -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw ('Repair install failed: ' + $process.ExitCode) }
  foreach ($file in $payloadFiles) {
    $relative = $file.FullName.Substring($payloadPath.Length + 1)
    $installed = Join-Path (Join-Path $installTarget 'app') $relative
    if ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw ('Repaired payload differs: ' + $relative) }
  }
  if ((Get-Content -LiteralPath $sentinel -Raw) -ne 'Unowned data must survive uninstall.') { throw 'Repair changed unowned data' }
  if ((Get-Content -LiteralPath $profileMarker -Raw) -ne 'Isolated profile must survive uninstall.') { throw 'Repair changed profile' }
  $proof.checks += 'Same-version repair install retained unknown data and isolated profile; all program hashes still match'
  $uninstaller = Join-Path $installTarget 'Uninstall Diomedes Experimental.exe'
  $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw ('Uninstall failed: ' + $process.ExitCode) }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-Path -LiteralPath $marker) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  foreach ($key in $keys) { if (Test-Path -LiteralPath $key) { throw ('Registration left behind: ' + $key) } }
  if (Test-Path -LiteralPath $shortcut) { throw 'Shortcut left behind' }
  if (Test-Path -LiteralPath $marker) { throw 'Owned marker left behind' }
  foreach ($file in $payloadFiles) {
    $relative = $file.FullName.Substring($payloadPath.Length + 1)
    if (Test-Path -LiteralPath (Join-Path (Join-Path $installTarget 'app') $relative)) { throw ('Owned payload left behind: ' + $relative) }
  }
  if ((Get-Content -LiteralPath $sentinel -Raw) -ne 'Unowned data must survive uninstall.') { throw 'Unowned file was changed' }
  if ((Get-Content -LiteralPath $profileMarker -Raw) -ne 'Isolated profile must survive uninstall.') { throw 'Profile was changed' }
  $proof.checks += 'Uninstall removed only owned payload/registration/shortcut; unknown file and isolated profile retained'
  $proof.passed = $true
} catch {
  $proof.error = $_.Exception.Message
  throw
} finally {
  $proof.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $proofPath 'proof.json')
}
