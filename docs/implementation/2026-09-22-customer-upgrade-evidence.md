# Published 0.1.6 to 0.1.7 customer upgrade proof

Work order: RELEASE-017.CUSTOMER-UPGRADE (owner-requested evidence follow-up; no numbered prompt completion).
Owner: Codex, current task. Branch: `feature/customer-upgrade-evidence`.
Worktree: `F:/Diomedes/diomedes-wt/customer-upgrade-evidence`.
Base: `c10b7b2fa3ba12e9bba9373ac3ff82db8447b820`, fetched `origin/main`.
Canonical mirrors read: Pillars 2026-09-19.1; Roadmap and Project Memory 2026-09-19.2.

Scope: install published 0.1.6 into an isolated owned directory, use its actual public updater and installer, launch 0.1.7 and verify local state across another restart. Synthetic data only, no credentials, no provider calls or paid activity. Preserve the existing Windows installation and restore its shared registration and shortcut. Only evidence and this document may be committed, and only if proof passes.

**Verdict: PASS for the published Windows 0.1.6 -> 0.1.7 upgrade path in an isolated installation.**

The accepted run is `run-06`, on Windows 11 x64 build 26200, from
2026-09-23 02:42:08Z to 02:44:25Z (September 22, 10:42-10:44 PM EDT).
The installed app performed the real public release check, download and native installer
handoff. The native wizard upgraded the same installation, and the upgraded app launched,
reported itself current, and retained the witnessed state through a second launch.

Evidence root: [`evidence/customer-upgrade-0.1.7`](../../evidence/customer-upgrade-0.1.7/).
The offline verifier rechecks the artifact identities, handoff, preservation comparisons,
restoration results, driver hashes and retained failed attempts:

```powershell
node evidence/customer-upgrade-0.1.7/verify-evidence.mjs
```

## Published bytes and observed path

| Artifact | Exact identity |
| --- | --- |
| Starting installer | `Diomedes-Experimental-0.1.6-unsigned-setup.exe`, 266,387,557 bytes |
| Starting installer SHA-256 | `b63007a600872316949bf8cdc2b2cf757a7d75c0fd728b2da2c13486f30a351d` |
| Upgrade installer | `Diomedes-Experimental-0.1.7-unsigned-setup.exe`, 266,655,455 bytes |
| Upgrade installer SHA-256 | `ae024d7912957323d23012c3ee88299f2554d074362de3d07a3cf2d815790fbe` |
| Published 0.1.7 source | `6e2f033b4778d88ff544d11874f3c1aedb2051f7` |
| Upgraded executable SHA-256 | `df6e7afddf718aa86a7f6b0b40758ae0eebd5cdc5ef80c6dd926ad7905f9ac2a` |
| Upgraded app.asar SHA-256 | `46a60af5d91ce23637a4e6794fea04d9e97d5dfb896a9d70a7818ba5fa99f6e7` |

