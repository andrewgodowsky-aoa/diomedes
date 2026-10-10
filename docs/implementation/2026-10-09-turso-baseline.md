# Turso and AgentFS baseline (TS00)

Owner request: October 9, 2026. Program NC-TS-2026-10-09.1, packet TS00, prompt `prompts/TS00_IMPLEMENT.md`.
Owner issue: DIO-227. Program issue: DIO-317, under epic DIO-226. Architecture: GitHub issue 262.
Owner: Andrew. Builder: Claude Opus 5.5.
Branch: feature/turso-baseline, first based on 92bc57bd678865390f17291beb382642769e73e5, which was origin/main when the patch was written. The accepted commit reached main at 6b38ffc88d8bd64509b5bd987cb1b4c980d58b5c on 10 October, and this record's follow-up is based there.
App worktree: F:/Diomedes/diomedes-wt/turso-baseline.

The package proposed `docs/implementation/turso-baseline.md`. This record takes the folder's dated form, which 252 of its 256 entries use, so it sorts beside the records it builds on.

## Contract

TS00 measures and records. It changes no production behavior.

- SQLite stays the local store. Turso is a candidate until it proves, on its installed bytes, every protection W01 relies on.
- AgentFS is optional. Nothing here depends on it.
- Free local memory starts with no account, no network and no cloud service.
- Paid services stay separate capabilities.
- The retained NC-UM acceptance stays as it was. TS00 closes no prior case.

The patch adds one test file, its fixtures, the evidence in `evidence/turso-qualification/ts00/` and this record. It adds no production code and no dependency, and it vendors nothing. The packet asks for every protection that needs equivalent behavior to be recorded before any engine change. The measurements below leave no compatible engine change to make yet.

## Source

| What | Exact ref | State |
|---|---|---|
| App base | 92bc57bd678865390f17291beb382642769e73e5 | origin/main. The merge of PR 249, the Expert tier, at 2026-10-09T10:49:59Z. Re-checked at 14:20:35Z. |
| Latest release | v0.2.4 at 2229babf233628e976b9238653f5bdc4aa102dc3 | Published 2026-10-07T06:39:19Z, experimental and unsigned. In main's history. Does not contain the Expert merge. |
| W00 | PR 241, feature/memory-context-contracts at 144d8927eaf84bb10ccbceb095f4ed4b028421c8 | Open when measured. In main since 6b38ffc on 10 October, and PR 241 shows merged. |
| W01 | feature/memory-ledger at d05a6b10d71199631ec254d5eec8e9ff9e737aad | On origin with no PR when measured. In main since 6b38ffc. Main's `server/memory/local-store.ts` and `schema.ts` are still the blobs measured here. |
| W01 schema | blob d4b93eb5ab210065ec266201a3860e2b0e072899, `server/memory/schema.ts` | Read from git while W01 was not on main. Main holds the same blob. |
| Turso | tursodatabase/turso v0.8.2 at 5c168be5ef6a32ac966daf5983502a4f694b37ad, v0.4.4 at dc7781a52b888e323bb12e76c2793d3bab5f9106 | v0.8.2 was tagged 2026-10-06. It is npm's latest for `@tursodatabase/database` and `@tursodatabase/sync`. 0.8.3-pre.1 is a prerelease. |
| AgentFS | tursodatabase/agentfs v0.6.4 at 3a5ed2b88e5d5a5f9b2c7fe02d012b50fd19e3c0 | Released 2026-03-25. npm's latest `agentfs-sdk`. |
| Serverless | `@tursodatabase/serverless` 0.2.4, registry gitHead 7838c3e73baaa88e1a73c153609f439a3f3cb7ef | Pulled in by sync-common's `^0.2.2`. |
| Runtime | Node v22.23.2 with SQLite 3.51.3. Electron 44.2.0. | Electron's SQLite was not measured. |

The repository mirrors of the Core Pillars, Live Roadmap and Project Memory all read version 2026-10-06.1. Both document connectors in this session refused the cloud copies. The package reports the cloud Pillars at NC-PICKER-2026-10-08.1 and newer October 8 amendments in the other two, so the mirrors lag. That divergence belongs to DIO-222. This record uses the mirrors only for the Expert state, and checks that state against git.

No open PR touches Turso, AgentFS, libSQL or the memory ledger. DIO-227 also owns W00, so this packet works in its own worktree and writes only new files. None of them is among the 108 files PR 241 changes.

