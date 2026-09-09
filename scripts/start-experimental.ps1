param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$exePath = (Resolve-Path -LiteralPath $Executable).Path
if ([IO.Path]::GetFileName($exePath) -ne 'Diomedes.exe') { throw 'Choose the explicit packaged Diomedes.exe.' }
$evaluationRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('Diomedes Experimental Evaluations\' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($evaluationRoot) | Out-Null
$startInfo = New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName = $exePath
$startInfo.WorkingDirectory = $evaluationRoot
$startInfo.UseShellExecute = $false
foreach ($entry in @(@('DIOMEDES_DESKTOP_PROFILE','profile'), @('DIOMEDES_DATA_DIR','data'), @('DIOMEDES_PROJECTS_DIR','projects'), @('CODEX_HOME','synthetic-codex'))) {
  $value = Join-Path $evaluationRoot $entry[1]
  [IO.Directory]::CreateDirectory($value) | Out-Null
  $startInfo.EnvironmentVariables[$entry[0]] = $value
}
$startInfo.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
$startInfo.EnvironmentVariables.Remove('DIOMEDES_TEST_HOLD_TRIAGE')
$startInfo.EnvironmentVariables['DIOMEDES_TEST_MODE'] = '0'
$process = [Diagnostics.Process]::Start($startInfo)
Write-Output ('Started isolated experimental app. PID: ' + $process.Id)
Write-Output ('Evaluation files: ' + $evaluationRoot)
