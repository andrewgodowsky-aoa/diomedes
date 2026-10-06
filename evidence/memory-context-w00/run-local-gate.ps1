param([Parameter(Mandatory)][ValidateSet('unit', 'build', 'browser')][string]$Gate)
$ErrorActionPreference = 'Stop'
$gateRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($gateRoot -ne 'F:\Diomedes\diomedes-wt\memory-context-contracts') {
  throw 'This evidence runner is bound to the owned W00 worktree.'
}
Set-Location -LiteralPath $gateRoot
$gateArgs = switch ($Gate) {
  'unit' { @('node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', '--reporter=default', '--reporter=json', '--outputFile=evidence/memory-context-w00/full-final-vitest.json') }
  'build' { @('node_modules/vite/bin/vite.js', 'build') }
  'browser' {
    $env:PLAYWRIGHT_JSON_OUTPUT_NAME = 'evidence/memory-context-w00/playwright.json'
    @('node_modules/@playwright/test/cli.js', 'test', 'tests/ui.spec.ts', 'tests/native-ui.spec.ts', 'tests/field.spec.ts', '--reporter=list,json')
  }
}
$gateRecord = [ordered]@{
  gate = $Gate
  command = @('node') + $gateArgs
  cwd = $gateRoot
  base = (& git rev-parse HEAD).Trim()
  startedAt = [DateTimeOffset]::UtcNow.ToString('o')
  finishedAt = $null
  exitCode = $null
  launchError = $null
  browserPorts = if ($Gate -eq 'browser') { [ordered]@{
    client = $env:DIOMEDES_UI_CLIENT_PORT
    service = $env:DIOMEDES_UI_SERVICE_PORT
    native = $env:DIOMEDES_NATIVE_UI_PORT
  } } else { $null }
  implementation = @(Get-FileHash shared/memory.ts,shared/continuation.ts,tests/memory-contracts.test.ts,tests/memory-context-baseline.test.ts,tests/fixtures/memory-context/baseline.ts -Algorithm SHA256 | ForEach-Object { @{path=$_.Path;sha256=$_.Hash.ToLowerInvariant()} })
}
$gateLog = Join-Path $PSScriptRoot "$Gate-final.log"
try {
  & node @gateArgs *> $gateLog
  $gateRecord.exitCode = $LASTEXITCODE
} catch {
  $gateRecord.launchError = $_.Exception.Message
  $_ | Out-String | Add-Content -LiteralPath $gateLog
} finally {
  $gateRecord.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
  $gateRecord | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $PSScriptRoot "$Gate-execution.json") -Encoding utf8
}
if ($null -eq $gateRecord.exitCode) { exit 1 }
exit $gateRecord.exitCode