## What TS00 measured

All results are from win32-x64. `evidence/turso-qualification/ts00/README.md` lists every file, input and command.

### TS-001 Engine identity

Turso 0.8.2 answers `sqlite_version()` with 3.50.4 and a git commit as its source id. It reports its own build as 0.8.2 on a new connection. W01's open check admits only SQLite 3.51.3 or newer, so it refuses the real engine. A build that forged 3.51.3 would pass that check. So identity comes from the installed artifact: component, version and platform. SQL answers can agree with it or contradict it, never replace it. libSQL is a separate family, and a Turso answer never stands in for it.

Identity is asked twice: on a new connection, and on reopening a file the engine wrote, which is how W01 opens its store. On a written file, both Turso versions answer `turso_version()` with 3.47.0 instead of their own build. Each run records that as a contradiction. The independent review traced the number. Once a connection has written, `turso_version()` returns the SQLite version number Turso stamps into the file header: 3047000, at bytes 92 and 96. node:sqlite stamps 3051003 there. So on a written file that answer describes the file's last writer, not the engine. The source id still ends in the pinned upstream commit: 5c168be for 0.8.2 and dc7781a for 0.4.4. So the commit corroborates the build where the version answer does not.

### TS-002 Pinned provenance

Each component's pin covers every package it loads, found the way Node resolves them. Every file is hashed, and the lock's sha512 integrity sits beside it. A changed version, a changed binary or a missing file fails verification against the approved pin.

An added file fails it too. Turso's loader tries a binary beside its own `index.js` before the pinned binding package. A dropped-in `.node` file would change what loads without changing any approved file. Verification refuses any file or nested package an approved package does not list. It also resolves each dependency again the way Node would, which catches a copy that shadows an approved package from outside every approved directory. Two variables, `NAPI_RS_NATIVE_LIBRARY_PATH` and `NAPI_RS_FORCE_WASI`, make the loader load something else. Every run records whether either was set. Neither was. The manifest reproduces byte for byte from the pinned install.

| Component | Installed packages | Native binary on win32-x64 | Redistribution |
|---|---|---|---|
| `@tursodatabase/database` 0.8.2 | database, database-common, database-win32-x64-msvc | `turso.win32-x64-msvc.node`, 16,189,952 bytes, sha256 004f0a3f8087fd21c1385b993014e7955347e238fbed89abe336e6e68002a586 | needs-bundled-notices, 15 files |
| `@tursodatabase/sync` 0.8.2 | sync, database-common, sync-common, serverless 0.2.4, sync-win32-x64-msvc | `sync.win32-x64-msvc.node`, 18,087,936 bytes, sha256 4fda8896a25bbf872556cfccc14447f3cacab05ce4be976a9654689b5b9c1030 | needs-bundled-notices, 16 files |
| `agentfs-sdk` 0.6.4 | the SDK, its own database 0.4.4 trio, buffer, base64-js, ieee754 | JavaScript only. Its engine's binary is the next row. | blocked |
| `@tursodatabase/database` 0.4.4, inside the SDK | database, database-common, database-win32-x64-msvc | `turso.win32-x64-msvc.node`, 7,422,976 bytes, sha256 30f92ca6b7dc36895099ab1b657d3a818e9b5bb08031e7428f5bb4e4eeb83165 | needs-bundled-notices, 8 files |

Turso's npm packages carry no license file. Their texts sit at the pinned commits, so an installer that carries Turso has to bundle those files. `agentfs-sdk` 0.6.4 declares MIT but ships no license text, and the agentfs repository has no root license file at v0.6.4. The two license files it does have cover the CLI's FUSE and NFS crates, not the SDK. That makes the SDK blocked, and only its maintainers can clear it. The SDK's dependencies ship their own license files, and none of them stands in for the SDK's.

### TS-003 Protective checks

The test reads what W01's local store relies on from its source, `server/memory/local-store.ts` at blob 3b65753886c4aba2c6ccbc812b0c59baa766dbcc. It finds 25 items: each PRAGMA, DatabaseSync option and kind of BEGIN, the result code the store maps and the connection property it reads. Each one is covered by a protection below, or named with the reason it is not probed. It fails if one is neither, or if a protection claims to cover something the store does not use. One item is not probed: `PRAGMA cache_size`, because it caps the page cache in memory and no statement answers differently because of it.

