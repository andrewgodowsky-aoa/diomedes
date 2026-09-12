<#
.SYNOPSIS
  Authenticode-sign one or more Windows binaries with Azure Artifact Signing
  (formerly Trusted Signing) and verify the result. Nothing here holds a key.

.DESCRIPTION
  The certificate never leaves Microsoft's HSM: SignTool calls the Artifact
  Signing dlib, which authenticates with DefaultAzureCredential (an `az login`
  session, or the AZURE_* environment variables on a build machine) and asks
  the service to sign the file's hash. There is no PFX, no password and no
  thumbprint in this script or its arguments, and none is accepted.

  Configuration comes from three environment variables, so a machine that has
  not been set up simply cannot sign, and says so:

    DIOMEDES_SIGN_METADATA  Path to the metadata.json that names the Artifact
                            Signing endpoint, account and certificate profile
                            (see docs/releases/CODE_SIGNING.md).
    DIOMEDES_SIGNTOOL       Path to signtool.exe from the Windows SDK build
                            tools (10.0.2261.755 or later).
    DIOMEDES_SIGN_DLIB      Path to Azure.CodeSigning.Dlib.dll (x64) from the
                            Microsoft.ArtifactSigning.Client package.

  Every signed file is verified with `signtool verify /pa /v` afterwards, and
  the script exits non-zero if verification fails. Timestamps come from
  Microsoft's public RSA timestamping authority, so the signature outlives the
  service's short-lived certificate.

.EXAMPLE
  pwsh scripts/sign-windows.ps1 -Path release\Diomedes-win32-x64\Diomedes.exe

.EXAMPLE
  pwsh scripts/sign-windows.ps1 -Path a.exe, b.exe -Description "Diomedes"

.EXAMPLE
  pwsh scripts/sign-windows.ps1 -Path a.exe -Check
  # Only reports whether the machine is configured; signs nothing.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string[]]$Path,

  # Shown in the UAC / properties dialog as the program name.
  [string]$Description = 'Diomedes',

  # Report the configuration state and exit without signing.
  [switch]$Check
)

$ErrorActionPreference = 'Stop'

$metadata = $env:DIOMEDES_SIGN_METADATA
$signtool = $env:DIOMEDES_SIGNTOOL
$dlib = $env:DIOMEDES_SIGN_DLIB
$missing = @()
if (-not $metadata) { $missing += 'DIOMEDES_SIGN_METADATA' }
if (-not $signtool) { $missing += 'DIOMEDES_SIGNTOOL' }
if (-not $dlib) { $missing += 'DIOMEDES_SIGN_DLIB' }

if ($missing.Count -gt 0) {
  Write-Output ("[sign-windows] not configured: set " + ($missing -join ', ') + ". See docs/releases/CODE_SIGNING.md.")
  exit 2
}
foreach ($required in @($metadata, $signtool, $dlib)) {
  if (-not (Test-Path -LiteralPath $required)) {
    Write-Output "[sign-windows] not configured: $required does not exist."
    exit 2
  }
}
# Refuse a metadata file that carries anything secret-shaped. The service is
# authenticated by Azure identity, never by a value in this file.
$metadataText = Get-Content -Raw -LiteralPath $metadata
if ($metadataText -match '(?i)"(ClientSecret|Password|Pfx|PrivateKey|Thumbprint)"') {
  Write-Output '[sign-windows] refused: the metadata file must not contain a secret, key or thumbprint.'
  exit 3
}
if ($Check) {
  Write-Output "[sign-windows] configured: signtool=$signtool dlib=$dlib metadata=$metadata"
  exit 0
}

$failed = 0
foreach ($file in $Path) {
  $target = (Resolve-Path -LiteralPath $file).Path
  Write-Output "[sign-windows] signing $target"
  & $signtool sign /v /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 /d $Description /dlib $dlib /dmdf $metadata $target
  if ($LASTEXITCODE -ne 0) {
    Write-Output "[sign-windows] sign failed for $target (exit $LASTEXITCODE)"
    $failed += 1
    continue
  }
  & $signtool verify /pa /v $target
  if ($LASTEXITCODE -ne 0) {
    Write-Output "[sign-windows] verify failed for $target (exit $LASTEXITCODE)"
    $failed += 1
    continue
  }
  $sig = Get-AuthenticodeSignature -LiteralPath $target
  Write-Output ("[sign-windows] " + $sig.Status + " subject=" + $sig.SignerCertificate.Subject + " timestamp=" + $sig.TimeStamperCertificate.Subject)
}
if ($failed -gt 0) { exit 1 }
exit 0
