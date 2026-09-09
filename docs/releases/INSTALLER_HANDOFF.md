# Experimental Windows installer handoff

**Roadmap basis:** initial repository `.5`; final local reconciliation `.7` over cloud `.6`.  
**Product identifier:** `Diomedes.Experimental.8c27d61a-1919-4b12-9df7-20260909e001`  
**Status:** real 0.1.1 payload built, installed into disposable directories, exercised, repaired and uninstalled. Final evidence: `test-results/installer-final-3/proof.json` and `docs/releases/VERIFICATION.md`.

## Build after the desktop package exists

Run from `F:\Achilles\diomedes-wt\windows-release`:

```powershell
node scripts/build-windows-installer.mjs `
  --app-dir "F:\Achilles\diomedes-wt\windows-release\release\Diomedes-win32-x64" `
  --out-dir "F:\Achilles\deliverables\windows-release-20260909"
```

The defaults point to those same locations, so this is equivalent:

```powershell
node scripts/build-windows-installer.mjs
```

Verified script-owned outputs for package version `0.1.1`:

- `F:\Achilles\deliverables\windows-release-20260909\Diomedes-Experimental-0.1.1-unsigned-setup.exe`
- the adjacent `.exe.json` manifest containing installer SHA-256, payload tree SHA-256, byte and file counts, compiler provenance, and the explicit `NotSigned` result

The script refuses to overwrite an existing installer unless its adjacent JSON manifest names `scripts/build-windows-installer.mjs` as owner and points to that exact output path. Pass `--no-download` to require the already cached compiler. `--help` lists path overrides.

## Installer behavior

The generated NSIS installer is deliberately isolated from a future production identity:

- Its display name contains `Experimental` and `Unsigned`, and its product/registry identifier is unique to this September 9 build lane.
- It requests normal-user execution, defaults to `%LOCALAPPDATA%\Programs\Diomedes Experimental 20260909`, writes only HKCU registration, and creates only a current-user Start Menu shortcut.
- Standard NSIS `/D=fully-qualified-path` selection works, including for an isolated test location. The installer refuses a nonempty target unless the target carries this exact experimental product marker.
- It does not start Diomedes, stop processes, replace another install, copy credentials, or touch an existing Diomedes profile.
- Uninstall first verifies the exact ownership marker. It deletes the files enumerated from the packaged app at build time, the experimental shortcut, its two exact HKCU registry keys, its marker, and its uninstaller. Directory removal uses only non-recursive `RMDir`, so unknown files and nonempty directories remain. It never recursively removes the selected install root.
- User data outside the install directory, including Electron profile data under the user's application-data folders, is not read or removed. Unknown files placed inside the install directory are also left behind.

The builder rejects symlinks in the packaged payload, requires `Diomedes.exe`, compiles with NSIS warnings treated as errors, and directly checks the PE certificate table to ensure the result remains unsigned.

## Tool provenance and license

The builder uses the official portable `nsis-3.12.zip` from the [NSIS SourceForge release directory](https://sourceforge.net/projects/nsis/files/NSIS%203/3.12/). It pins SHA-256 `56581f90db321581c5381193d796fffcf2d24b2f8fed2160a6c6a3baa67f2c4f` and checks that `makensis /VERSION` returns `v3.12`. The local acquisition record is `evidence/windows-release/installer-tool-download.json`.

No NSIS system installer, account, paid service, package dependency, signing service, or provider agreement is involved. First use downloads through the Windows `curl.exe` client and extracts with PowerShell `Expand-Archive`; both are invoked directly without changing system configuration. The portable compiler stays in ignored `test-results/installer-tools`. The generated script selects zlib compression. NSIS's [official license appendix](https://nsis.sourceforge.io/Docs/AppendixI.html) places its ordinary source/UI components and zlib compression module under the zlib/libpng license; the downloaded compiler bundle also carries the documented bzip2 and CPL/LZMA terms even though this installer does not select those compressors. Application and bundled-runtime licenses remain the responsibility of the desktop package and its shipped `licenses` directory.

## Verification and remaining risks

Verified locally on September 9, 2026:

- `node --check scripts/build-windows-installer.mjs` passed.
- A fresh empty tool cache downloaded the official portable archive, matched the pinned SHA-256, extracted it, and verified `makensis /VERSION` as `v3.12`.
- NSIS `v3.12` compiled a two-file isolated mock package with `/WX`; compilation completed with no warnings.
- The mock output manifest recorded `Authenticode: NotSigned`, an installer SHA-256, and exact uninstall entries with no `RMDir /r`.
- The final real installer and uninstaller were executed only against new disposable targets. All 76 payload files matched the package, the installed app passed 11 business/crash/recovery scenarios, same-version repair preserved unknown files/profile data, and uninstall removed the exact payload, registration and shortcut while preserving those data. No live install/profile was replaced.

The final installer is 266271601 bytes, SHA-256
`e487e62f50a6aabb7ecc0244d1c0ce997420a8c1a48eb0e87bb1770d1622f07f`,
Authenticode `NotSigned`. Its payload is 709153483 bytes across 76 files. A separate
actual 0.1.0-to-0.1.1 application profile upgrade passed using the ZIP-extracted app.
This proves the named version transition and same-version installer repair, not
every historic migration. The first PowerShell verification assertion failed due
to concatenated registry paths; its own test install was uninstalled and fresh
passing runs retained. No app code or security check was weakened.

Unsigned executables show an unknown publisher and may trigger Windows SmartScreen or antivirus reputation warnings. The artifact remains experimental and unpublished. Signing and public upload have not been authorized; the isolated install/uninstall proof is complete.

The installer isolates program files and performs no launch. It does not change the Electron app's runtime profile policy: if the packaged app still uses Electron's default `Diomedes` user-data location, manually launching the experimental executable may open the same profile as another Diomedes build. Confirm or override that behavior in an explicitly isolated runtime test before launching it around valuable user data.

## ROADMAP IMPACT

- Windows installer build path: **implemented locally, experimental and unsigned**.
- Real packaged installer: **built and hashed**.
- Installation/runtime/repair/uninstall proof: **verified in disposable directories**.
- Publication, deployment, signing, and release: **unchanged; not authorized**.

**BUILD STATUS:** real 0.1.1 payload and installer verified.  
**PUBLICATION STATUS:** not published.  
**DEPLOYMENT STATUS:** disposable installation tested and uninstalled; no live installation or deployment.