A behavior row observes an effect: a refusal, a wait, a file, a row count or an error. A readback row observes only what the engine reports about its own setting. Proven there means the setting was accepted and reads back, not that the engine behaves that way. Where W01 depends on the effect, a behavior row tests it too, such as trusted_schema's refusal of an unsafe function or busy_timeout's actual wait.

| Protection | Proof | node:sqlite 3.51.3 | Turso 0.8.2 | Turso 0.4.4 |
|---|---|---|---|---|
| strict-typing | behavior | proven | proven | unverified |
| check-constraints | behavior | proven | proven | unverified |
| foreign-keys-on | readback | proven | proven | proven |
| scoped-composite-foreign-key | behavior | proven | proven | unverified |
| deferred-event-command-key | behavior | proven | proven | unverified |
| immutable-rows | behavior | proven | proven | unverified |
| monotonic-epoch | behavior | proven | proven | unverified |
| foreign-key-check-detects-orphan | behavior | proven | violated | unsupported |
| trusted-schema-off | readback | proven | unverified | unsupported |
| trusted-schema-refuses-unsafe-function | behavior | proven | unverified | unverified |
| busy-timeout | readback | proven | proven | proven |
| busy-timeout-waits | behavior | proven | proven | proven |
| synchronous-full | readback | proven | proven | violated |
| cache-spill-off | readback | proven | proven | proven |
| max-page-count-ceiling | behavior | proven | proven | proven |
| capacity-error-code | behavior | proven | violated | violated |
| journal-size-limit | readback | proven | unverified | unsupported |
| wal-mode | readback | proven | proven | proven |
| wal-autocheckpoint | readback | proven | unverified | unsupported |
| wal-checkpoint-truncate | behavior | proven | proven | proven |
| wal-frame-accounting | behavior | proven | proven | proven |
| application-id-user-version | behavior | proven | proven | proven |
| immediate-write-exclusion | behavior | proven | proven | proven |
| quick-check-detects-corruption | behavior | proven | proven | unsupported |
| read-only-inspection | behavior | proven | proven | proven |
| double-quoted-identifiers-only | behavior | proven | violated | violated |
| extension-loading-off | behavior | proven | proven | proven |
| rollback-across-await | behavior | proven | proven | proven |
| transaction-state-reported | behavior | proven | proven | violated |
| read-snapshot-isolation | behavior | proven | proven | proven |
| same-engine-schema-reference | behavior | proven | proven | unverified |
| fts5-module, not required | behavior | proven | unsupported | unsupported |

Only proven counts. The verdict for node:sqlite is conformant, with all 31 required protections proven. Both Turso versions get retain-sqlite: 7 not proven on 0.8.2 and 17 on 0.4.4. The integration's AUDIT-06 has since tightened how same-engine-schema-reference is judged (Verification, On main). The rows above come from runs before it.

