param([Parameter(Mandatory=$true)][string]$RunRoot, [switch]$ScreenUseApproved)
$ErrorActionPreference = 'Stop'
if (-not $ScreenUseApproved) { throw 'Ask the user for immediate screen-use permission before running this proof; no reply is not permission' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$run = [IO.Path]::GetFullPath($RunRoot)
$allowed = Join-Path $repo 'test-results/customer-upgrade-0.1.7'
if (-not $run.StartsWith($allowed + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Run root must be a new child of the owned test-results directory' }
if (Test-Path -LiteralPath $run) { throw 'Run root already exists' }
Import-Module (Join-Path $repo 'scripts/windows-installer-registration.psm1') -Force
if (Get-PendingRestore) { throw 'An earlier installer proof needs registration restoration first' }
$product = 'Diomedes.Experimental.8c27d61a-1919-4b12-9df7-20260909e001'
$keys = @("Software\Diomedes\Experimental\$product", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$product")
$shortcutDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Diomedes Experimental 20260909'
$target = Join-Path $run 'installation'
$before = Get-RegistrationSnapshot -SubKeys $keys -ShortcutDirectory $shortcutDir -InstallTarget $target
$realInstall = if (Test-Path -LiteralPath ('HKCU:\' + $keys[0])) { (Get-ItemProperty -LiteralPath ('HKCU:\' + $keys[0])).InstallDir } else { $null }
if (-not $realInstall -and (Test-Path -LiteralPath (Join-Path $shortcutDir 'Diomedes Experimental.lnk'))) {
  $existingExecutable = Get-ShortcutTarget (Join-Path $shortcutDir 'Diomedes Experimental.lnk')
  if ($existingExecutable -and (Test-Path -LiteralPath $existingExecutable)) { $realInstall = Split-Path -Parent (Split-Path -Parent $existingExecutable) }
}
if ($realInstall -and $run.StartsWith($realInstall.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Proof overlaps the existing install' }
function Get-FileWitness([string]$Directory) {
  if (-not $Directory -or -not (Test-Path -LiteralPath $Directory)) { return @() }
  @(Get-ChildItem -LiteralPath $Directory -File -Recurse -Force | Sort-Object FullName | ForEach-Object {
    [ordered]@{ path=$_.FullName.Substring($Directory.TrimEnd('\').Length + 1); bytes=$_.Length; modified=$_.LastWriteTimeUtc.ToString('o'); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
}
function Get-TaskbandWitness {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband')
  if (-not $key) { return @() }
  try { @($key.GetValueNames() | Sort-Object | ForEach-Object {
    $value = $key.GetValue($_)
    $bytes = if ($value -is [byte[]]) { $value } else { [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress)) }
    [ordered]@{ name=$_; kind=$key.GetValueKind($_).ToString(); sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() }
  }) } finally { $key.Close() }
}
function Get-ProofRegistration {
  $appKey = Get-ItemProperty -LiteralPath ('HKCU:\' + $keys[0])
  $uninstall = Get-ItemProperty -LiteralPath ('HKCU:\' + $keys[1])
  $shortcut = Get-ShortcutTarget (Join-Path $shortcutDir 'Diomedes Experimental.lnk')
  if ($appKey.InstallDir -ne $target -or $uninstall.InstallLocation -ne $target -or $shortcut -ne (Join-Path $target 'app/Diomedes.exe')) { throw 'Registration does not point to the isolated installation' }
  [ordered]@{ installDir=$appKey.InstallDir; productId=$appKey.ProductId; displayVersion=$uninstall.DisplayVersion; shortcutTarget=$shortcut }
}
$pins = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar'
$realFiles = @(Get-FileWitness $realInstall)
$pinsBefore = @(Get-TaskbarPinListing $pins)
$taskbandBefore = @(Get-TaskbandWitness)
New-Item -ItemType Directory -Path $run | Out-Null
$snapshotDir = Join-Path (Get-ProofStateDirectory) ('customer-upgrade-' + [guid]::NewGuid().ToString())
$snapshotPath = Save-RegistrationSnapshot $before $snapshotDir
Copy-Item -LiteralPath $snapshotDir -Destination (Join-Path $run 'registration-before') -Recurse
$proof = [ordered]@{ startedAt=(Get-Date).ToUniversalTime().ToString('o'); runRoot=$run; installTarget=$target; originalInstall=$realInstall; host=[ordered]@{ os=[Environment]::OSVersion.VersionString; architecture=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }; priorInstaller=$null; priorRegistration=$null; upgradedRegistration=$null; runtimeExit=$null; registrationRestored=$false; originalInstallUnchanged=$false; taskbarPinsUnchanged=$false; taskbandUnchanged=$false; pendingRestoreCleared=$false; passed=$false; error=$null }
$realFiles | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $run 'original-install-before.json')
Set-PendingRestore $snapshotPath
try {
  $installer = Join-Path $allowed 'downloads/Diomedes-Experimental-0.1.6-unsigned-setup.exe'
  $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne 'b63007a600872316949bf8cdc2b2cf757a7d75c0fd728b2da2c13486f30a351d') { throw 'Published 0.1.6 installer digest mismatch' }
  $proof.priorInstaller = [ordered]@{ sha256=$hash; bytes=(Get-Item -LiteralPath $installer).Length; url='https://github.com/andrewgodowsky-aoa/diomedes/releases/download/v0.1.6/Diomedes-Experimental-0.1.6-unsigned-setup.exe' }
  $installed = Start-Process -FilePath $installer -ArgumentList @('/S', ('/D=' + $target)) -WindowStyle Hidden -PassThru -Wait
  $proof.priorInstaller.exitCode = $installed.ExitCode
  if ($installed.ExitCode -ne 0) { throw 'Prior installer failed' }
  $proof.priorRegistration = Get-ProofRegistration
  if ($proof.priorRegistration.displayVersion -ne '0.1.6') { throw 'Prior registered version is not 0.1.6' }
  & node (Join-Path $PSScriptRoot 'runtime-proof.mjs') $run --screen-use-approved
  $proof.runtimeExit = $LASTEXITCODE
  if ($LASTEXITCODE -ne 0) { throw 'Installed updater/runtime proof failed; see runtime-proof.json' }
  $proof.upgradedRegistration = Get-ProofRegistration
  if ($proof.upgradedRegistration.displayVersion -ne '0.1.7') { throw 'Upgraded registration is not 0.1.7' }
} catch { $proof.error = $_.Exception.Message }
finally {
  try {
    # The helper launches this exact file. Never kill a real app or unrelated setup.
    $ownedInstaller = Join-Path $run 'data/updates/Diomedes-Experimental-0.1.7-unsigned-setup.exe'
    @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $ownedInstaller }) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
    $proof.registrationRestoreResult = Restore-RegistrationSnapshot $before $snapshotDir
    $proof.registrationRestored = @(Compare-RegistrationSnapshot $before).Count -eq 0
    $realAfter = @(Get-FileWitness $realInstall)
    $realAfter | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $run 'original-install-after.json')
    $proof.originalInstallFileCount = $realFiles.Count
    $proof.originalInstallUnchanged = ($realFiles | ConvertTo-Json -Depth 8 -Compress) -ceq ($realAfter | ConvertTo-Json -Depth 8 -Compress)
    $proof.taskbarPinsUnchanged = ($pinsBefore -join "`n") -ceq (@(Get-TaskbarPinListing $pins) -join "`n")
    $proof.taskbandUnchanged = ($taskbandBefore | ConvertTo-Json -Depth 8 -Compress) -ceq (@(Get-TaskbandWitness) | ConvertTo-Json -Depth 8 -Compress)
    if (-not $proof.registrationRestored -or -not $proof.originalInstallUnchanged -or -not $proof.taskbarPinsUnchanged -or -not $proof.taskbandUnchanged) { throw 'Original installation/registration/taskbar witness differs' }
    Clear-PendingRestore $snapshotPath
    $proof.pendingRestoreCleared = -not [bool](Get-PendingRestore)
  } catch { $proof.restoreError = $_.Exception.Message }
  $proof.passed = -not $proof.error -and -not $proof.restoreError -and $proof.runtimeExit -eq 0 -and $proof.pendingRestoreCleared
  $proof.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $proof | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $run 'installer-proof.json')
  $proof | ConvertTo-Json -Depth 12
}
if (-not $proof.passed) { exit 1 }
