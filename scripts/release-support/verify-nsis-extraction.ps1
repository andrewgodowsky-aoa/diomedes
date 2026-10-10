# The trusted builder runs this comparison before every compiler execution.
# ZIP entry streams and extracted files are hashed without loading them in full.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Stream-Sha256([System.IO.Stream]$Stream) {
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}

function Assert-RegularItem([string]$ItemPath, [bool]$Directory) {
  $item = Get-Item -LiteralPath $ItemPath -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $item.LinkType -or $item.PSIsContainer -ne $Directory) {
    throw "NSIS extraction has an unexpected link or entry: $ItemPath."
  }
  return $item
}

$zipPath = [System.IO.Path]::GetFullPath($env:DIOMEDES_NSIS_ZIP)
$extractRoot = [System.IO.Path]::GetFullPath($env:DIOMEDES_NSIS_DEST).TrimEnd('\', '/')
$expected = $env:DIOMEDES_NSIS_SHA256
$version = $env:DIOMEDES_NSIS_VERSION
if ($expected -notmatch '^[0-9a-f]{64}$' -or $version -notmatch '^\d+\.\d+$') {
  throw 'No valid pinned NSIS identity was supplied.'
}
$null = Assert-RegularItem $zipPath $false
$null = Assert-RegularItem $extractRoot $true
# Keep the verified archive open without write/delete sharing while reading
# both its digest and all its entries; a later cache replacement cannot alter
# the expected bytes halfway through this comparison.
$archiveStream = [System.IO.File]::Open($zipPath, 'Open', 'Read', 'Read')
$archive = $null
try {
  $actual = Stream-Sha256 $archiveStream
  if ($actual -ne $expected) { throw "NSIS cache SHA-256 mismatch at $zipPath." }
  $archiveStream.Position = 0
  $archive = New-Object System.IO.Compression.ZipArchive($archiveStream, [System.IO.Compression.ZipArchiveMode]::Read, $true)
  $files = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
  $directories = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $entries = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName
    $isDirectory = $name.EndsWith('/')
    $relative = $name.TrimEnd('/')
    $parts = $relative.Split('/')
    if (-not $relative -or $name.Contains('\') -or $name.Contains(':') -or
        $parts -contains '' -or $parts -contains '.' -or $parts -contains '..' -or
        (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000 -or
        ($entry.ExternalAttributes -band 0x400) -ne 0 -or -not $entries.Add($relative)) {
      throw "NSIS archive has an unsafe or duplicate entry: $name."
    }
    # Directories implied by file names count too, even when the ZIP omitted
    # separate directory entries.
    for ($index = 1; $index -lt $parts.Length; $index += 1) {
      $null = $directories.Add(($parts[0..($index - 1)] -join '/'))
    }
    if ($isDirectory) { $null = $directories.Add($relative); continue }
    $files.Add($relative, $entry)
  }
  $compiler = "nsis-$version/makensis.exe"
  if (-not $files.ContainsKey($compiler)) { throw "NSIS archive has no $compiler." }
  foreach ($directory in $directories) {
    if ($files.ContainsKey($directory)) { throw "NSIS archive repeats a file as a directory: $directory." }
    $null = Assert-RegularItem (Join-Path $extractRoot $directory) $true
  }
  foreach ($relative in $files.Keys) {
    $entry = $files[$relative]
    $filePath = Join-Path $extractRoot $relative
    $item = Assert-RegularItem $filePath $false
    if ($item.Length -ne $entry.Length) { throw "NSIS extraction size mismatch: $relative." }
    $hashSource = $entry.Open()
    try { $fromZip = Stream-Sha256 $hashSource } finally { $hashSource.Dispose() }
    $hashSource = [System.IO.File]::Open($filePath, 'Open', 'Read', 'Read')
    try { $fromDisk = Stream-Sha256 $hashSource } finally { $hashSource.Dispose() }
    if ($fromDisk -ne $fromZip) { throw "NSIS extraction SHA-256 mismatch: $relative." }
  }
  # GetChildItem -Recurse can follow reparse points. Walk only directories
  # already proved ordinary and refuse every file or directory absent from ZIP.
  function Inspect-Directory([string]$Directory) {
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
      $relative = $item.FullName.Substring($extractRoot.Length + 1).Replace('\', '/')
      $null = Assert-RegularItem $item.FullName ([bool]$item.PSIsContainer)
      if ($item.PSIsContainer) {
        if (-not $directories.Contains($relative)) { throw "Unexpected NSIS extraction directory: $relative." }
        Inspect-Directory $item.FullName
      } elseif (-not $files.ContainsKey($relative)) { throw "Unexpected NSIS extraction file: $relative." }
    }
  }
  Inspect-Directory $extractRoot
  @{ archiveSha256 = $actual; files = $files.Count } | ConvertTo-Json -Compress
} finally {
  if ($archive) { $archive.Dispose() }
  $archiveStream.Dispose()
}
