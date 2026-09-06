$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $PSScriptRoot '.data/runtime/host-process.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'There is no recorded Diomedes launch to stop.' }
$launch = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$hostProcess = Get-Process -Id $launch.pid -ErrorAction SilentlyContinue
if (-not $hostProcess) { Write-Output 'The recorded Diomedes process has already stopped.'; exit 0 }
$recordedStart = [DateTimeOffset]$launch.startTimeUtc
$currentStart = $hostProcess.StartTime.ToUniversalTime()
if ($currentStart.Ticks -ne $recordedStart.UtcDateTime.Ticks -or $hostProcess.Path -ne $launch.executable) { throw 'The PID now belongs to a different process. Nothing was stopped.' }
$processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $launch.pid)
if (-not $processInfo.CommandLine.Contains($launch.entry)) { throw 'The process no longer matches the recorded Diomedes entry point. Nothing was stopped.' }
& "$env:SystemRoot/System32/taskkill.exe" /PID $launch.pid /T /F
if ($LASTEXITCODE -ne 0) { throw 'Windows could not stop the recorded Diomedes process tree.' }
Write-Output 'Diomedes stopped. Any interrupted recorded write is reconciled when the app next starts.'
