import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UPDATE_ASSET_PATTERN } from '../shared/app-updates';

// The NSIS script scripts/build-windows-installer.mjs writes. It can only be compiled on
// Windows, so these checks read the generated text: what a person reads says Nectovia, and
// every name an upgrade or the app's data is found by keeps the Diomedes it had.
const installer = await import(
  new URL('../scripts/build-windows-installer.mjs', import.meta.url).href
);
const appUpdates = await import(new URL('../desktop/app-updates.mjs', import.meta.url).href);
const readText = (relative: string) =>
  fs.readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

const payload = {
  files: [
    { absolutePath: 'C:\\build\\app\\Diomedes.exe', relativePath: 'Diomedes.exe' },
    {
      absolutePath: 'C:\\build\\app\\resources\\app.asar',
      relativePath: path.join('resources', 'app.asar'),
    },
  ],
  directories: ['resources'],
};
const generate = (signed: boolean): string =>
  installer.generateNsis({ outputPath: 'C:\\out\\setup.exe', version: '0.1.11', payload, signed });
const unsigned = generate(false);
const lines = unsigned.split('\n');
const define = (name: string) =>
  lines.find((line) => line.startsWith(`!define ${name} `))?.slice(`!define ${name} `.length);
const section = (name: string) =>
  unsigned.slice(
    unsigned.indexOf(`Section "${name}"`),
    unsigned.indexOf('SectionEnd', unsigned.indexOf(`Section "${name}"`)),
  );

describe('the identifiers an upgrade finds the earlier install by', () => {
  it('keeps the product id, both registry keys, the marker and the install folder', () => {
    const product = 'Diomedes.Experimental.8c27d61a-1919-4b12-9df7-20260909e001';
    expect(define('PRODUCT_ID')).toBe(`"${product}"`);
    expect(define('PRODUCT_KEY')).toBe(`"Software\\Diomedes\\Experimental\\${product}"`);
    expect(define('UNINSTALL_KEY')).toBe(
      `"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}"`,
    );
    expect(define('MARKER')).toBe('".diomedes-experimental-20260909"');
    expect(unsigned).toContain(
      'InstallDir "$LOCALAPPDATA\\Programs\\Diomedes Experimental 20260909"',
    );
    expect(unsigned).toContain('InstallDirRegKey HKCU "${PRODUCT_KEY}" "InstallDir"');
  });

  it('agrees with what the app checks before it installs an update in place', () => {
    expect(define('MARKER')).toBe(`"${appUpdates.UPDATE_MARKER_NAME}"`);
    expect(define('PRODUCT_ID')).toBe(`"${appUpdates.UPDATE_MARKER_CONTENT}"`);
    expect(unsigned).toContain(
      `CreateShortcut "\${SHORTCUT}" "$INSTDIR\\app\\${appUpdates.UPDATE_EXECUTABLE_NAME}"`,
    );
  });

  it('keeps the executable, the uninstaller and the release asset names', async () => {
    expect(unsigned).toContain('WriteUninstaller "$INSTDIR\\Uninstall Diomedes Experimental.exe"');
    expect(unsigned).toContain(
      `"UninstallString" '"$INSTDIR\\Uninstall Diomedes Experimental.exe"'`,
    );
    expect(unsigned).toContain('"DisplayIcon" "$INSTDIR\\app\\Diomedes.exe"');
    const script = await readText('scripts/build-windows-installer.mjs');
    expect(script).toContain(
      "`Diomedes-Experimental-${manifest.version}-${signed ? 'setup' : 'unsigned-setup'}.exe`",
    );
    // The update channel only accepts that name (shared/app-updates.ts).
    expect(UPDATE_ASSET_PATTERN.test('Diomedes-Experimental-0.1.11-unsigned-setup.exe')).toBe(true);
  });
});