- **foreign_key_check.** On 0.8.2 it returns no row while an orphan exists. COMPAT.md line 239 lists it as unsupported, yet the engine accepts the statement and answers nothing. W01's last open check reads that silence as clean, so on Turso it passes without checking anything. 0.4.4 refuses the pragma as unknown.
- **Settings that read back nothing.** 0.8.2 accepts trusted_schema, journal_size_limit and wal_autocheckpoint, then returns no row when they are read (COMPAT.md lines 284, 254 and 290). W01 sets all three and never reads them back.
- **trusted_schema's effect.** On node:sqlite, a view that calls an application function is refused once trusted_schema is OFF. Neither Turso promise driver can register an application function (`function()` throws "not implemented"), so the refusal cannot be observed on Turso at all.
- **Full database.** Both Turso versions refuse writes past max_page_count, but the error carries no SQLite result code. W01 reports `memory_capacity` only for result code 13, so on Turso a full store would surface as an unclassified failure.
- **Transaction flag on 0.4.4.** Its `inTransaction` answers false at every point: after BEGIN, after a write inside BEGIN IMMEDIATE and after a failed statement. W01's three failure paths roll back only when that flag says a transaction is open. So through 0.4.4 a failed write would leave its transaction open. The probe then tries the next BEGIN IMMEDIATE, as W01's next write would, and 0.4.4 refuses it as a transaction within a transaction. 0.8.2 tracks the flag correctly.
- **Two connections.** Both Turso versions keep a second writer out while BEGIN IMMEDIATE is open, as node:sqlite does. The second writer waits for busy_timeout before it reports busy. A reader keeps one snapshot for a whole BEGIN.
- **Double-quoted names.** Both Turso versions read a double-quoted name that matches no column as a string. W01 turns that off in node:sqlite. COMPAT.md does not mention it.
- **0.4.4.** It refuses STRICT tables unless an experimental flag is set, so every probe built on W01's STRICT schema could not run. Its synchronous setting reads back 0 after FULL.
- **FTS5.** Neither Turso version has it (COMPAT.md line 1161 points to Turso's own Tantivy search). No server, shared or service code uses FTS today, so it is not a W01 requirement.
- **Corruption.** The quick_check probe damages only the first table's root page. Damage to a deeper leaf page was not tried.

W01's real schema builds all 48 objects on 0.8.2, but 32 of the stored SQL texts differ from node:sqlite's. W01 compares stored text when it opens a file, so a file made by one engine fails the other's inspection. That fails closed, which is safe. It also means a migration cannot move files between engines without a plan for schema text, which is TS06's job. On 0.4.4 the schema does not build at all.

Each required protection has a mutation case. The test removes that one guard in a node:sqlite double and runs the whole set against it. It checks two things: the guard's own probe reports violated, and only the rows named for that case stop being proven. Five cases name such rows, each with its reason. Ignoring the max_page_count ceiling leaves no full-database error for the capacity row to read. A journal that stays in rollback mode leaves no WAL file to count or truncate, whether it reports that mode or claims WAL. Without WAL, the reader's open transaction also blocks the writer in the snapshot row. Skipping ROLLBACK leaves other probes' transactions open, and ignoring BEGIN leaves the transaction-flag probe nothing to track. A guard case keeps the mutation list in step with the protection list.

No probe reads the driver's transaction flag except the one that tests it. Each probe ends its own transactions unconditionally and judges by what it sees, such as the rows left after a rollback. A trial run in this round showed why. On 0.4.4 the flag never says a transaction is open. A snapshot probe that committed only when the flag said so never committed, so the other connection's row seemed never to arrive. Likewise, no probe builds STRICT tables unless it is testing W01's schema, so one missing feature does not hide another row's answer.

The flag probe itself judges an open transaction by COMMIT or ROLLBACK succeeding. That holds only where both fail with no transaction open, so each run checks it first. Both fail on all three engines.

### TS-004 Free local start

The network was refused at Node's fetch, socket, TLS, DNS, HTTP and HTTPS entry points, and no remembered account existed. A test checks that each of those entry points was replaced during the check and put back after it. Any Nectovia, Diomedes, WorkOS, Turso or AgentFS variable was removed first. The recording set one such variable before the run. The record shows it was removed, and that none was present while the run went on, so the empty list is a measurement. The Store still created and reopened a free local project. Exact lookup worked on node:sqlite, on Turso 0.8.2's local file and on sync 0.8.2 with no remote, with no network attempt. Sync's default bootstrap made one pull from its remote and failed. A free local project must never start through that bootstrap.

Two limits apply. Native code that opens its own sockets is outside the refusal, and the sync binary is about 18 MB of native code. So this shows that nothing tried through Node, not that the binary cannot reach the network. And the exact lookup ran on a test table in each engine, not through W01's LocalMemoryStore. That store waits for PR 241 (see Blocked proofs).

### TS-005 Source drift

Main holds the Expert merge. Both dated mirrors still call Expert pending. v0.2.4 was published before the merge and does not contain it. So Expert is merged source, eligible on every Managed plan in current code, and in no released build. A release claim needs a release record. A merge or a document never makes one.

The classifier counts any release record for a subject. It does not check that the release contains the merge. The evidence records v0.2.4 under the subject `app`, so no Expert release is claimed, but a later packet that reuses the classifier needs that containment check.

### TS-006 Windows sandbox

On win32-x64 the SDK wrote, read, listed and removed a file, and stored and read a value. AgentFS publishes a Windows CLI build for 0.6.4. Its pinned manual documents run isolation for Linux (FUSE, overlay and user namespaces) and macOS (NFS, overlay and Apple's Sandbox) only. Windows run isolation is unknown. Working SDK calls do not answer it, and neither would a CLI that runs basic commands.

### TS-007 Documentation divergence

Neither sync 0.8.2 nor AgentFS 0.6.4 documents its default offline conflict behavior. Sync 0.8.2 does document a hook, in `@tursodatabase/sync-common` 0.8.2 at `dist/types.d.ts` lines 94 to 98. An optional `transform` callback is called for every mutation before it is sent to the remote. It can rewrite the update for an application's own conflict resolution. The default stays undocumented, so conflict replay stays unknown until TS03 tests it. AgentFS documents libSQL encryption at rest and says local encryption cannot be combined with cloud sync (MANUAL.md lines 37, 321 and 360). Those are AgentFS claims, and neither Turso engine inherits them.

AgentFS 0.6.4 installs Turso 0.4.4 for itself, a different engine with different results. Its `turso_version()` answers 3.47.0 on the SDK's file. A direct connection to a file 0.4.4 wrote answers the same, and so does 0.8.2 on its own files. So the SDK does not cause it: the answer is the header field described under TS-001. Identity stays with the artifact.

### TS-008 Original acceptance

The NC-UM archive inside the overlay matches its record: 442,559 bytes, sha256 e30727ad070faf1247cf3bc2540b10a036fbf97f487d315bd528634d0dbb6470, 118 files byte for byte. Its 180 prior cases (96, 60 and 24 across three suites) are still specified-not-run or not_run. The 80 new cases share no id with them.

That record travels inside the same overlay, so it cannot vouch for the archive alone. A copy of the NC-UM archive downloaded on its own on October 9, before the overlay arrived, has the same size and sha256. That is a second delivery of the same bytes, not an attestation. The overlay's record is the only place the hash is published. The issue 260 comment that links the upload states 118 files but no hash.

## Compatibility matrix

Measured on win32-x64. Every cell, with its evidence, is in `evidence/turso-qualification/ts00/support-matrix.json`.

| Status | Component | Capability |
|---|---|---|
| Compatible | node:sqlite 3.51.3 | All 31 required W01 protections. FTS5. |
| Compatible | `@tursodatabase/database` 0.8.2 | A local file with no network. W01's schema builds. A second writer is kept out and waits, and a read keeps one snapshot. |
| Compatible | `@tursodatabase/sync` 0.8.2 | A local start with no remote. |
| Compatible | `agentfs-sdk` 0.6.4 | SDK file and key-value operations. |
| Published, not run | agentfs-cli 0.6.4 | A Windows build is published. Known from release metadata only. |
| Incompatible | `@tursodatabase/database` 0.8.2 | W01's protections, 7 not proven. Schema text parity with node:sqlite. A result code on a full database. FTS5. |
| Incompatible | `@tursodatabase/database` 0.4.4 | STRICT tables. The transaction flag W01's failure paths read. W01's protections, 17 not proven. |
| Incompatible | `@tursodatabase/sync` 0.8.2 | The default bootstrap with no network. |
| Unknown | `@tursodatabase/database` 0.8.2 | Anything on darwin-arm64. |
| Unknown | `@tursodatabase/sync` 0.8.2 | Offline conflict replay. |
| Unknown | agentfs-cli 0.6.4 | Windows run isolation. |
| Unknown | Electron 44.2.0's SQLite | W01's protections inside the packaged app. |

Redistribution is separate from compatibility. It is in `artifact-manifest.json`: every Turso component needs its upstream notices bundled, and `agentfs-sdk` 0.6.4 is blocked.

## Supported scope boundaries

- **Platforms.** Turso publishes bindings for win32-x64-msvc, darwin-arm64, linux-x64-gnu and linux-arm64-gnu. It has no darwin-x64, win32-arm64 or musl build. The app packages win32 x64 and darwin arm64 (`package:windows`, `package:mac`), so both have a binding. Only win32-x64 was measured.
- **Local** (TS00, TS01, TS02, TS04, TS06, TS07). SQLite stays the store. Turso cannot replace it for W01 today.
- **Managed sync** (local plus TS03). Sync starts locally with no remote. Conflict replay is untested.
- **AgentFS** (TS00, TS05). The SDK works on Windows. It cannot be redistributed until its license text exists, and Windows run isolation is unknown.
- **Hosted bot** (TS00, TS02, TS04, TS07, TS08). TS00 measures nothing here.
- **Versions.** These results answer for the exact bytes recorded. A new Turso or AgentFS version needs its own run, and nothing here holds a later version back.

## Next eligible owner checkpoint

**Update, 10 October.** W00 and W01 reached main at 6b38ffc through the performance-audit integration, so the PR 241 blocker below is gone. TS01 (DIO-228) and TS02 (DIO-229) now depend only on TS00, which is in main.

- W01's `local-store.ts` and `schema.ts` on main are the blobs measured here, so the protections above still describe main.
- TS02's seams, `server/memory/service.ts` and `shared/memory-ledger.ts`, are on main.
- TS01's Turso adapter would meet the 7 protections that 0.8.2 leaves unproven. So it can record them as blockers and keep SQLite.
- W01's own worktree is locked with its tests deferred, and no coordination claim covers the memory files.
- TS05 was accepted and is in main with three repairs. TS07 still waits: PR 259 is open, and the bought-credit-regression lane has no PR.

The rest of this section is as measured on 9 October.

In `work-items.json`, TS05 and TS07 depend only on TS00. TS01 and TS06 need W01's store, and W01 waits on W00's PR 241. TS02 also depends only on TS00 in `work-items.json`. This record still groups it with the packets that wait for W01. The files it extends, `server/memory/service.ts` and `shared/memory-ledger.ts`, exist only on W01, not on main or in PR 241. TS03, TS04, TS08 and TS09 follow from those. Neither TS05 nor TS07 runs its gates or goes to review until TS00's gates and independent review pass. TS05's code was started while this review waited for the coordination heavy slot (see the build ledger). Merging TS00 is a separate publication step. `source-baseline.json` records the claims, PR heads and observation time behind each point below.

- **TS07 under DIO-128 waits for the live funding lane.** The bought-credit-regression candidate holds every production file TS07 names. That candidate is uncommitted on feature/bought-credit-regression, based on 92bc57b. Its claims cover `shared/access.ts`, `server/accounts/agent-gate.ts`, `routing-session.ts` and `session.ts`. They also cover `server/engines/service.ts` and `nectovia.ts`, and the control plane's `managed-inference.ts`, `routing.ts` and `contract.ts`. That lane took the heavy slot for its final gates at 14:40Z. Open PRs 244, 198 and 182 change the same funding code and tests.
- **Main still carries the overturned rule.** PR 259 records Andrew's October 8 decision. The Agent needs a paid plan, and bought credits pay only for Nectovia-routed calls. Main's `shared/access.ts` still lets bought credits open the Agent for Personal work. A TS07 test written against main today would encode that old rule. TS07 starts after the funding candidate and PR 259 reach main.
- **Four TS07 cases need memory services that do not exist yet.** TS-057 needs W01's local store, and TS-059 needs Dreaming (TS04). TS-062 needs managed sync (TS03), and TS-063 needs a memory quota. TS-061's trial stays off by policy. TS-058 and TS-060 can be tested on the admission code once it settles, and TS-064 needs the versioned policy it describes.
- **TS05 under DIO-31 can be written but not shipped.** Its seams are `server/harness/tools.ts`, `server/paths.ts` and `server/sandbox/`. Open PR 248 changes `server/sandbox/sandbox.ts`, and the app-wording lane holds a claim on `server/sandbox/change-sets.ts`. Nothing that bundles `agentfs-sdk` can ship until the license text exists. Windows run isolation needs the CLI downloaded and run, which needs Andrew's approval.
- **Program blocker: PR 241.** It has been open since 2026-10-06 and unchanged since 2026-10-07. Until it merges, W01 gets no gates or PR, and seven of the ten packets wait.

## Blocked proofs

| Proof | Why it is blocked | What clears it |
|---|---|---|
| W01's LocalMemoryStore opened offline | TS-004's lookup ran on a test table, because W01 was not on main. W01 is in main since 10 October. | TS01 runs the offline open against the real store. |
| Windows run isolation, agentfs-cli 0.6.4 | The CLI was not downloaded or run. | Andrew approves downloading `agentfs-x86_64-pc-windows-msvc.zip` (7,000,593 bytes, with its .sha256) and running it in an isolated folder. |
| `agentfs-sdk` redistribution | No license text upstream. | The maintainers publish it. |
| Cloud canonical documents | Both connectors refused them. | Read access for this account, or a fresh export under DIO-222. |
| Electron's SQLite | This runner does not run inside Electron. | The same probes run in Electron 44.2.0. |
| darwin-arm64 | No Mac run. | The same commands on a Mac. |
| Sync conflict replay | Outside TS00. | TS03. |
| TS07 admission tests | The funding candidate holds their files, and main still carries the rule PR 259 overturns. | The funding candidate and PR 259 merge, and TS07 starts from the new main. |
| Rust crate licenses | Not audited crate by crate. | An audit of each binary's crate graph before anything is vendored. |
| trusted_schema's effect on Turso | Neither Turso promise driver can register an application function, which is what the probe uses. | A Turso driver that can register one, or another way to observe the setting that Turso can run. |
| Network use by native code | The refusal covers Node's entry points only. | A run under an operating-system network block, or a review of each binary's socket use. |

## Pillar impact

- **Pillar 09, trust as part of the architecture.** Every protection W01 relies on stays. A candidate engine has to prove each one, and none is dropped to fit an engine.
- **Pillar 12, one strong core.** Free local memory starts with no account, network or cloud service (TS-004).
- **Pillars 05 and 07, engines as interchangeable resources.** Identity comes from the installed bytes, and a result answers for one version. Each new version gets its own run.
- **Conflicts.** None found in this patch. Adopting Turso 0.8.2 for W01 today would conflict with Pillar 09, which is why SQLite stays. So would adopting 0.4.4 through AgentFS: a driver whose transaction flag never reports an open transaction would leave a failed write's transaction open.

## Verification

The repository's gates passed on 2026-10-09 under the coordination heavy slot, from 17:13:04Z to 17:27:59Z. They ran on tree a0b03c12, which is this patch on base 92bc57b.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npx vitest run tests/turso-contract-baseline.test.ts` | 71 passed, 10 skipped. With the three `NCTS_` variables, 81 passed. |
| `npx vitest run --maxWorkers=4` | 623 files. 10,590 passed, 15 skipped. |
| `npx vite build` | passed |
| `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts` | 37 passed |

The ten skips are the real-engine cases. They need the probe install, the package and the NC-UM archive.

At 17:28:50Z the nine runner-made evidence files were made again from this tree. All nine matched the committed files byte for byte.

An earlier full run, before the last test change, failed one test outside this patch. In `tests/h14-external-worker.test.ts`, a Team run stalled after the server logged `Unknown run`. That test passed alone and in the full run above. It is tracked as DIO-318.

The independent review accepted this patch in two phases. The first read it and asked for the fixes listed in the build ledger. The second ran on review candidate 6e83c85c under the slot, from 18:55:39Z to 19:06:28Z. tsc passed. The TS00 file gave 71 passed and 10 skipped, and 81 passed with the three `NCTS_` variables. All nine runner-made evidence files matched byte for byte. Each of the 17 mutation cases was caught, and seven reproductions behaved as the fixes claim. It found no defect, and made two optional notes:

- The 3.47.0 answer needed its cause. TS-001 now gives it.
- A real-engine run leaves one 4,096-byte `tursodb-ephemeral-` file in the temporary folder, made by a Turso child process. It is recorded here, not fixed, because a fix would change the reviewed runner. The follow-up points the runner's child processes at the run's scratch folder.

After the review, only this record and the build ledger changed.

**On main.** The performance-audit integration fast-forwarded main to 6b38ffc at 03:01Z on 10 October. It took 7c40ce5 as a prerequisite and added AUDIT-06 (d7b1033) to this packet's test and fixture. AUDIT-06 makes same-engine-schema-reference require a complete reference catalog: the twelve named objects the probe schema makes, each with its type, its table and its SQL. Its note is `docs/implementation/2026-10-09-performance-audit/06-schema-proof.md`.

- Its worker ran the file without the three `NCTS_` variables. No run of the real-engine cases on main's code is recorded, and no evidence made by one. The recorded rows come from runs before the repair.
- Running those cases on main and making the evidence again is the next check.
- This packet's reviewer has not reviewed AUDIT-06.

## Publication boundary

Authored, implemented, tested and independently reviewed: accepted at 7c40ce5. Pushed as PR 264, which shows merged: the performance-audit integration took 7c40ce5 into main at 6b38ffc on 10 October, with AUDIT-06 on its test. Not deployed: Workers Builds skipped the merge. Not released. Not marked DONE here, because AUDIT-06 has had no review in this packet and no run of the real-engine cases on main's code is recorded.
