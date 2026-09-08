# Main Windows build integration

Date: 2026-09-08.

The main Windows executable now includes both the earlier durable Work foundation
and the latest exact approval receipts, expiry, retry/restart recovery and
Workbook/Console decision controls. The latest isolated approval build contained
both slices; the main executable was older before this integration.

The current main executable is:

`F:\Achilles\diomedes\release\Diomedes-win32-x64\Diomedes.exe`

The existing `C:\Users\andre\OneDrive\Desktop\Diomedes.lnk` was read and verified
to target that executable and its release directory. The shortcut needed no change.
Keep the whole release folder together.

## Source and scope

- Main: `F:\Achilles\diomedes`, branch `main`, HEAD
  `218f325d2a902c53b089045dd24496890063a702`.
- Source: `F:\Achilles\diomedes-wt\codex-approvals`, same committed base plus the
  reviewed Work foundation and approval changes. Its source and package hashes were
  checked against the existing verification manifest before integration.
- The combined 46-file patch passed an apply check and was applied to main. All
  imported file bytes were checked against the reviewed copy before building.
- Main's pre-existing `scripts/package-desktop.mjs` cleanup edit was preserved
  byte-for-byte. Its SHA-256 remains
  `f65fb79e0c18cd1c4b1dd2b230d8da42c10752c8a9034297add9994e840d0671`.
- No files, builds or branches in Fable's `fable-harness` or other separate
  worktrees were modified. No agent or additional model generation was dispatched.
- Verification covered working-tree integration and a rebuilt local release.
  The owner subsequently authorized committing this integration. No push or
  public deployment was made. Live user data was not migrated.

The previous main release and affected source files are backed up under
`output/main-integration-20260908-084506/`. `release-before/` contains the previous
complete release; `source-before/` and `before.json` capture the prior affected
files and hashes. These backups are ignored build artifacts, not active releases.

This record supersedes the earlier reports' isolated-only delivery status. Their
technical scope and open M1 limitations remain unchanged.

## Fresh verification on main

| Check | Result |
| --- | --- |
| `npm.cmd run build` | PASS: TypeScript, production client and Electron 44.2.0 Windows package. |
| Full deterministic suite | PASS: 361 tests across 14 files, 72.44 seconds. |
| Built production browser suite | PASS: 19 tests, 26.1 seconds, separate synthetic data and port 47746. |
| `node scripts/desktop-smoke.mjs` | PASS: actual main executable, Workbook/Console recovery, renderer isolation, font scaling, shutdown and restart. |
| Main packaged approval replay | PASS: cloned only the prior synthetic native smoke's data/project into a new test profile. The exact receipt loaded and replayed unchanged, with no new session, History entry or model call. Restored file bytes remained unchanged. Console displayed the Decision record and the app released its data lock on close. |
| Source and artifact parity | PASS: 67 source/config/test files match the reviewed isolated source; 24 differ only in checkout line endings. The additional packaging script matches the preserved main edit. The main client bundle is byte-identical to the reviewed isolated client; packaged client, freshly bundled main service and desktop entry match their current sources. All three native runtime binaries match the isolated package. |

Logs and the replay/check scripts are under
`output/main-integration-20260908-084506/`. Durable evidence is in
[`main-integration-verification.json`](../../evidence/main-integration-verification.json),
[`main-approval-replay-proof.json`](../../evidence/main-approval-replay-proof.json)
and the refreshed [`desktop-proof.json`](../../evidence/desktop-proof.json).
The primary agent inspected the actual main package's Console screenshot at
`evidence/screenshots/main-approval-replay.png`.

The application code is the same reviewed implementation. The new main `app.asar`
is a fresh build, with SHA-256
`0e8301685a0d24d7234910c981d84d8e57aba6c7935781fc95ceac2ba641ab06`.
It is not claimed to be an identical archive to the one built at the isolated path;
the source, client, native runtime and current packaged-service checks establish
the relationship between the builds.

The earlier isolated real Luna proposal/approval/restore proof remains historical
evidence for the same source. This integration used a fresh packaged receipt replay,
without spending another real model generation. Tests used synthetic projects and
profiles; the user's existing desktop data was not opened by the smoke checks.

## Commit authorization

Authorized commit message: `Integrate verified foundation and approval recovery into main`.

The full task file list is in
[`main-integration-files.json`](../../evidence/main-integration-files.json).
It contains the imported implementation plus this delivery record and fresh evidence.
The inherited/authored distinction for the implementation is documented in
[the approval file list](2026-09-08-approval-files.md).
Main's separate, pre-existing `scripts/package-desktop.mjs` edit is excluded from
the task commit list. The JSON evidence retains its timestamped verification and
file-list snapshots from before commit authorization; Git records the resulting commit.
