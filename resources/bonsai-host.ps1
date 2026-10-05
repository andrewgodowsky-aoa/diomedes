#Requires -Version 7.4
# Holds the local model for one Nectovia request, and starts or switches it only on the person's Start.
# What the model is comes from its folder's nectovia-connection.json, which the app has already checked
# and passes in NECTOVIA_LOCAL_MODEL: its server address, model id, profiles and its own start and stop
# scripts, each a .ps1 file inside that folder. Model output never chooses a command here.
[CmdletBinding()]
param(
    # The descriptor's name for the profile to hold, or with a Start, to start.
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z][A-Za-z0-9_-]{0,31}$')][string]$Mode,
    [Parameter(Mandatory)][string]$OwnershipFile,
    # The ownership record an earlier build wrote. A worker that build started is still honored.
    [string]$EarlierOwnershipFile,
    # Inference passes this: only the person's explicit Start may start or switch the worker.
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$lease = $null

function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }
function Fail([string]$state, [string]$detail) {
    Emit @{ state = $state; installed = $true; mode = $null; owned = $false; detail = $detail }
    exit 1
}
if (-not $env:NECTOVIA_LOCAL_MODEL) { Fail 'error' 'The local model helper was started without its descriptor.' }
$model = $env:NECTOVIA_LOCAL_MODEL | ConvertFrom-Json
$wanted = @($model.profiles | Where-Object { $_.mode -ceq $Mode })
if ($wanted.Count -ne 1) { Fail 'error' "The local model has no $Mode profile." }
$port = ([Uri]$model.baseUrl).Port

# The server is whatever process listens on the descriptor's port.
function Server-Process {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { return $null }
    $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) { throw "More than one process listens on port $port." }
    return Get-Process -Id $owners[0] -ErrorAction SilentlyContinue
}
function Identity($process) {
    try { return @{ pid = $process.Id; startedUtcTicks = $process.StartTime.ToUniversalTime().Ticks; executable = $process.Path } }
    catch { return $null }
}
function Is-Owned($process) {
    if (-not $process) { return $false }
    $identity = Identity $process
    if (-not $identity -or -not $identity.executable) { return $false }
    foreach ($file in @($OwnershipFile, $EarlierOwnershipFile)) {
        if (-not $file -or -not (Test-Path -LiteralPath $file)) { continue }
        $owner = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        if ($owner.pid -eq $identity.pid -and $owner.startedUtcTicks -eq $identity.startedUtcTicks -and $owner.executable -eq $identity.executable) {
            return $true
        }
    }
    return $false
}
# The same reads as the app's status: health, then the model list, then llama.cpp's /props. Null while
# the server is loading. The running profile is the one whose context is the context the server runs.
function Read-Live {
    try { $health = Invoke-RestMethod $model.healthUrl -TimeoutSec 2 -MaximumRedirection 0 }
    catch [Microsoft.PowerShell.Commands.HttpResponseException] {
        if ([int]$_.Exception.Response.StatusCode -eq 503) { return $null }
        throw
    }
    catch [System.Net.Http.HttpRequestException] { return $null }
    if ($health -and $health.PSObject.Properties['status'] -and "$($health.status)" -ne 'ok') { return $null }
    $listed = Invoke-RestMethod "$($model.baseUrl)/models" -TimeoutSec 3 -MaximumRedirection 0
    if ($model.model -cnotin @($listed.data | ForEach-Object { $_.id })) { throw "The local server does not list $($model.model)." }
    $context = $null
    $vision = $null
    try {
        $props = Invoke-RestMethod "$($model.serverRoot)/props" -TimeoutSec 3 -MaximumRedirection 0
        $context = $props.default_generation_settings.n_ctx
        if ($props.PSObject.Properties['modalities'] -and $null -ne $props.modalities.vision) { $vision = [bool]$props.modalities.vision }
    } catch { $context = $null }
    $running = $null
    if ($context) {
        $running = @($model.profiles | Where-Object { $_.contextTokens -eq $context -and -not ($_.images -and $vision -eq $false) }) |
            Select-Object -First 1
    }
    return @{ context = $context; mode = $(if ($running) { $running.mode } else { $null }) }
}
function Wait-Live($server) {
    $deadline = (Get-Date).AddSeconds(190)
    while ($true) {
        $now = Server-Process
        if (-not $now -or $now.Id -ne $server.Id) { throw 'The local model stopped while starting. Check its logs.' }
        $live = Read-Live
        if ($live) { return $live }
        if ((Get-Date) -gt $deadline) { throw 'The local model is still loading. Check its logs before retrying.' }
        Start-Sleep -Milliseconds 500
    }
}
function Context-Words($context) { $context.ToString('N0', [Globalization.CultureInfo]::InvariantCulture) }