describe('what a person reads', () => {
  it('names the product Nectovia in the wizard, Installed apps and the Start Menu', () => {
    expect(define('PRODUCT_NAME')).toBe('"Nectovia Experimental 2026-09-09 (Unsigned)"');
    expect(generate(true)).toContain('!define PRODUCT_NAME "Nectovia Experimental 2026-09-09"');
    // The wizard's caption and pages are drawn from Name; Installed apps from DisplayName.
    expect(unsigned).toContain('Name "${PRODUCT_NAME}"');
    expect(unsigned).toContain('"DisplayName" "${PRODUCT_NAME}"');
    expect(unsigned).toContain('VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT_NAME}"');
    expect(define('SHORTCUT')).toBe(
      '"$SMPROGRAMS\\Nectovia Experimental 20260909\\Nectovia Experimental.lnk"',
    );
  });

  it('says Diomedes only in identifiers, the company and the copyright', () => {
    const allowed = [
      // The product id, its registry keys, and the entry older installs made (to remove it).
      /^!define (PRODUCT_ID|PRODUCT_KEY|UNINSTALL_KEY|LEGACY_SHORTCUT_DIR|LEGACY_SHORTCUT) /,
      // Where the icon is on the machine that builds the installer, which nobody sees.
      /^!define MUI_(UN)?ICON /,
      /^InstallDir "\$LOCALAPPDATA\\Programs\\Diomedes Experimental 20260909"$/,
      // The company, and the copyright holder.
      /^VIAddVersionKey \/LANG=1033 "CompanyName" "Diomedes"$/,
      /^VIAddVersionKey \/LANG=1033 "LegalCopyright" "Copyright \(C\) 2026 Diomedes contributors"$/,
      // File names: the executable and the uninstaller.
      /^(File|Delete) "[^"]*Diomedes\.exe"$/,
      /Uninstall Diomedes Experimental\.exe/,
      /"\$INSTDIR\\app\\Diomedes\.exe"$/,
    ];
    const named = lines
      .map((line) => line.trim())
      .filter((line) => /Diomedes/.test(line) && !line.startsWith(';'));
    expect(named.filter((line) => !allowed.some((pattern) => pattern.test(line)))).toEqual([]);
  });
});

describe('the Start Menu across the rename', () => {
  it('removes the entry an older install made before it adds the new one', () => {
    // The exact entry every installer before the rename created.
    expect(define('LEGACY_SHORTCUT')).toBe(
      '"$SMPROGRAMS\\Diomedes Experimental 20260909\\Diomedes Experimental.lnk"',
    );
    expect(define('LEGACY_SHORTCUT_DIR')).toBe('"$SMPROGRAMS\\Diomedes Experimental 20260909"');
    const install = section('Install Nectovia experimental app');
    const order = [
      'Delete "${LEGACY_SHORTCUT}"',
      'RMDir "${LEGACY_SHORTCUT_DIR}"',
      'CreateDirectory "${SHORTCUT_DIR}"',
      'CreateShortcut "${SHORTCUT}"',
    ].map((step) => install.indexOf(step));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('uninstalls both names, never recursively', () => {
    const uninstall = section('Uninstall');
    for (const step of [
      'Delete "${SHORTCUT}"',
      'RMDir "${SHORTCUT_DIR}"',
      'Delete "${LEGACY_SHORTCUT}"',
      'RMDir "${LEGACY_SHORTCUT_DIR}"',
    ])
      expect(uninstall).toContain(step);
    expect(unsigned).not.toMatch(/RMDir \/r/i);
  });

  it('keeps the installer proof in step with the names it installs', async () => {
    const proof = await readText('scripts/verify-windows-installer.ps1');
    const [, folder, shortcut] = /\\([^\\]+)\\([^\\]+)"$/.exec(define('SHORTCUT') ?? '') ?? [];
    const [, legacyFolder, legacyShortcut] =
      /\\([^\\]+)\\([^\\]+)"$/.exec(define('LEGACY_SHORTCUT') ?? '') ?? [];
    expect(proof).toContain(`'${folder}'`);
    expect(proof).toContain(`'${shortcut}'`);
    expect(proof).toContain(`'${legacyFolder}'`);
    expect(proof).toContain(`'${legacyShortcut}'`);
    expect(proof).toContain("-notlike 'Nectovia Experimental 2026-09-09*'");
    // The folder the older installs made is recorded and handed back like the rest.
    expect(proof).toContain('Restore-RegistrationSnapshot $legacyBefore $legacySnapshotDirectory');
    expect(await readText('scripts/restore-windows-installer-registration.ps1')).toContain(
      "Join-Path $directory 'legacy-start-menu'",
    );
  });
});
