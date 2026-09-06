param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$runtimeFolder = Join-Path $appRoot '.data/runtime'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$serverPath = Join-Path $appRoot 'server/index.ts'
$distPath = Join-Path $appRoot 'dist/index.html'
if (-not (Test-Path -LiteralPath $distPath)) { throw 'Build Diomedes first: npm run build' }
$listener = Get-NetTCPConnection -State Listen -LocalPort 47631 -ErrorAction SilentlyContinue
if ($listener) { throw 'Port 47631 is already in use. Open the running app at http://127.0.0.1:47631, or stop its owning service first.' }
New-Item -ItemType Directory -Path $runtimeFolder -Force | Out-Null
$hostProcess = Start-Process -FilePath $nodePath -ArgumentList @('--import', 'tsx', ('"' + $serverPath + '"'), '--production') -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeFolder 'host.log') -RedirectStandardError (Join-Path $runtimeFolder 'host-error.log')
@{ pid = $hostProcess.Id; startTimeUtc = $hostProcess.StartTime.ToUniversalTime().ToString('o'); executable = $nodePath; entry = $serverPath } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeFolder 'host-process.json')
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($hostProcess.HasExited) { throw ('Diomedes stopped during startup. Read ' + (Join-Path $runtimeFolder 'host-error.log')) }
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:47631/api/health' -TimeoutSec 1
        if ($health.ok -eq $true -and $health.name -eq 'Diomedes') { $ready = $true; break }
    } catch [System.Net.WebException] { Start-Sleep -Milliseconds 200 }
      catch [System.Net.Http.HttpRequestException] { Start-Sleep -Milliseconds 200 }
}
if (-not $ready) { throw 'Diomedes did not report ready. Read .data/runtime/host-error.log and use Stop-Diomedes.ps1 to stop this launch.' }
Write-Output ('Diomedes is running at http://127.0.0.1:47631 (PID ' + $hostProcess.Id + '). Stop it with Stop-Diomedes.ps1.')
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:47631' }
