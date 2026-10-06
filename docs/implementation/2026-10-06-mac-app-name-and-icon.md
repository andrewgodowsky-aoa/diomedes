# The Mac app named and drawn as Nectovia, 2026-10-06

Andrew ran the 0.2.3 Apple silicon image on the MacBook Air and found that the app "says Diomedes
and has an old symbol": macOS named it Diomedes in Finder, the Dock and the menu bar, and the package
set no icon, so the bundle showed Electron's. He asked for Nectovia and the N the website uses.
Windows has had both since 2026-09-24.

## Change

- `scripts/app-icon.mjs` also draws `desktop/nectovia.icns`. It is the drawing `desktop/diomedes.ico`
  holds (the site's favicon tile, `NectoviaMark.tsx`'s plates and seams, the favicon palette and the
  seam rule of the site's icon rasters) placed on Apple's macOS icon grid: an 824 px rounded square
  with a 185.4 px corner in a 100 px margin of 1024 px. Each pixel size from 16 to 1024 is drawn at
  its own size, and the file carries them as PNG in the ten standard .icns slots; `iconutil` reads it
  back. The Windows icon the script writes is unchanged, byte for byte.
- `scripts/package-desktop.mjs` packages macOS as Nectovia.app with that icon: the bundle, its
  executable and helpers, CFBundleName and CFBundleDisplayName say Nectovia. The bundle id stays
  com.electron.diomedes and the staged package.json keeps productName Diomedes, so Electron's app
  name, the data folder (~/Library/Application Support/Diomedes) and the Keychain item (Diomedes Safe
  Storage) stay the ones existing installs have, as the 2026-09-22 rename requires of identifiers.
- `desktop/app-updates.mjs`: the macOS app menu reads About Nectovia, Hide Nectovia and Quit
  Nectovia. Electron would name those after its app name.
- `scripts/release-support/build-mac-release.mjs` and the release workflow's macos job sign, stage
  and smoke Nectovia.app. The disk image keeps its file name,
  Diomedes-Experimental-<version>-mac-arm64.dmg, which the update check and
  `write-release-assets.mjs` look for.
- The release README tells a Mac to drag Nectovia.app and to move an earlier Diomedes.app to the
  Trash.
- `docs/MAC_DEVELOPMENT_HANDOFF.md` records the bundle name and the Keychain prompt that a Mac which
  has run an earlier build meets in the launch smoke. `docs/product/2026-09-22-nectovia-skin.md`
  records its open decisions 1 and 2 as decided.

Unchanged: the bundle id, Electron's app name, the data and projects folders, the Keychain item,
the diomedes-auth scheme, the disk image, installer and release names, and Mark.tsx (the skin's
open decision 5).

## Tests

- `tests/app-icon.test.ts`: the committed .icns equals the drawing at every size, the grid's
  geometry holds, and the packager names both icon files.
- `tests/desktop-packaging.test.ts` and `tests/fd01-independent-review.test.ts`: the darwin package
  is Nectovia with bundle id com.electron.diomedes and carries `desktop/nectovia.icns`. The
  independent FD01 test asserted that the darwin package had no icon, which kept the Windows .ico off
  the Mac; it now asserts the Mac's own file.
- `tests/name-contract.test.ts`: the allowance for the macOS menu's "Diomedes" is gone, and the Mac
  bundle's name and id are held beside the Windows executable's.
- `tests/desktop-shell-menu.test.ts` and `tests/mac-release-build.test.ts`: the new labels and path.

## Verification on the MacBook Air (Apple M2, macOS 27.0.1)

- `npm run package:mac` built `release/Nectovia-darwin-arm64/Nectovia.app`: CFBundleName,
  CFBundleDisplayName and CFBundleExecutable Nectovia, CFBundleIdentifier com.electron.diomedes, the
  diomedes-auth scheme, an icon identical to `desktop/nectovia.icns`, helpers named Nectovia Helper,
  and productName Diomedes in the app's package.json. The ad-hoc signature verifies.
- Opened on a fresh profile, the window title is Nectovia, the app menu reads Nectovia (About
  Nectovia, Services, Hide Nectovia, Hide Others, Show All, Quit Nectovia), and Electron's app name
  is Diomedes.
- `scripts/packaged-launch-smoke.mjs` on that build passed its six checks.
- A new build's signature is new to the Keychain item, so macOS asked once whether Nectovia may use
  Diomedes Safe Storage, and Andrew chose Always Allow.

## Gates (2026-10-06, on this patch, MacBook Air)

- `npx tsc --noEmit`: passed.
- `npx vitest run` (two workers): 588 files passed, 4 skipped; 9,959 tests passed, 43 skipped.
- `npx vite build`: passed.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`: 36 passed
  (17 ui, 11 native-ui, 8 field).

This record was written after the run. No test reads `docs/implementation`.
