param(
  [Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Name,
  [Parameter(Mandatory)][string]$Slot,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$Candidate,
  [ValidatePattern('^[a-z0-9-]+\.json$')][string]$Freeze = 'original-red-freeze.json',
  [ValidateSet('root', 'control-plane')][string]$Area = 'root',
  [Parameter(Mandatory)][string]$Executable,
  [string[]]$Arguments = @()
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$personalWorktree = 'F:/Diomedes/diomedes-wt/accounts-security-personal-access'
$personalRoot = 'F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913'
$personalEvidence = Join-Path $personalWorktree 'docs/implementation/accounts-security-personal-access'
$personalFreeze = Get-Content -Raw -LiteralPath (Join-Path $personalEvidence $Freeze) | ConvertFrom-Json
$personalLog = Join-Path $personalEvidence "$Name.log"
$personalRecord = Join-Path $personalEvidence "$Name.json"
if ((Test-Path -LiteralPath $personalLog) -or (Test-Path -LiteralPath $personalRecord)) { throw 'Evidence name already used' }

function Assert-PersonalOwner {
  $held = Get-Content -Raw -LiteralPath (Join-Path $personalRoot 'slot/heavy.json') | ConvertFrom-Json -DateKind String
  if ($held.slotId -ne $Slot -or $held.owner.pid -ne 67556 -or $held.owner.role -ne 'astra' -or
      $held.owner.host -ne 'Andrews-Desktop' -or $held.owner.worktree -ne $personalWorktree -or
      [DateTimeOffset]::Parse($held.owner.processStart).UtcTicks -ne [DateTimeOffset]::Parse('2026-09-28T06:26:04.4976080Z').UtcTicks) {
    throw 'Own slot identity does not match'
  }
  if ((git -C $personalWorktree rev-parse HEAD) -ne $Candidate) { throw 'Candidate moved' }
}

function Read-PersonalHashes {
  $hashes = [ordered]@{}
  foreach ($property in $personalFreeze.sha256.psobject.Properties) {
    $hashes[$property.Name] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $personalWorktree $property.Name)).Hash.ToLowerInvariant()
  }
  return $hashes
}

function Assert-PersonalHashes($hashes) {
  foreach ($property in $personalFreeze.sha256.psobject.Properties) {
    if ($hashes[$property.Name] -ne $property.Value) { throw ('Frozen input changed: ' + $property.Name) }
  }
}

Assert-PersonalOwner
$before = Read-PersonalHashes
Assert-PersonalHashes $before
$personalTemp = 'F:/Temp/andre/astra-accounts-security-personal-access/runtime'
New-Item -ItemType Directory -Path $personalTemp -Force | Out-Null
$env:TEMP = $personalTemp
$env:TMP = $personalTemp
$env:CP_TEST_DATABASE_URL = $null
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
$env:NO_COLOR = '1'
$personalDirectory = if ($Area -eq 'root') { $personalWorktree } else { Join-Path $personalWorktree 'services/control-plane' }
Set-Location -LiteralPath $personalDirectory
$startedAt = Get-Date -AsUTC -Format o
& $Executable @Arguments *> $personalLog
$originalExit = $LASTEXITCODE
$finishedAt = Get-Date -AsUTC -Format o
$after = Read-PersonalHashes
[ordered]@{
  name = $Name
  candidate = $Candidate
  slot = $Slot
  directory = $personalDirectory
  executable = $Executable
  arguments = $Arguments
  startedAt = $startedAt
  finishedAt = $finishedAt
  exitCode = $originalExit
  log = "$Name.log"
  sha256BeforeRun = $before
  sha256AfterRun = $after
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $personalRecord -Encoding utf8NoBOM
Assert-PersonalOwner
Assert-PersonalHashes $after
Get-Content -LiteralPath $personalLog -Tail 20
Write-Output "Original evidence: $Name; exit code: $originalExit"
exit $originalExit
