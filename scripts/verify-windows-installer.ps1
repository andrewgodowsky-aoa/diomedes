param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ProofRoot,
  [Parameter(Mandatory=$true)][string]$Payload,
  # What the installed copy is run with. 'connections' is the full Connections
  # desktop/crash/restart smoke. 'launch' is scripts/packaged-launch-smoke.mjs:
  # start the installed app on an isolated profile, /api/health from its window,
  # 401 from outside it, quit cleanly. The release workflow uses 'launch' while
  # the Connections event path is refused inside a packaged build (see
  # docs/implementation/2026-09-25-release-pipeline.md).
  [ValidateSet('connections', 'launch')][string]$RuntimeSmoke = 'connections'
)
# Installs, launches, repairs and uninstalls the exact installer in a new folder under this
# checkout's test-results. The installer's registration is not per folder: it writes two fixed
# HKCU keys and one fixed Start Menu folder, and its uninstaller deletes them. Both also delete
# the Start Menu folder that installs from before the rename to Nectovia made. So the proof
# records the registration it finds first (a real installation's, or none), including that
# older folder, and once its own uninstall has removed the keys and shortcuts it hands that
# registration back and reads it back (scripts/windows-installer-registration.psm1). A real
# installation's folder and the taskbar pins are never written, and the proof checks both.
#
# Until it is handed back, the record lives in the per-user 'Diomedes Installer Proof' folder,
# with a copy in the proof folder as evidence. After an interrupted proof, run
# scripts/restore-windows-installer-registration.ps1 first and delete that proof's folder only
# afterwards. Never run the interrupted proof's 'Uninstall Diomedes Experimental.exe': it deletes
# the fixed keys whichever folder it sits in, including a real installation's registration.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'windows-installer-registration.psm1') -Force
$proofPath = [IO.Path]::GetFullPath($ProofRoot)
$payloadPath = (Resolve-Path -LiteralPath $Payload).Path
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$allowedRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../test-results')).Path
if (-not $proofPath.StartsWith($allowedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Proof must be inside this checkout test-results' }
if (Test-Path -LiteralPath $proofPath) { throw 'Proof root must be new' }
$product = 'Diomedes.Experimental.8c27d61a-1919-4b12-9df7-20260909e001'
$keys = @(('HKCU:\Software\Diomedes\Experimental\' + $product), ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $product))
$shortcutDirectory = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nectovia Experimental 20260909'
$shortcut = Join-Path $shortcutDirectory 'Nectovia Experimental.lnk'
$legacyShortcutDirectory = Join-Path ([Environment]::GetFolderPath('Programs')) 'Diomedes Experimental 20260909'
$legacyShortcut = Join-Path $legacyShortcutDirectory 'Diomedes Experimental.lnk'
$pins = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$installTarget = Join-Path $proofPath 'installation'
$pending = Get-PendingRestore
if ($pending) { throw ('An earlier installer proof has not handed back the registration it found (' + $pending.snapshot + '). Run scripts/restore-windows-installer-registration.ps1 before anything else, and never that proof''s own uninstaller.') }

# Everything up to the first install only reads, and refuses a registration it could not restore.
$before = Get-RegistrationSnapshot -SubKeys @($keys | ForEach-Object { $_.Substring('HKCU:\'.Length) }) -ShortcutDirectory $shortcutDirectory -InstallTarget $installTarget
$legacyBefore = Get-RegistrationSnapshot -SubKeys @() -ShortcutDirectory $legacyShortcutDirectory -InstallTarget $installTarget
$existingInstallDir = if (Test-Path -LiteralPath $keys[0]) { (Get-ItemProperty -LiteralPath $keys[0]).InstallDir } else { $null }
if ($existingInstallDir -and ($proofPath + '\').StartsWith($existingInstallDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw ('The existing installation contains the proof root: ' + $existingInstallDir) }
$installListing = @(Get-DirectoryListing $existingInstallDir)
$pinListing = @(Get-TaskbarPinListing $pins)
New-Item -ItemType Directory -Path $proofPath | Out-Null
$snapshotDirectory = Join-Path (Get-ProofStateDirectory) ('snapshot-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + $PID)
$snapshotPath = Save-RegistrationSnapshot $before $snapshotDirectory
# The older Start Menu folder is recorded beside the rest, where the restore script finds it.
$legacySnapshotDirectory = Join-Path $snapshotDirectory 'legacy-start-menu'
Save-RegistrationSnapshot $legacyBefore $legacySnapshotDirectory | Out-Null
$evidenceDirectory = Join-Path $proofPath 'registration-before'
Copy-Item -LiteralPath $snapshotDirectory -Destination $evidenceDirectory -Recurse
$preExisting = (Test-RegistrationPresent $before) -or (Test-RegistrationPresent $legacyBefore)
$proof = [ordered]@{ startedAt=(Get-Date).ToUniversalTime().ToString('o'); installer=$installerPath; installerSha256=(Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant(); installTarget=$installTarget; registryKeys=$keys; preExistingRegistration=[ordered]@{ present=$preExisting; installDir=$existingInstallDir; installDirFileCount=$installListing.Count; snapshot=(Join-Path $evidenceDirectory 'snapshot.json') }; checks=@(); passed=$false }
Set-PendingRestore $snapshotPath

# With a registration already present, a key or shortcut merely existing proves nothing: each
# value has to name this installation.
function Assert-ProofRegistration([string]$Stage) {
  foreach ($key in $keys) { if (-not (Test-Path -LiteralPath $key)) { throw ($Stage + ' left registration missing: ' + $key) } }
  if (-not (Test-Path -LiteralPath $shortcut)) { throw ($Stage + ' left the shortcut missing') }
  $exe = Join-Path $installTarget 'app\nectovia.exe'
  $registered = Get-ItemProperty -LiteralPath $keys[0]
  $uninstall = Get-ItemProperty -LiteralPath $keys[1]
  $expected = [ordered]@{
    InstallDir = @($registered.InstallDir, $installTarget)
    ProductId = @($registered.ProductId, $product)
    InstallLocation = @($uninstall.InstallLocation, $installTarget)
    UninstallString = @($uninstall.UninstallString, ('"' + (Join-Path $installTarget 'Uninstall Diomedes Experimental.exe') + '"'))
    DisplayIcon = @($uninstall.DisplayIcon, $exe)
    NoModify = @($uninstall.NoModify, 1)
    NoRepair = @($uninstall.NoRepair, 1)
    ShortcutTarget = @((Get-ShortcutTarget $shortcut), $exe)
  }
  foreach ($entry in $expected.GetEnumerator()) {
    if ($entry.Value[0] -ne $entry.Value[1]) { throw ($Stage + ' registration does not name this installation: ' + $entry.Key + ' is ''' + $entry.Value[0] + ''', expected ''' + $entry.Value[1] + '''') }
  }
  if ($uninstall.DisplayName -notlike 'Nectovia Experimental 2026-09-09*') { throw ($Stage + ' registration has an unexpected DisplayName: ' + $uninstall.DisplayName) }
  if (Test-Path -LiteralPath $legacyShortcut) { throw ($Stage + ' left the shortcut from before the rename in place') }
  $uninstall
}

$bodyCompleted = $false
$failure = $null
$handBackFailure = $null
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
  $registration = Assert-ProofRegistration 'Install'
  $proof.registration = [ordered]@{ displayName=$registration.DisplayName; displayVersion=$registration.DisplayVersion }
  $proof.payloadFileCount = $payloadFiles.Count
  $proof.checks += 'Installed all payload files with identical SHA-256; both current-user keys and the Start Menu shortcut name this installation'
  $runtimeProof = Join-Path $proofPath 'runtime-proof'
  $smokeScript = if ($RuntimeSmoke -eq 'launch') { 'packaged-launch-smoke.mjs' } else { 'connections-desktop-smoke.mjs' }
  & node (Join-Path $PSScriptRoot $smokeScript) (Join-Path $installTarget 'app/nectovia.exe') $runtimeProof
  if ($LASTEXITCODE -ne 0) { throw ('Installed app smoke failed: ' + $LASTEXITCODE) }
  $proof.runtime = Join-Path $runtimeProof 'proof.json'
  $proof.runtimeSmoke = $RuntimeSmoke
  if ($RuntimeSmoke -eq 'launch') {
    $proof.checks += 'Installed executable launched on an isolated profile, answered /api/health inside its window, refused the same request from outside it, and quit cleanly'
  } else {
    $proof.checks += 'Installed executable passed full Connections desktop/crash/restart smoke with isolated profile'
  }
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
  Assert-ProofRegistration 'Repair' | Out-Null
  $proof.checks += 'Same-version repair install retained unknown data and isolated profile; all program hashes and the registration still match'
  $uninstaller = Join-Path $installTarget 'Uninstall Diomedes Experimental.exe'
  $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw ('Uninstall failed: ' + $process.ExitCode) }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-Path -LiteralPath $marker) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  foreach ($key in $keys) { if (Test-Path -LiteralPath $key) { throw ('Registration left behind: ' + $key) } }
  if ((Test-Path -LiteralPath $shortcut) -or (Test-Path -LiteralPath $legacyShortcut)) { throw 'Shortcut left behind' }
  if (Test-Path -LiteralPath $marker) { throw 'Owned marker left behind' }
  foreach ($file in $payloadFiles) {
    $relative = $file.FullName.Substring($payloadPath.Length + 1)
    if (Test-Path -LiteralPath (Join-Path (Join-Path $installTarget 'app') $relative)) { throw ('Owned payload left behind: ' + $relative) }
  }
  if ((Get-Content -LiteralPath $sentinel -Raw) -ne 'Unowned data must survive uninstall.') { throw 'Unowned file was changed' }
  if ((Get-Content -LiteralPath $profileMarker -Raw) -ne 'Isolated profile must survive uninstall.') { throw 'Profile was changed' }
  $proof.checks += 'Uninstall removed only owned payload/registration/shortcut; unknown file and isolated profile retained'
  $bodyCompleted = $true
} catch {
  $failure = $_
} finally {
  # Runs on success, on failure and on Ctrl+C. Only a killed process skips it, and then the
  # pending-restore record stops the next proof until the registration is handed back.
  try {
    $restore = Restore-RegistrationSnapshot $before $snapshotDirectory
    $legacyRestore = Restore-RegistrationSnapshot $legacyBefore $legacySnapshotDirectory
    Clear-PendingRestore $snapshotPath
    Remove-Item -LiteralPath $snapshotDirectory -Recurse -Force -ErrorAction SilentlyContinue
    $proof.registrationRestore = [ordered]@{ result=$restore; legacyStartMenu=$legacyRestore; afterFailure=(-not $bodyCompleted) }
    if (($installListing -join "`n") -ne (@(Get-DirectoryListing $existingInstallDir) -join "`n")) { throw ('The existing installation''s files changed during the proof: ' + $existingInstallDir) }
    $pinsAfter = @(Get-TaskbarPinListing $pins)
    $pinChanges = @(@($pinListing | Where-Object { $pinsAfter -notcontains $_ }) + @($pinsAfter | Where-Object { $pinListing -notcontains $_ }))
    if ($pinChanges.Count) { $proof.taskbarPinChanges = $pinChanges }
    if (@($pinChanges | Where-Object { $_ -match 'Diomedes' }).Count) { throw 'A Diomedes taskbar pin changed during the proof' }
    if ($preExisting) {
      $proof.checks += ('The registration found before the proof ({0} keys, {1} Start Menu files) was handed back and reads back identical; the existing installation''s {2} files and every Diomedes taskbar pin are unchanged' -f @($before.keys | Where-Object { $_.present }).Count, (@($before.startMenu.files).Count + @($legacyBefore.startMenu.files).Count), $installListing.Count)
    } else {
      $proof.checks += 'No registration existed before the proof and none remains after it; no Diomedes taskbar pin changed'
    }
  } catch {
    $handBackFailure = $_
  }
  $proof.passed = $bodyCompleted -and -not $failure -and -not $handBackFailure
  if ($failure) { $proof.error = $failure.Exception.Message }
  if ($handBackFailure) { $proof.handBackError = $handBackFailure.Exception.Message }
  $proof.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $proofPath 'proof.json')
}
if ($handBackFailure) {
  $message = 'Installer proof hand-back failed: ' + $handBackFailure.Exception.Message
  if ($failure) { $message += ' The proof itself had already failed: ' + $failure.Exception.Message }
  if (Get-PendingRestore) { $message += ' The registration is not handed back yet: run scripts/restore-windows-installer-registration.ps1 before anything else.' }
  throw $message
}
if ($failure) { throw $failure }
