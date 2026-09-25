import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// scripts/verify-windows-installer.ps1 hands a real installation's registration back through
// this module. These scenarios drive it against a scratch HKCU key and a temporary folder that
// stand in for the product's fixed keys and Start Menu folder; nothing here touches either.
const windows = process.platform === 'win32';
const modulePath = fileURLToPath(
  new URL('../scripts/windows-installer-registration.psm1', import.meta.url),
);

// PowerShell source: no backticks and no dollar-brace sequences, so String.raw carries it verbatim.
const scenarios = String.raw`
param([string]$Module, [string]$SubKeyRoot, [string]$Root, [switch]$UseShortRoot)
$ErrorActionPreference = 'Stop'
if ($UseShortRoot) {
  $shortRoot = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($Root).ShortPath
  if ($shortRoot -eq $Root) { '{"aliasAvailable":false}' ; exit 0 }
  $Root = $shortRoot
}
Import-Module $Module -Force
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
$shell = New-Object -ComObject WScript.Shell
$product = $SubKeyRoot + '\Product'
$uninstall = $SubKeyRoot + '\Uninstall'
$menu = Join-Path $Root 'Start Menu Folder'
$link = Join-Path $menu 'Diomedes Experimental.lnk'
$realExe = Join-Path $Root 'real\app\nectovia.exe'
$otherExe = Join-Path $Root 'other\Other.exe'
$target = Join-Path $Root 'proof\installation'
$proofExe = Join-Path $target 'app\nectovia.exe'
$copies = Join-Path $Root 'snapshot'
foreach ($file in $realExe, $otherExe, $proofExe) { New-Item -ItemType File -Force -Path $file | Out-Null }

function New-Shortcut([string]$Path, [string]$To) { $item = $shell.CreateShortcut($Path); $item.TargetPath = $To; $item.Save() }
function Read-Values([string]$SubKey) {
  $key = $hkcu.OpenSubKey($SubKey)
  if (-not $key) { return 'absent' }
  try { (@($key.GetValueNames() | Sort-Object | ForEach-Object { $_ + '=' + $key.GetValueKind($_) + ':' + (@($key.GetValue($_, $null, 'DoNotExpandEnvironmentNames')) -join ',') }) -join ';') } finally { $key.Close() }
}
function Get-ValueOrder([string]$SubKey) { $key = $hkcu.OpenSubKey($SubKey); try { $key.GetValueNames() -join ',' } finally { $key.Close() } }
function Get-Times([string]$Path) { $item = Get-Item -LiteralPath $Path -Force; [string]$item.CreationTimeUtc.Ticks + '|' + $item.LastWriteTimeUtc.Ticks }
function Set-OldTimes([string]$Path, [int]$Year) { $at = [DateTime]::new($Year, 1, 1, 0, 0, 0, [DateTimeKind]::Utc); $item = Get-Item -LiteralPath $Path -Force; $item.CreationTimeUtc = $at; $item.LastWriteTimeUtc = $at }
function Get-Message([scriptblock]$Block) { try { & $Block | Out-Null; 'no error' } catch { $_.Exception.Message } }
function Reset-Fixture([bool]$Present) {
  $hkcu.DeleteSubKeyTree($SubKeyRoot, $false)
  if (Test-Path -LiteralPath $menu) { Remove-Item -LiteralPath $menu -Recurse -Force }
  if (Test-Path -LiteralPath $copies) { Remove-Item -LiteralPath $copies -Recurse -Force }
  if (-not $Present) { return }
  $key = $hkcu.CreateSubKey($product)
  $key.SetValue('InstallDir', (Join-Path $Root 'real'), 'String')
  $key.SetValue('Expand', '%LOCALAPPDATA%\Programs', 'ExpandString')
  $key.SetValue('Lines', [string[]]@('2026-09-13T08:00:00Z', ''), 'MultiString')
  $key.SetValue('Blob', [byte[]]@(0, 255, 7), 'Binary')
  $key.SetValue('NoModify', -1, 'DWord')
  $key.SetValue('Big', [long]1234567890123, 'QWord')
  $key.SetValue('', 'default value', 'String')
  $key.Close()
  New-Item -ItemType Directory -Force -Path $menu | Out-Null
  New-Shortcut $link $realExe
  Set-Content -LiteralPath (Join-Path $menu 'notes.txt') -Value 'not the installer''s'
  # Old, distinctive times: a recreated shortcut or folder would otherwise carry today's.
  Set-OldTimes $link 2020
  Set-OldTimes $menu 2020
}
# What an install over the registration does, and what its uninstaller then removes.
function Invoke-Install {
  $hkcu.DeleteSubKeyTree($product, $false)
  $key = $hkcu.CreateSubKey($product); $key.SetValue('InstallDir', $target, 'String'); $key.SetValue('ProductId', 'proof', 'String'); $key.Close()
  $key = $hkcu.CreateSubKey($uninstall); $key.SetValue('DisplayName', 'proof', 'String'); $key.SetValue('InstallLocation', $target, 'String'); $key.Close()
  New-Item -ItemType Directory -Force -Path $menu | Out-Null
  New-Shortcut $link $proofExe
}
function Invoke-Uninstall {
  $hkcu.DeleteSubKeyTree($uninstall, $false); $hkcu.DeleteSubKeyTree($product, $false)
  Remove-Item -LiteralPath $link -Force
  if (@(Get-ChildItem -LiteralPath $menu -Force).Count -eq 0) { Remove-Item -LiteralPath $menu }
}
function New-Snapshot { Get-RegistrationSnapshot -SubKeys $product, $uninstall -ShortcutDirectory $menu -InstallTarget $target }

$result = [ordered]@{}
try {
  Reset-Fixture $true
  $values = Read-Values $product
  $order = Get-ValueOrder $product
  $linkHash = (Get-FileHash -LiteralPath $link).Hash
  $linkTimes = Get-Times $link
  $menuTimes = Get-Times $menu
  $snapshot = New-Snapshot
  $saved = Save-RegistrationSnapshot $snapshot $copies
  $result.present = Test-RegistrationPresent $snapshot
  Invoke-Install
  Invoke-Uninstall
  $result.differencesAfterUninstall = @(Compare-RegistrationSnapshot $snapshot).Count
  $result.restoredFromFile = Restore-RegistrationSnapshot (Read-RegistrationSnapshot $saved) $copies
  $result.valuesIdentical = (Read-Values $product) -eq $values
  $result.valueOrderIdentical = (Get-ValueOrder $product) -eq $order
  $result.linkIdentical = (Get-FileHash -LiteralPath $link).Hash -eq $linkHash
  $result.linkTimesIdentical = (Get-Times $link) -eq $linkTimes
  $result.menuTimesIdentical = (Get-Times $menu) -eq $menuTimes
  $result.uninstallKeyAbsent = (Read-Values $uninstall) -eq 'absent'
  $result.differencesAfterRestore = @(Compare-RegistrationSnapshot $snapshot).Count
  $result.restoredAgain = Restore-RegistrationSnapshot $snapshot $copies

  Reset-Fixture $true
  $values = Read-Values $product
  $snapshot = New-Snapshot
  Save-RegistrationSnapshot $snapshot $copies | Out-Null
  Invoke-Install
  $result.restoredWhileInstalled = Restore-RegistrationSnapshot $snapshot $copies
  $result.valuesIdenticalWhileInstalled = ((Read-Values $product) -eq $values) -and ((Read-Values $uninstall) -eq 'absent')

  Reset-Fixture $true
  $snapshot = New-Snapshot
  Save-RegistrationSnapshot $snapshot $copies | Out-Null
  Invoke-Install
  Remove-Item -LiteralPath $proofExe
  $result.restoredAfterExecutableRemoval = Restore-RegistrationSnapshot $snapshot $copies
  New-Item -ItemType File -Path $proofExe | Out-Null

  Reset-Fixture $true
  $values = Read-Values $product
  $linkTimes = Get-Times $link
  $menuTimes = Get-Times $menu
  $snapshot = New-Snapshot
  Save-RegistrationSnapshot $snapshot $copies | Out-Null
  Invoke-Install
  Invoke-Uninstall
  # A restore that stopped after writing the first value and the shortcut's bytes.
  $key = $hkcu.CreateSubKey($product); $key.SetValue('InstallDir', (Join-Path $Root 'real'), 'String'); $key.Close()
  Copy-Item -LiteralPath (Join-Path $copies 'start-menu\Diomedes Experimental.lnk') -Destination $link
  Set-OldTimes $link 2021
  Set-OldTimes $menu 2021
  $result.resumedRestore = Restore-RegistrationSnapshot $snapshot $copies
  $result.resumedIdentical = ((Read-Values $product) -eq $values) -and ((Get-Times $link) -eq $linkTimes) -and ((Get-Times $menu) -eq $menuTimes)

  Reset-Fixture $true
  $snapshot = New-Snapshot
  Save-RegistrationSnapshot $snapshot $copies | Out-Null
  $key = $hkcu.CreateSubKey($product); $key.SetValue('InstallDir', 'D:\Somewhere else', 'String'); $key.Close()
  $result.foreignKeyRefusal = Get-Message { Restore-RegistrationSnapshot $snapshot $copies }
  $result.foreignKeyKept = (Get-ItemProperty -LiteralPath ('HKCU:\' + $product)).InstallDir -eq 'D:\Somewhere else'

  Reset-Fixture $true
  $snapshot = New-Snapshot
  Save-RegistrationSnapshot $snapshot $copies | Out-Null
  Invoke-Install
  New-Shortcut $link $otherExe
  $foreignShortcutHash = (Get-FileHash -LiteralPath $link).Hash
  $result.foreignShortcutRefusal = Get-Message { Restore-RegistrationSnapshot $snapshot $copies }
  $result.nothingWrittenOnRefusal = ((Get-ItemProperty -LiteralPath ('HKCU:\' + $product)).InstallDir -eq $target) -and ((Get-FileHash -LiteralPath $link).Hash -eq $foreignShortcutHash)
  Remove-Item -LiteralPath $otherExe
  $result.missingForeignShortcutRefusal = Get-Message { Restore-RegistrationSnapshot $snapshot $copies }
  $result.missingForeignShortcutKept = (Get-FileHash -LiteralPath $link).Hash -eq $foreignShortcutHash
  New-Item -ItemType File -Path $otherExe | Out-Null

  Reset-Fixture $false
  $snapshot = New-Snapshot
  Save-RegistrationSnapshot $snapshot $copies | Out-Null
  $result.absentPresent = Test-RegistrationPresent $snapshot
  Invoke-Install
  $result.restoredToAbsent = Restore-RegistrationSnapshot $snapshot $copies
  $result.allAbsent = ((Read-Values $product) -eq 'absent') -and ((Read-Values $uninstall) -eq 'absent') -and -not (Test-Path -LiteralPath $menu)

  Reset-Fixture $false
  $snapshot = New-Snapshot
  New-Item -ItemType Directory -Force -Path $menu | Out-Null
  Set-Content -LiteralPath (Join-Path $menu 'someone-else.txt') -Value 'x'
  $result.foreignFileRefusal = Get-Message { Restore-RegistrationSnapshot $snapshot $copies }
  $result.foreignFileKept = Test-Path -LiteralPath (Join-Path $menu 'someone-else.txt')

  Reset-Fixture $true
  $hkcu.CreateSubKey($product + '\Nested').Close()
  $result.subkeyRefusal = Get-Message { New-Snapshot }

  $emptyKey = $SubKeyRoot + '\Empty'
  $hkcu.DeleteSubKeyTree($SubKeyRoot, $false)
  $hkcu.CreateSubKey($emptyKey).Close()
  $emptySnapshot = Get-RegistrationSnapshot -SubKeys $emptyKey -ShortcutDirectory (Join-Path $Root 'no-such-menu') -InstallTarget $target
  $result.emptyKeyValues = @($emptySnapshot.keys[0].values).Count
  $hkcu.DeleteSubKeyTree($emptyKey, $false)
  $result.emptyKeyRestored = Restore-RegistrationSnapshot (($emptySnapshot | ConvertTo-Json -Depth 8) | ConvertFrom-Json) $copies
  $reopened = $hkcu.OpenSubKey($emptyKey)
  $result.emptyKeyBackWithoutValues = ($null -ne $reopened) -and ($reopened.ValueCount -eq 0)
  if ($reopened) { $reopened.Close() }

  $pending = Join-Path $Root 'pending\pending-restore.json'
  Set-PendingRestore 'F:\first\snapshot.json' $pending
  $result.pendingSnapshot = (Get-PendingRestore $pending).snapshot
  $result.secondPendingRefusal = Get-Message { Set-PendingRestore 'F:\second\snapshot.json' $pending }
  Clear-PendingRestore 'F:\second\snapshot.json' $pending
  $result.pendingKeptForOtherSnapshot = Test-Path -LiteralPath $pending
  Clear-PendingRestore 'F:\first\snapshot.json' $pending
  $result.pendingCleared = -not (Test-Path -LiteralPath $pending)
} finally {
  $hkcu.DeleteSubKeyTree($SubKeyRoot, $false)
}
$result | ConvertTo-Json -Compress
`;

