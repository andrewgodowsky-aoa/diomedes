# One authorized diagnostic window. No production, provider or database calls.
param([switch]$Repair)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$appPath = 'F:/Diomedes/diomedes-wt/operations-routing'
$opsPath = 'F:/Diomedes/diomedes-ops-wt/operations-routing'
$coordRoot = 'F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913'
$coordTool = "$coordRoot/tool/coordination.ts"
$tsx = "$appPath/node_modules/.bin/tsx.cmd"
$identity = @('--role', 'astra', '--pid', '67556', '--start', '2026-09-28T06:26:04.4976087Z',
  '--worktree', $appPath, '--root', $coordRoot)
$slotId = $null
$purpose = if ($Repair) { 'Authorized narrow repair check after security red: CP tsc and the same two provider/policy fixture suites only.' }
  else { 'Authorized two-minute diagnosis: CP tsc, two pure provider/policy fixture suites, Ops tsc. Serial; no other gates.' }
$waiting = [Diagnostics.Stopwatch]::StartNew()
while ($waiting.Elapsed.TotalMinutes -lt 60) {
  if (-not (Test-Path -LiteralPath "$coordRoot/slot/heavy.json")) {
    $slotText = & $tsx $coordTool slot @identity --node OPERATIONS-ROUTING-FOCUSED --purpose $purpose
    $slotAnswer = ($slotText -join "`n") | ConvertFrom-Json
    if ($slotAnswer.ok) { $slotId = $slotAnswer.slot.slotId; break }
  }
  Start-Sleep -Seconds 15
}
if (-not $slotId) { throw 'No diagnostic slot became available within this one-time wait.' }
$window = [Diagnostics.Stopwatch]::StartNew()
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$logRoot = "$appPath/test-results/operations-routing-focused-$stamp"
$checks = [Collections.Generic.List[object]]::new()

function Source-Hashes([string]$repoPath, [string[]]$paths) {
  $names = & git -C $repoPath ls-files --cached --others --exclude-standard -- @paths
  if ($LASTEXITCODE -ne 0) { throw 'Could not record source paths.' }
  foreach ($name in ($names | Sort-Object -Unique)) {
    $resolved = Join-Path $repoPath $name
    if (Test-Path -LiteralPath $resolved -PathType Leaf) {
      [pscustomobject]@{ path = "$repoPath/$name"; sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash }
    }
  }
}

try {
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $before = @((Source-Hashes $appPath @('services/control-plane', 'shared')); (Source-Hashes $opsPath @('.')))
  $before | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$logRoot/source-before.json" -Encoding utf8
  $commands = @(
    @{ name = 'control-plane-types'; cwd = "$appPath/services/control-plane"; exe = './node_modules/.bin/tsc.cmd'; args = @('--noEmit') },
    @{ name = 'provider-policy-fixtures'; cwd = "$appPath/services/control-plane"; exe = './node_modules/.bin/vitest.cmd';
      args = @('run', 'tests/operations-routing-policy.test.ts', 'tests/managed-bindings.test.ts', '--maxWorkers=1', '--minWorkers=1') }
  )
  if (-not $Repair) { $commands += @{ name = 'operations-types'; cwd = $opsPath; exe = './node_modules/.bin/tsc.cmd'; args = @('--noEmit') } }
  foreach ($check in $commands) {
    if ($window.Elapsed.TotalSeconds -ge 120) { break }
    $started = [DateTime]::UtcNow.ToString('o')
    $log = "$logRoot/$($check.name).log"
    Push-Location -LiteralPath $check.cwd
    try {
      & $check.exe @($check.args) *> $log
      $resultCode = $LASTEXITCODE
    } finally { Pop-Location }
    $checks.Add([pscustomobject]@{ name = $check.name; startedAt = $started; endedAt = [DateTime]::UtcNow.ToString('o'); exitCode = $resultCode; log = $log })
  }
  $after = @((Source-Hashes $appPath @('services/control-plane', 'shared')); (Source-Hashes $opsPath @('.')))
  $after | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$logRoot/source-after.json" -Encoding utf8
  [pscustomobject]@{ slotId = $slotId; appHead = (& git -C $appPath rev-parse HEAD); opsHead = (& git -C $opsPath rev-parse HEAD);
    checkedAt = [DateTime]::UtcNow.ToString('o'); seconds = $window.Elapsed.TotalSeconds; checks = $checks;
    sourcesUnchanged = (($before | ConvertTo-Json -Depth 4 -Compress) -eq ($after | ConvertTo-Json -Depth 4 -Compress)) } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$logRoot/result.json" -Encoding utf8
} finally {
  & $tsx $coordTool unslot @identity --slot $slotId
  if ($LASTEXITCODE -ne 0) { throw "Could not release owned slot $slotId. Inspect the coordination record." }
}
Get-Content -LiteralPath "$logRoot/result.json"
foreach ($check in $checks) {
  Write-Output $check.name
  Get-Content -LiteralPath $check.log -Tail 24
}
