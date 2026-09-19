# Independent witness, v0.1.4 installer proof

`scripts/verify-windows-installer.ps1` takes over the two fixed current-user registry keys and the
fixed Start Menu folder for the length of the run, 76 seconds here, then hands the existing
registration back in a `finally` block. On this machine that registration belongs to a real per-user installation of
Diomedes Experimental 2026-09-09 at `%LOCALAPPDATA%\Programs\Diomedes Experimental 20260909`, so
the hand-back is the part that matters most and the part the proof cannot honestly grade itself on:
the proof writes the snapshot, restores from it, and reports its own success.

This folder is the outside check. `installer-witness.ps1` reads, and only reads, everything the
proof promises to leave alone:

- both registry keys, every value, its kind and its data, with binary data base64 encoded
- every file in the real installation folder, with size and SHA-256
- every file in the Start Menu folder, with size, SHA-256 and timestamps
- every taskbar pin, with size and SHA-256
- the `Taskband` key, including the `FavoritesResolve` and `Favorites` blobs

It was run once immediately before the proof and once immediately after, into `witness-before.json`
and `witness-after.json`. Neither run writes anything.

## Result

`witness-comparison.json`: 304 leaf values compared, 0 differences. The registration the proof found
and handed back is identical to the one that was there before it started, down to each value's kind
and data. The real installation's 78 files, the Start Menu shortcut and all 10 taskbar pins are
byte-for-byte unchanged.

## Why a plain diff of the two files is not the check

`installer-witness.ps1` builds each per-value record as an unordered PowerShell hashtable, so
`ConvertTo-Json` may emit `kind` before `data` in one run and after it in the next. A textual diff
of the two witness files therefore shows roughly 250 changed lines that are pure key reordering,
which would bury a real difference rather than reveal one. `compare-witness.ps1` parses both files
and compares leaf values by path, so key order cannot produce a false difference and a real one
cannot hide in the noise. `takenAt` is excluded because it is the one field that is meant to differ.

Anyone re-checking this should run `compare-witness.ps1`, not `diff`.

## Run record

| | |
| --- | --- |
| Installer | `Diomedes-Experimental-0.1.4-unsigned-setup.exe` |
| Installer SHA-256 | `c1a1015d8164da244afcc9ceee02a0a9e7c0c72438e008c2ac24277e1090886e` |
| Proof started | 2026-09-19T06:36:23Z |
| Witness before | 2026-09-19T06:36:11Z |
| Witness after | 2026-09-19T06:38:08Z |
| Proof finished | 2026-09-19T06:37:39Z |
| `registrationRestore` | `restored`, `afterFailure: false` |

The proof's own record is
`evidence/release-candidates/diomedes-0.1.4-windows-experimental-20260919-efa83acd021c-installer-proof.json`,
and the installed runtime's record is the `-installer-proof-runtime.json` beside it.

The procedure and its hazards are documented in
`docs/implementation/2026-09-13-installer-proof-existing-install.md`. The one that matters: never
clean up after an interrupted proof by running the proof installation's own
`Uninstall Diomedes Experimental.exe`. It deletes the fixed keys, which are a real installation's
keys. Run `scripts/restore-windows-installer-registration.ps1` first and delete the proof folder
directly.