describe.skipIf(!windows)('installer proof registration hand-back', () => {
  for (const variant of ['ordinary', 'short-path'] as const) {
    it(`restores the ${variant} registration exactly and refuses foreign writes`, (context) => {
      // The ordinary temp volume may disable 8.3 names. The Windows profile volume
      // is where CI's RUNNER~1 alias lives; exercise the same OS expansion there.
      const fixtureParent =
        variant === 'short-path' && process.env.LOCALAPPDATA
          ? path.join(process.env.LOCALAPPDATA, 'Temp')
          : os.tmpdir();
      const root = mkdtempSync(path.join(fixtureParent, 'installer-registration-'));
      const subKeyRoot = `Software\\Diomedes-installer-proof-test-${randomBytes(4).toString('hex')}`;
      try {
        const script = path.join(root, 'scenarios.ps1');
        writeFileSync(script, scenarios);
        const run = spawnSync(
          'pwsh',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
            '-Module',
            modulePath,
            '-SubKeyRoot',
            subKeyRoot,
            '-Root',
            root,
            ...(variant === 'short-path' ? ['-UseShortRoot'] : []),
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 110_000 },
        );
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1) ?? '{}');
        if (result.aliasAvailable === false)
          return context.skip('The Windows profile volume has 8.3 aliases disabled.');
        expect(result).toMatchObject({
          present: true,
          restoredFromFile: 'restored',
          valuesIdentical: true,
          valueOrderIdentical: true,
          linkIdentical: true,
          linkTimesIdentical: true,
          menuTimesIdentical: true,
          uninstallKeyAbsent: true,
          differencesAfterRestore: 0,
          restoredAgain: 'unchanged',
          restoredWhileInstalled: 'restored',
          valuesIdenticalWhileInstalled: true,
          restoredAfterExecutableRemoval: 'restored',
          resumedRestore: 'restored',
          resumedIdentical: true,
          foreignKeyKept: true,
          nothingWrittenOnRefusal: true,
          missingForeignShortcutKept: true,
          absentPresent: false,
          restoredToAbsent: 'restored',
          allAbsent: true,
          foreignFileKept: true,
          emptyKeyValues: 0,
          emptyKeyRestored: 'restored',
          emptyKeyBackWithoutValues: true,
          pendingSnapshot: 'F:\\first\\snapshot.json',
          pendingKeptForOtherSnapshot: true,
          pendingCleared: true,
        });
        expect(result.differencesAfterUninstall).toBeGreaterThan(0);
        expect(result.foreignKeyRefusal).toContain('changed by something other than this proof');
        expect(result.foreignShortcutRefusal).toContain(
          'Diomedes Experimental.lnk was changed by something other than this proof',
        );
        expect(result.missingForeignShortcutRefusal).toContain(
          'changed by something other than this proof',
        );
        expect(result.foreignFileRefusal).toContain(
          'someone-else.txt was changed by something other than this proof',
        );
        expect(result.subkeyRefusal).toContain('has subkeys');
        expect(result.secondPendingRefusal).not.toBe('no error');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
