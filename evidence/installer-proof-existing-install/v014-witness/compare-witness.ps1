param(
  [Parameter(Mandatory=$true)][string]$Before,
  [Parameter(Mandatory=$true)][string]$After,
  [Parameter(Mandatory=$true)][string]$Out
)

# Compares two installer-proof witnesses value by value and writes the verdict.
#
# A plain textual diff of the two witness files is misleading. installer-witness.ps1 builds each
# per-value record as an unordered PowerShell hashtable, so ConvertTo-Json is free to emit "kind"
# before "data" in one run and after it in the next. That reorders roughly 250 lines while changing
# nothing. This script parses both files and compares leaf values by path, so key order cannot
# produce a false difference and a real one cannot hide behind the noise.
#
# takenAt is excluded on purpose: it is the only field that is meant to differ.

$ErrorActionPreference = 'Stop'

function Flatten($node, [string]$path, [System.Collections.Specialized.OrderedDictionary]$bag) {
  if ($null -eq $node) { $bag[$path] = '<null>'; return }
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    foreach ($p in ($node.PSObject.Properties | Sort-Object Name)) { Flatten $p.Value "$path.$($p.Name)" $bag }
  } elseif ($node -is [System.Object[]]) {
    for ($i = 0; $i -lt $node.Count; $i++) { Flatten $node[$i] "$path[$i]" $bag }
  } else {
    $bag[$path] = "$node"
  }
}

$b = Get-Content -LiteralPath $Before -Raw | ConvertFrom-Json
$a = Get-Content -LiteralPath $After  -Raw | ConvertFrom-Json

$fields = @('productKey','uninstallKey','installDir','installPresent','installFileCount','installFiles','startMenuDir','startMenuFiles','taskbarPins','taskband')

$bl = [ordered]@{}; $al = [ordered]@{}
foreach ($f in $fields) { Flatten $b.$f $f $bl; Flatten $a.$f $f $al }

$differences = @()
foreach ($k in $bl.Keys) {
  if (-not $al.Contains($k)) { $differences += @{ path = $k; before = $bl[$k]; after = '<missing>' } }
  elseif ($bl[$k] -ne $al[$k]) { $differences += @{ path = $k; before = $bl[$k]; after = $al[$k] } }
}
foreach ($k in $al.Keys) {
  if (-not $bl.Contains($k)) { $differences += @{ path = $k; before = '<missing>'; after = $al[$k] } }
}

$result = [ordered]@{
  comparedAt      = (Get-Date).ToUniversalTime().ToString('o')
  before          = @{ file = (Split-Path -Leaf $Before); takenAt = $b.takenAt }
  after           = @{ file = (Split-Path -Leaf $After);  takenAt = $a.takenAt }
  fieldsCompared  = $fields
  excluded        = @('takenAt')
  leafCount       = @{ before = $bl.Count; after = $al.Count }
  differenceCount = $differences.Count
  differences     = $differences
  identical       = ($differences.Count -eq 0)
}

$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Out -Encoding utf8
"leaves compared : $($bl.Count) / $($al.Count)"
"differences     : $($differences.Count)"
"identical       : $($result.identical)"
"written         : $Out"
