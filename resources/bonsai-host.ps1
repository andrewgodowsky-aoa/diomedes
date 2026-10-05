#Requires -Version 7.4
[CmdletBinding()]
param(
    [ValidateSet('Status', 'Acquire')][string]$Action = 'Status',
    [ValidateSet('Gaming', 'Full')][string]$Mode = 'Gaming',
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$OwnershipFile,
    # Inference passes this: only the person's explicit Start may start or switch the worker.
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$baseUrl = 'http://127.0.0.1:18082'
$binary = Join-Path $Root 'runtime\prism-b10743-adfffbe\llama.exe'
$statePath = Join-Path $Root 'server-state.json'
$lease = $null

function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }
function Fail([string]$state, [string]$detail) {
    Emit @{ state = $state; installed = $true; mode = $null; owned = $false; detail = $detail }
    exit 1
}
function Read-State {
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
}
function Live-Process($state) {
    if (-not $state) { return $null }
    $server = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    if (-not $server) { return $null }
    if ($server.Path -ne $binary -or $server.StartTime.ToUniversalTime().Ticks -ne $state.startedUtcTicks) {
        throw 'The saved Bonsai process identity changed. No process was stopped.'
    }
    return $server
}
function Is-Owned($state) {
    if (-not $state -or -not (Test-Path -LiteralPath $OwnershipFile)) { return $false }
    $owner = Get-Content -LiteralPath $OwnershipFile -Raw | ConvertFrom-Json
    return $owner.pid -eq $state.pid -and $owner.startedUtcTicks -eq $state.startedUtcTicks -and $owner.executable -eq $binary
}
function Check-Ready($state) {
    $listener = @(Get-NetTCPConnection -State Listen -LocalPort 18082 -ErrorAction SilentlyContinue)
    if (-not $listener.Count) { return $false }
    if (-not $state -or @($listener | Where-Object { $_.OwningProcess -ne $state.pid }).Count) {
        throw 'Port 18082 belongs to a process this Bonsai installation does not own.'
    }
    try { $health = Invoke-RestMethod "$baseUrl/health" -TimeoutSec 2 }
    catch [Microsoft.PowerShell.Commands.HttpResponseException] {
        if ([int]$_.Exception.Response.StatusCode -eq 503) { return $false }
        throw
    }
    if ($health.status -ne 'ok') { return $false }
    $models = Invoke-RestMethod "$baseUrl/v1/models" -TimeoutSec 3
    $props = Invoke-RestMethod "$baseUrl/props" -TimeoutSec 3
    $context = if ($state.mode -eq 'Gaming') { 16384 } else { 131072 }
    if ('bonsai-2-27b' -notin $models.data.id -or $props.default_generation_settings.n_ctx -ne $context) {
        throw 'The live Bonsai model or context does not match its selected profile.'
    }
    $command = (Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)").CommandLine
    $hasProjector = $command -match '--mmproj\s'
    if (($state.mode -eq 'Full') -ne $hasProjector) { throw 'Bonsai image support does not match its selected profile.' }
    return $true
}
try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'installation.json'))) {
        Emit @{ state = 'missing'; installed = $false; mode = $null; owned = $false; detail = 'Bonsai is not installed on this computer.' }
        exit 0
    }
    # The existing connection file is a specification. It never supplies executable commands to this host.
    $spec = Get-Content -LiteralPath (Join-Path $Root 'nectovia-connection.json') -Raw | ConvertFrom-Json
    if ($spec.model -ne 'bonsai-2-27b' -or $spec.openaiCompatibleBaseUrl -ne "$baseUrl/v1" -or
        $spec.profiles.Gaming.contextTokens -ne 16384 -or $spec.profiles.Full.contextTokens -ne 131072) {
        throw 'The Bonsai connection specification changed. Check this installation before using it.'
    }
    if (-not $env:ProgramFiles) { $env:ProgramFiles = [Environment]::GetFolderPath('ProgramFiles') }
    if ($Action -eq 'Acquire') {
        # Exclusive sharing conflicts with the MCP bridge's open delegate.lock as well as other Nectovia hosts.
        # Keep it open for the whole inference call, not only while the model starts.
        try { $lease = [IO.File]::Open((Join-Path $Root 'delegate.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { Fail 'busy' 'Bonsai is in use by another client. Wait for it to finish.' }
    }
    $state = Read-State
    $server = Live-Process $state
    $owned = Is-Owned $state
    if (-not $server) {
        $listener = @(Get-NetTCPConnection -State Listen -LocalPort 18082 -ErrorAction SilentlyContinue)
        if ($listener.Count) { throw 'Port 18082 is occupied. No process was started or stopped.' }
        if ($Action -eq 'Status') {
            Emit @{ state = 'unloaded'; installed = $true; mode = $null; owned = $false; detail = 'Choose a profile to load Bonsai.' }
            exit 0
        }
        if ($NoStart) { Fail 'unloaded' "The local model isn't running. Start it first." }
    } elseif ($Action -eq 'Status') {
        $ready = Check-Ready $state
        Emit @{ state = $(if ($ready) { 'ready' } else { 'starting' }); installed = $true; mode = $state.mode; owned = $owned;
            detail = $(if ($ready) { "Bonsai $($state.mode) is ready." } else { "Bonsai $($state.mode) is starting." }) }
        exit 0
    } elseif ($state.mode -ne $Mode) {
        if ($NoStart) { Fail 'unloaded' "The local model is running its $($state.mode) profile, not $Mode. Start $Mode first." }
        if (-not $owned) { Fail 'busy' "Bonsai $($state.mode) was started outside Nectovia. Stop it in its own app before choosing $Mode." }
        if (-not (Check-Ready $state)) { Fail 'busy' 'Bonsai is still starting. Wait before changing profiles.' }
        $slots = @(Invoke-RestMethod "$baseUrl/slots" -TimeoutSec 3)
        if ($slots.Count -ne 1 -or @($slots | Where-Object { $_.is_processing -ne $false }).Count) {
            Fail 'busy' 'Bonsai has an active request. Wait before changing profiles.'
        }
        & (Join-Path $Root 'Stop-Bonsai.ps1') | Out-Null
        $server = $null
    }
    if (-not $server) {
        # This launcher owns the GPU guard and conservative context/cache/projector settings.
        # It also restores ProgramFiles for NVIDIA NVML in minimal environments.
        & (Join-Path $Root 'Start-Bonsai.ps1') -Mode $Mode | Out-Null
        $state = Read-State
        $server = Live-Process $state
        if (-not $server -or $state.mode -ne $Mode) { throw 'Bonsai did not start in the requested profile.' }
        # A separate launcher can race our inspection without taking delegate.lock.
        # Adopt ownership only when this helper actually created the reported process.
        $created = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)"
        $owned = $created.ParentProcessId -eq $PID
        if ($owned) {
            New-Item -ItemType Directory -Path (Split-Path $OwnershipFile) -Force | Out-Null
            @{ pid = $state.pid; startedUtcTicks = $state.startedUtcTicks; executable = $binary } |
                ConvertTo-Json | Set-Content -LiteralPath $OwnershipFile -Encoding utf8
        }
    }
    $deadline = (Get-Date).AddSeconds(190)
    while (-not (Check-Ready $state)) {
        if (-not (Live-Process $state)) { throw 'Bonsai exited while starting. Check its launcher logs.' }
        if ((Get-Date) -gt $deadline) { throw 'Bonsai is still loading. Check its launcher logs before retrying.' }
        Start-Sleep -Milliseconds 500
    }
    Emit @{ state = 'ready'; installed = $true; mode = $state.mode; owned = $owned; detail = "Bonsai $Mode is ready." }
    # EOF when Nectovia exits also releases this lease. Never kill the model on disconnect.
    [Console]::In.ReadLine() | Out-Null
} catch {
    $message = $_.Exception.Message
    if ($message -match 'needs at least \d+ MiB of free VRAM') { Fail 'insufficient-memory' $message }
    Fail 'error' $message
} finally {
    if ($lease) { $lease.Dispose() }
}