try {
    if (-not $env:ProgramFiles) { $env:ProgramFiles = [Environment]::GetFolderPath('ProgramFiles') }
    # Exclusive sharing conflicts with any other client holding the folder's delegate.lock, such as an
    # MCP bridge, as well as other Nectovia hosts. Keep it open for the whole inference call, not only
    # while the model starts.
    try { $lease = [IO.File]::Open((Join-Path $model.folder 'delegate.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { Fail 'busy' 'The local model is in use by another client. Wait for it to finish.' }
    $server = Server-Process
    $owned = Is-Owned $server
    $live = $null
    if (-not $server) {
        if ($NoStart) { Fail 'unloaded' "The local model isn't running. Start it first." }
    } else {
        $live = Wait-Live $server
        if ($live.mode -cne $Mode) {
            if ($NoStart) {
                if ($live.mode) { Fail 'unloaded' "The local model is running its $($live.mode) profile, not $Mode. Start $Mode first." }
                if ($live.context) {
                    Fail 'unloaded' "The local model is running with $(Context-Words $live.context) tokens of context, which matches none of its profiles. Start $Mode first."
                }
                Fail 'unloaded' "The local model did not report its context size, so its profile is unknown. Start $Mode first."
            }
            if (-not $owned) { Fail 'busy' "The local model was started outside Nectovia. Stop it in its own app before choosing $Mode." }
            $slots = @(Invoke-RestMethod "$($model.serverRoot)/slots" -TimeoutSec 3 -MaximumRedirection 0)
            if (-not $slots.Count -or @($slots | Where-Object { $_.is_processing -ne $false }).Count) {
                Fail 'busy' 'The local model has an active request. Wait before changing profiles.'
            }
            & $model.stopScript | Out-Null
            $deadline = (Get-Date).AddSeconds(20)
            while ((Server-Process)) {
                if ((Get-Date) -gt $deadline) { throw 'The local model did not stop. Check its logs.' }
                Start-Sleep -Milliseconds 500
            }
            $server = $null
        }
    }
    if (-not $server) {
        # The model's own start script, with the profile as its mode argument. It owns the GPU checks
        # and the server's settings for that profile.
        $arguments = @{ $model.modeParameter = $Mode }
        & $model.startScript @arguments | Out-Null
        $deadline = (Get-Date).AddSeconds(190)
        while (-not ($server = Server-Process)) {
            if ((Get-Date) -gt $deadline) { throw 'The local model did not start. Check its logs.' }
            Start-Sleep -Milliseconds 500
        }
        # A separate launcher can race this helper without taking delegate.lock. Adopt ownership only
        # when this helper actually created the process that listens.
        $created = Get-CimInstance Win32_Process -Filter "ProcessId=$($server.Id)"
        $owned = $created.ParentProcessId -eq $PID
        $identity = Identity $server
        if ($owned -and $identity -and $identity.executable) {
            New-Item -ItemType Directory -Path (Split-Path $OwnershipFile) -Force | Out-Null
            $identity | ConvertTo-Json | Set-Content -LiteralPath $OwnershipFile -Encoding utf8
        }
        $live = Wait-Live $server
        if ($live.mode -cne $Mode) { throw "The local model did not start in its $Mode profile." }
    }
    Emit @{ state = 'ready'; installed = $true; mode = $Mode; model = $model.model; contextTokens = $live.context; owned = $owned
        detail = "$($model.model) $Mode is ready." }
    # EOF when Nectovia exits also releases this lease. Never stop the model on disconnect.
    [Console]::In.ReadLine() | Out-Null
} catch {
    $message = $_.Exception.Message
    if ($message -match 'needs at least \d+ MiB of free VRAM') { Fail 'insufficient-memory' $message }
    Fail 'error' $message
} finally {
    if ($lease) { $lease.Dispose() }
}
