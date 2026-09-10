# Application updates implementation and verification

Status: implemented in the local integration candidate. No release was published, no user installation was replaced, and no commit or push was made. Version remains 0.1.1; a publisher must later ship this code and a newer stable installer before downloaded copies can use the channel.

## User flow

Settings > App updates in the Console shows the current version. Check for updates is explicit, followed by Download and then Close and install. There is no background upgrade. Portable, development and non-Windows copies show their limitation and an official release link. Packaging alone does not assert installed ownership.

Close and install verifies the staged artifact again, blocks new mutations, arms a hidden helper, and closes the app through its existing graceful shutdown. The helper waits for that parent process to exit, rechecks the artifact, then opens the existing per-user Windows installer. Installer interaction remains explicit. The helper's Node-mode environment is removed before launch so it cannot leak into a subsequently launched app.

## Channel and integrity

The fixed channel is the latest stable release of `andrewgodowsky-aoa/diomedes` on GitHub. Its installer must be named `Diomedes-Experimental-X.Y.Z-unsigned-setup.exe`. The tag, filename, canonical version, exact official URL, asset size and selected asset digest must agree. Ambiguous entries, downgrades, prereleases, missing digests and unexpected fields fail closed. A missing release is distinct from being current or being offline.

The SHA-256 must come from the selected asset's exact `digest` field. Release-note prose is not an integrity record. Metadata is capped at 256 KiB; installers are bounded to 1-500 MiB. Download redirects are checked before every hop and limited to five; only the named HTTPS GitHub download hosts are accepted. See [GitHub's release-asset API](https://docs.github.com/en/rest/releases/assets) for the asset digest and size contract.

The host owns the release record. Check and download accept no body fields; install accepts exactly `{assetName, sha256}` as identifiers to re-verify. Client paths, URLs, commands, worker identities, task grants and authorization claims are rejected. Files are staged under app data using an exclusive create, with directory-junction, symlink, non-file and hardlink refusal. The backend and helper recheck size and digest before handoff/execution. A failed recheck clears both the actionable artifact and the visible available state.

## Desktop and concurrency contract

- Installed ownership requires the current NSIS product marker and `INSTALLDIR/app/Diomedes.exe` layout. Unknown ownership defaults to unsupported quick installation.
- The service's default installer transport is unavailable. Only the desktop supplies the process effect; missing packaged helpers are not hidden by a fallback import.
- An admitted update blocks new mutating HTTP requests and team work starts. An existing mutation response or queued/working/waiting project session defers admission. A mutation with a lost response remains conservative until restart because its effect is uncertain.
- Check/download/install admissions are coalesced or refused, with generation checks, exact request validation, final busy checks and a latch before the asynchronous handoff. Forged concurrent requests cannot reuse another client's accepted body.
- The readiness record must identify this helper PID, parent PID and exact artifact. After a successful acceptance, HTTP response completion or a disconnected client invokes graceful quit once. See [Electron's app lifecycle](https://www.electronjs.org/docs/latest/api/app).
- The helper waits at most 120 seconds. It never kills unrelated processes or blindly retries an installer. PID reuse can conservatively delay the helper until timeout; this is a bounded availability limit, not permission to install while a live PID remains.
- Failure and timeout results are retained in app data under `update-handoff`. A missing result is not installer-success evidence. The UI reports an accepted handoff, not a completed upgrade.

## Verification

The final source gate is 869 passing unit tests across 49 files, a passing TypeScript check and Vite build. The full browser suite passed 32 tests; fresh focused updater and packaged checks supplement that suite. Exact current command logs and artifact identities are indexed in `evidence/autonomy-workbench/verification-summary.json`.

`tests/app-updates.test.ts` covers versions, feed failures, digest/URL/size enforcement, staging aliases, generation changes, forged bodies, busy work, admission races, client disconnect and repeat requests. `tests/desktop-app-updates.test.ts` covers installed markers, readiness identity, helper bounds, process arguments, environment cleanup, tamper checks and quit behavior. These unit tests use injected network/process effects.

`scripts/app-updates-desktop-smoke.mjs` runs the actual candidate EXE with an isolated profile. It verifies portable ownership and no automatic check, then exercises the compiled backend and UI with synthetic release bytes and an injected install callback. Separately, the actual packaged Electron binary runs the actual ASAR helper: it acknowledges readiness, refuses installation while the parent remains alive, and refuses same-size tampering after an owned parent exits. No source server module substitutes for the compiled package. The evidence is `app-updates-desktop-proof.json` with screenshots and hashes.

This does not prove a real downloaded release or completed NSIS upgrade. No public update was published in this task. Existing historical installer/upgrade evidence remains historical; it is not relabeled as a run of this candidate. Publisher signing and automatic relaunch are not added here.

## Review reconciliation

GLM 5.3 Flash performed the final independent updater review through OpenCode Go. The parent reconciled its findings against source and fixed stale available-state display, disconnected-response handoff, readiness identity and work-start admission races; unreachable guards were removed. The parent also fixed the production spawn default, installed ownership default, strict release-note links, staging-directory aliases and helper environment leakage. The bounded PID-reuse availability limitation remains explicit. GLM inspected the older package; the fresh compiled-helper evidence above supersedes that older artifact observation.

## Files and publication boundary

Source: `shared/app-updates.ts`, `server/app-updates.ts`, `server/app.ts`, `desktop/app-updates.mjs`, `desktop/update-helper.mjs`, `desktop/main.mjs`, `client/AppUpdates.tsx`, `client/app-updates.css`, and the Console Settings entry. Packaging stages both helpers and permits their ASAR entries. No dependencies, native-runtime versions or hashes changed.

The local roadmap and proposed cloud delta include this separate user-requested feature. The two original workbench additions remain the run inspector and Board projection. Cloud reconciliation, an approved source commit, a versioned public release, and downloaded-release upgrade verification remain release-owner steps.