The starting installer was downloaded anonymously from the
[published 0.1.6 release](https://github.com/andrewgodowsky-aoa/diomedes/releases/tag/v0.1.6),
hash checked and installed with `/S /D=<isolated installation>`; exit code was 0.
Its registry version, ownership marker, installed executable path and running API version
were checked. Two actual 0.1.6 launches established persistent starting state.

In that installed 0.1.6 app, Settings > App updates > Check for updates discovered
[published 0.1.7](https://github.com/andrewgodowsky-aoa/diomedes/releases/tag/v0.1.7).
Download fetched the real public installer into that app's own data/updates folder.
The app reported size/origin/published-digest verification, and the driver independently
hashed the staged file against the downloaded release manifest. No release feed,
download transport, install transport or packaged application was replaced or mocked.

The UI's Close and install action submitted the exact asset name and digest. The actual
Electron main-process PID, read inside the app, exited and its loopback service closed.
The unmodified helper recorded `launched` with that same parent PID and artifact digest.
The renderer's HTTP response was not captured; acceptance is proven by that bound helper
record, process exit and the observed installer, not by an asserted HTTP 200.

Computer Use observed the wizard selecting
`F:/Diomedes/diomedes-wt/customer-upgrade-evidence/test-results/customer-upgrade-0.1.7/run-06/installation/`
without changing its destination. It clicked Install, observed "Setup was completed
successfully", and closed Finish. The wizard does not automatically launch the app.
Its exit code was not captured; the native completion text, final registered version
0.1.7 and subsequent installed-runtime checks supply the completion evidence.
The final Finish refresh returned `foreground window did not report a process id` as
the window closed; fresh window enumeration confirmed closure before continuing.

See [runtime proof](../../evidence/customer-upgrade-0.1.7/run-06/runtime-proof.json),
[installer/restoration proof](../../evidence/customer-upgrade-0.1.7/run-06/installer-proof.json),
[native observations](../../evidence/customer-upgrade-0.1.7/run-06/native-observations.json)
and the eight screenshots alongside them.

## Local state and isolation

The same executable path then launched 0.1.7 twice. Both launches matched the published
EXE and ASAR hashes. The first opened the preserved project and checked the public
channel again, which reported `current`. All four test launch services were closed
afterward; no renderer errors were recorded.

The three saved snapshots (`state-before.json`, `state-after.json`,
`state-restarted.json`) compare equal, including:

- The synthetic Harbor Street project and its two imported tasks.
- Both durable History entries, including their original identities and attribution.
- Detail, surface, open projects, last-page, onboarding, appearance and permissions.
- All four project files by relative path, byte count and SHA-256, including the
  deliberately added customer-owned sentinel.
- The complete returned project state. Needs, sessions, changes, conversations and
  team runs were empty in this fixture; this run does not prove their nonempty migration.

The test used new profile/data/projects directories, an empty native-runtime home,
and an allowlisted child environment with no AWS/API credentials. It enabled no
test-mode transport and sent no conversation or provider request. No account files
were copied and no paid activity was initiated. The updater's inherited isolated
APPDATA caused its new Start Menu shortcut to be written inside the synthetic home;
the registered install destination still remained the original isolated installation.

The production installation stayed outside the proof. Before each attempt, the
existing two HKCU keys and Start Menu shortcut were snapshotted with the repository's
resumable registration helper. After `run-06`, registration read back identical,
all 78 real-install files retained their bytes, sizes and modification times, taskbar
pin hashes/targets and Taskband value hashes were equal, and no pending restore remained.
The real app was not stopped. Andrew's separate manual reinstall during the session
is not counted as proof: `run-06` established a new before/after witness after it finished.

## Retained failures and final validation

Attempts `run-01` through `run-05` remain explicitly failed in `attempts/`; none is
reported as a successful upgrade proof. Each restored the registration it found.

| Attempt | Exact stopping condition | Disposition |
| --- | --- | --- |
| 01 | Expected the new Diomedes landing landmark in 0.1.6 | The older version reopened the project; corrected the driver assertion. The original-install file witness was empty because registry keys were absent, so subsequent runs also resolved the existing shortcut target. |
| 02 | `(intermediate value).find is not a function` | Used the documented `/projects` response's `projects` array. |
| 03 | Playwright `close` event timed out after 45 seconds | Retained the unhandled driver failure and helper receipt; replaced the event oracle with actual runtime PID/service exit and helper evidence. |
| 04 | `ENOENT` reading update-handoff before it was created | Retry only this expected missing-directory state while polling. |
| 05 | Expected launcher PID 28416; helper correctly named runtime PID 37768 | Read `process.pid` inside Electron and retain both PIDs. Native installation completed, but this attempt did not verify the upgraded runtime and remains failed. User input advanced part of this attempt's wizard. |
| 06 | All five runtime checks and restoration checks passed | Accepted end-to-end run; no application code changed. |

The first focused unit invocation collected 23 passing assertions but failed one
suite because the older dependency junction lacked `@ai-sdk/openai`. The first
typecheck lacked the control-plane `pg` and Neon dependencies. Those results are
retained in `validation/`. Reused the existing `core-agent-release` dependency trees
after matching both root and control-plane lockfile SHA-256 values; installed no packages
and changed no lockfiles. The final checks on this evidence worktree were:

| Check | Fresh result |
| --- | --- |
| `tsc --noEmit` | Exit 0 |
| `vitest run` | 252 files; 4,682 passed, 0 failed, 4 skipped; exit 0 |
| `vite build` | Exit 0; existing large-chunk warning |
| Required `ui.spec.ts`, `native-ui.spec.ts`, `field.spec.ts` | 36 passed, 0 failed; headless; exit 0 |
| Offline evidence validation | PASS; rechecks all three equal state snapshots and all 78 original-install file witnesses |

Commands, console logs, summaries and source-report SHA-256 values are in
[`validation/`](../../evidence/customer-upgrade-0.1.7/validation/).
Browser tests regenerated four existing screenshots; their exact pre-test bytes were
restored. Only this document and the new evidence directory belong to this patch.

## Reproduction and acceptance boundary

Ask for immediate screen-use permission first. No answer is not permission. The owner
explicitly allowed this run after his app reloaded; screen readiness was observed before
the visible proof started. The runner now requires `-ScreenUseApproved` and its child
requires `--screen-use-approved`. These flags record an operator precondition, not consent
inferred from a command. Complete the native wizard with current observations, then
record its real destination/completion in `native-installer-completed.json` as in `run-06`.

```powershell
./evidence/customer-upgrade-0.1.7/run-proof.ps1 `
  -RunRoot F:/Diomedes/diomedes-wt/customer-upgrade-evidence/test-results/customer-upgrade-0.1.7/NEW-RUN `
  -ScreenUseApproved
```

The runner expects the exact 0.1.6 installer in
`test-results/customer-upgrade-0.1.7/downloads/`. If interrupted, use the existing
`scripts/restore-windows-installer-registration.ps1` before another proof. Do not run
an isolated copy's fixed-identity uninstaller after registration has been handed back.
The isolated installations and raw test reports remain under ignored `test-results/`.

This closes the requested **isolated older-installed-build/public-updater/installer/local-state**
evidence gap. It does not certify a clean Windows account, other Windows versions,
every older release, real customer data, nonempty pending work, stored provider credentials,
live AWS/provider behavior, signing, or a Mac release. Those existing limits remain open.
The published release assets, site and historical release reviews were not changed.
No roadmap definition or numbered prompt was marked DONE. No new application build
was published or deployed; this patch records evidence for the existing 0.1.7 bytes.
