# Installer proof on a machine that has a real installation

September 13, 2026. `scripts/verify-windows-installer.ps1` is the install, launch, repair and
uninstall proof every release candidate runs. It refused to start while the product's
registration existed, and since 04:06 EDT today this PC has a real per-user installation at
`%LOCALAPPDATA%\Programs\Diomedes Experimental 20260909`, with its Start Menu shortcut and a
taskbar pin. This record says how the proof now runs beside that installation without leaving
it changed, and what has and has not been proven.

## 1. Why the proof refused

The installer built by `scripts/build-windows-installer.mjs` registers at fixed places, whichever
folder it installs to: `HKCU\Software\Diomedes\Experimental\<product id>`,
`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<product id>`, and the Start Menu
folder `Diomedes Experimental 20260909`. Its uninstaller deletes all three, again whichever
folder it runs from. A proof that installs into `test-results` and then uninstalls would
therefore take over a real installation's registration and then delete it. Refusing was the safe
answer until the registration could be handed back.

The product id, ownership marker, Start Menu folder name and version are unchanged
(`QUESTIONS.md` O7). The installer builder is not touched.

## 2. What the proof does now

- **Records before it writes.** Before the first install it reads both keys (every value's
  name, kind and data, strings stored as base64 so no JSON reader can reinterpret them), every
  file in the Start Menu folder (bytes, SHA-256, attributes, creation and last-write times) and
  the folder's own times. The record goes to the per-user folder
  `%LOCALAPPDATA%\Diomedes Installer Proof\`, not the proof folder, so deleting a proof's folder
  or its whole worktree cannot lose it. A copy goes to `<proof root>\registration-before\` as
  evidence. A registration it could not reproduce exactly (subkeys, a value kind outside string,
  expand-string, multi-string, binary, DWORD and QWORD, or a subfolder) stops the proof before
  anything is written.
- **Proves the install wrote the registration.** Once a registration exists beforehand, a key
  merely existing proves nothing. After install and again after repair, the proof requires
  `InstallDir`, `ProductId`, `InstallLocation`, `UninstallString`, `DisplayIcon`, `NoModify`,
  `NoRepair` and the shortcut's target to name this installation, and `DisplayName` to be the
  product's. This also tightens the proof on a clean machine.
- **Hands the registration back.** After the uninstall's existing checks (keys, shortcut, marker
  and payload gone; unowned file and profile kept), a `finally` block restores the recorded
  registration and reads it back. It runs on success, failure and Ctrl+C.
  `proof.json` records `preExistingRegistration`, `registrationRestore` and any hand-back error.
- **Replaces only its own work.** The restore (`scripts/windows-installer-registration.psm1`)
  overwrites or removes a key only if it is absent, already matches, names the proof's install
  target, or holds nothing but snapshot values. It touches a Start Menu file only if it is a
  shortcut to the proof's executable or already carries the snapshot's bytes. The last case in
  each lets a restore that was stopped halfway be run again. Anything else means something other
  than the proof changed the registration: the restore refuses before writing and says what
  differed.
- **Checks what it never writes.** It lists the existing installation's files and hashes every
  taskbar pin before and after. A change to the installation, or to any pin that mentions
  Diomedes, fails the proof. Other pin changes are recorded.
- **Survives being killed.** Before the first install it writes
  `%LOCALAPPDATA%\Diomedes Installer Proof\pending-restore.json` beside the snapshot, and removes
  both only after the restore reads back equal. While the record exists, every proof refuses to
  start. `scripts/restore-windows-installer-registration.ps1` hands the registration back from
  it, under the same ownership rule.

After an interrupted proof, run the restore script first, and delete the proof's folder only
afterwards. Never clean up by running the interrupted proof's own
`Uninstall Diomedes Experimental.exe`: it deletes the fixed keys, including a real
installation's.

Between install and hand-back (about 30 seconds in run B below), the registration and the Start
Menu shortcut name the proof's installation. The taskbar pin is a separate file and is not
written. Nothing under `desktop/` reads the registry, so a running copy of the app should not
notice; no copy was running during the runs below, so that part is read from the code, not
measured.

## 3. Verification

| Check | Result |
|---|---|
| `tsc --noEmit` in the worktree | clean |
| `vitest run tests/windows-installer-registration.test.ts`, against a scratch HKCU key and a temporary folder, never the product's | 1 passed. The scenarios are listed below the table. |
| Full `vitest run` with the JSON reporter | 98 files: 1664 passed, 1 skipped, 0 failed |
| Independent read-only review of the three scripts by an Opus code-review subagent | 7 findings; see "Review findings" below |

The module test covers:

- restore from the saved JSON after an install and uninstall
- exact values of every kind in their original order: a date-shaped multi-string, a DWORD of -1, a QWORD, binary and the default value
- a byte-identical shortcut, with its creation and last-write times and the folder's times
- restore while the install still holds the keys, and restore to absent
- resuming a restore stopped after its first value and the shortcut's bytes
- a key with no values
- refusal, with nothing written, for a foreign key value, a foreign shortcut and a foreign file
- refusal of a key with subkeys
- the pending-record lifecycle

**Review findings.** Five were fixed:

- The only snapshot copy sat in the proof folder that the recovery comment said to delete. It now lives per user, and the comment gives the right order.
- A restore that stopped halfway could not be resumed.
- Module functions could step past errors when the script ran with `&`.
- When the proof and its hand-back both failed, the proof's own message was dropped.
- Creation times were not restored.

Two were left as they are:

- The claim that a key with no values restores wrongly did not hold. It was measured, and the case is now in the test.
- No `proof.json` is written when the proof refuses before writing anything. That matches the proof before this change.

**Proof runs.** Andrew approved both runs against his real registration in this session.

- **Installer:** `F:\Diomedes\deliverables\windows-release-20260912-4fb8656\Diomedes-Experimental-0.1.1-unsigned-setup.exe`, SHA-256 `d9eccbd5…0e369d`, the published v0.1.1-experimental.3 bytes.
- **Payload:** the 76 files of `release-20260912-4fb8656\release\Diomedes-win32-x64`.
- **Scripts:** this worktree's, after the review fixes.
- **Witness:** each run was bracketed by an independent read-only witness taken outside the proof: `reg.exe` exports of both keys; SHA-256 of the Start Menu shortcut, the taskbar pin and four installation files; a listing of all 78 installation files; and the Explorer Taskband pin blobs.

| Run | What it did | Result | Evidence |
|---|---|---|---|
| B, normal | Install; installed-runtime smoke (11 checks, 4 launches, owned crash); repair; uninstall; hand-back | Passed in 32 s. `registrationRestore: restored`. Registration, shortcut, pin, installation files and Taskband blobs identical before and after | `evidence/installer-proof-existing-install/run-b-*.json` |
| C, failure path | Same installer with a deliberately wrong payload, so the proof throws once the install has taken over the registration | Exit 1 with `Installed payload differs: Diomedes.exe`. `registrationRestore: restored`, `afterFailure: true`. Identical before and after | `evidence/installer-proof-existing-install/run-c-*.json` |

Run C's orphaned installation folder was then deleted without running its uninstaller, after
checking that nothing in the registration or Start Menu named it. The final witness, taken after
both runs and that cleanup, is identical to the baseline taken at 04:42 EDT before any change.
No pending-restore record remains.

Vite build and Playwright were not run: this patch changes no application code. AGENTS.md still
requires both before a merge.

## 4. What this does not claim

- A candidate built from a commit without this change still refuses on this PC.
- A proof killed while the installer itself is writing the keys can leave a key that is partly
  the proof's and partly the original. The restore refuses that rather than guess, and a person
  has to look.
- Recovery with the restore script after a killed proof is covered by the module test. It was
  not exercised by killing a real run.
- The runs used the 0.1.1 installer beside a 0.1.1 installation, on this PC only.
