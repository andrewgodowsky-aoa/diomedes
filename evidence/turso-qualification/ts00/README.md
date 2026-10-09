# TS00 evidence

Packet TS00 of NC-TS-2026-10-09.1, owner DIO-227. Recorded 2026-10-09 on win32-x64, Node v22.23.2 (SQLite 3.51.3), at app base 92bc57bd678865390f17291beb382642769e73e5.

Each file below says what was measured, which command made it, and what it cannot show. The record of decisions is `docs/implementation/2026-10-09-turso-baseline.md`.

## Files

| File | What it records | Made by |
|---|---|---|
| `engine-node-sqlite.json` | The reference engine. All 31 required W01 protections proven: conformant. Each result says whether it observed behavior or only read a setting back. | runner, `probes` |
| `engine-turso-database-0.8.2.json` | The same probes on `@tursodatabase/database` 0.8.2: retain-sqlite, 7 required protections not proven. | runner, `probes` |
| `engine-turso-database-0.4.4.json` | The engine `agentfs-sdk` 0.6.4 installs for itself: retain-sqlite, 17 not proven. | runner, `probes` |
| `schema-turso-database-0.8.2.json` | W01's real schema built in node:sqlite and in 0.8.2, compared object by object and by stored SQL text. | runner, `schema` |
| `schema-turso-database-0.4.4.json` | The same build on 0.4.4, which refuses STRICT tables. | runner, `schema` |
| `offline-start.json` | Exact lookup with the network refused and account variables removed, on Turso's local file, on sync with no remote, and on sync's default bootstrap. Names the variables removed and any present during the run. | runner, `offline` |
| `agentfs-sdk.json` | The SDK's engine range and installed engine, its identity read directly, what `sqlite_version()`, `sqlite_source_id()` and `turso_version()` answer through the SDK's own connection, and SDK file and key-value operations. | runner, `agentfs` |
| `artifact-manifest.json` | For each component: every installed package and file by sha256, lock integrity, the native binary, pinned upstream sources, the license of every package and the redistribution verdict. | runner, `manifest` |
| `upstream-notices.json` | License and notice files at each pinned upstream commit, by sha256, with every exclusion and its reason. | by hand, commands inside |
| `package-retention.json` | The retained NC-UM archive verified byte for byte, the size and hash of a copy obtained apart from the overlay, its 180 prior cases and the 80 new cases. | runner, `retention` |
| `support-matrix.json` | Supported, unsupported and unknown cells, and claims quoted from two pinned upstream documents and one file of a pinned package. | by hand |
| `source-baseline.json` | Main, the Expert merge, the latest release, the dated document mirrors, W00 and W01, and who holds the files the next packets need. | by hand, commands inside |
| `probe-install/` | The `package.json` and `package-lock.json` of the probe install, renamed so no tool reads them as a manifest of this repository. | copied |

The tests in `tests/turso-contract-baseline.test.ts` read these files. They import nothing from Turso or AgentFS, and this repository gains no dependency.

## Inputs

All four inputs live outside the repository.

1. **The probe install.** Copy `probe-install/probe.package.json` to an empty folder as `package.json` and `probe.package-lock.json` as `package-lock.json`, then run `npm ci --ignore-scripts`. No pinned package declares an install script. The lock pins `@tursodatabase/database` 0.8.2, `@tursodatabase/sync` 0.8.2 and `agentfs-sdk` 0.6.4. npm resolves the SDK's own range, `^0.4.0-pre.18`, to `@tursodatabase/database` 0.4.4 under `agentfs-sdk/node_modules`. On win32-x64, 14 packages install. The other 9 lock entries are bindings for other platforms.
2. **W01's schema.** `git cat-file blob d4b93eb5ab210065ec266201a3860e2b0e072899 > <scratch>/schema.ts` writes `server/memory/schema.ts` from `feature/memory-ledger` at d05a6b10d71199631ec254d5eec8e9ff9e737aad with its LF endings. W01 is not on main, so the schema is read from git. The file's sha256 is b35dbce7decab39acd786033845c9d9ebf0a97ad46fc60726168826bc19f3827. `schemaSha256` in the schema files is the hash of the exported SQL string, not of the file.
3. **The NC-TS overlay**, unpacked from `Nectovia-Turso-AgentFS-2026-10-09.zip`. It holds the retained NC-UM archive at `baseline/Nectovia-Unified-Memory-2026-10-09.zip`.
4. **A separate copy of the NC-UM archive**, `Nectovia-Unified-Memory-2026-10-09.zip`, obtained apart from the overlay. Only its size and hash are recorded.

## Commands

Run from the worktree root, because the runner reads the Electron version and redacts paths relative to it.

```bash
RUN="node node_modules/tsx/dist/cli.mjs tests/fixtures/turso-qualification/run-engine-probes.ts"
NM=<probe install>/node_modules
OUT=evidence/turso-qualification/ts00
SCR=<scratch folder>
$RUN probes --engine node-sqlite --scratch "$SCR" > "$OUT/engine-node-sqlite.json"
$RUN probes --driver "$NM/@tursodatabase/database/dist/promise.js" --node-modules "$NM" --scratch "$SCR" > "$OUT/engine-turso-database-0.8.2.json"
$RUN probes --driver "$NM/agentfs-sdk/node_modules/@tursodatabase/database/dist/promise.js" --node-modules "$NM" --scratch "$SCR" > "$OUT/engine-turso-database-0.4.4.json"
$RUN schema --driver "$NM/@tursodatabase/database/dist/promise.js" --node-modules "$NM" --schema-module <scratch>/schema.ts --scratch "$SCR" > "$OUT/schema-turso-database-0.8.2.json"
$RUN schema --driver "$NM/agentfs-sdk/node_modules/@tursodatabase/database/dist/promise.js" --node-modules "$NM" --schema-module <scratch>/schema.ts --scratch "$SCR" > "$OUT/schema-turso-database-0.4.4.json"
NECTOVIA_PROBE_TOKEN=set $RUN offline --node-modules "$NM" --scratch "$SCR" > "$OUT/offline-start.json"
$RUN agentfs --node-modules "$NM" --scratch "$SCR" > "$OUT/agentfs-sdk.json"
$RUN manifest --node-modules "$NM" --lock <probe install>/package-lock.json --notices "$OUT/upstream-notices.json" > "$OUT/artifact-manifest.json"
$RUN retention --package <unpacked overlay> --independent <separate NC-UM archive> > "$OUT/package-retention.json"
```

The runner replaces local paths with `<node_modules>`, `<scratch>`, `<overlay>`, `<repo>`, `<tmp>` and `<home>`.

The offline run sets one marker variable that the credential pattern matches, so the record shows a variable being removed. Any other Nectovia, Diomedes, WorkOS, Turso or AgentFS variable in the shell is removed and named too. Unset those first to reproduce the recorded file exactly.

To check the recorded files against fresh runs, set the variables and run the test file:

```bash
NCTS_TURSO_NODE_MODULES=<probe install>/node_modules NCTS_PACKAGE_DIR=<unpacked overlay> NCTS_NCUM_ARCHIVE=<separate NC-UM archive> npx vitest run tests/turso-contract-baseline.test.ts
```

Without them, those reproduction cases skip, and every other case still reads the recorded files. With them, the tests rerun seven of the nine files the runner made. Four are compared whole: the manifest, the retention record, the offline record with only the marker variable set, and the 0.8.2 schema. Three are compared in part: both Turso engines' statuses and identity, and the SDK's identity, answers and file operations. The node:sqlite engine file is checked in process instead, and the 0.4.4 schema file is not rerun. Three files are made by hand and are not reproduced by any run: `upstream-notices.json`, `support-matrix.json` and `source-baseline.json`. Each names the sources or commands it was read from.

## Reading artifact-manifest.json

- `packages[].name` is where a package is installed under `node_modules`: its name at the top level, `agentfs-sdk/node_modules/...` when nested.
- `artifactDigest` hashes each package's name, version and file hashes. A changed binary or any changed file changes it.
- A notice path that starts with a source key, such as `turso@v0.8.2/LICENSE.md`, is a file at that pinned commit. The key matches `sources` in `upstream-notices.json`. A path that starts with a package, such as `buffer/LICENSE`, is a file inside that installed package.
- `redistribution.status` is `ready`, `needs-bundled-notices` or `blocked`. The second means the app must carry the listed texts. Blocked means a package declares a license whose text exists nowhere this repository could carry it from. Files are matched by content, so one carried copy satisfies identical texts from two sources.

## Limits

- One platform. Only win32-x64 was measured. The app also packages darwin arm64, and Turso publishes that binding, but nothing ran there.
- The reference is Node v22.23.2's SQLite 3.51.3. The app runs on Electron 44.2.0, whose SQLite was not measured here.
- Sync's offline conflict replay was not tested. It belongs to TS03.
- The AgentFS Windows CLI is known from release metadata only. It was not downloaded or run.
- The upstream notices are the files each repository ships at its pinned commit. The Rust dependency graphs behind the native binaries were not audited crate by crate.
- Turso's NOTICE.md at v0.8.2 cites `licenses/extensions/libm-*` files that do not exist at that commit, and swaps the paths of the Error Prone and AssertJ licenses. Recorded as found.
- `@tursodatabase/serverless` 0.2.4 has no repository field. Its source is the npm registry's gitHead, 7838c3e73baaa88e1a73c153609f439a3f3cb7ef, an ancestor of turso v0.8.2.
- Probe messages such as WAL byte counts and corruption text vary between runs. The reproduction cases compare statuses, not those strings. Wait times are bounded, not recorded: busy-timeout-waits records that the second writer waited at least 80 ms and gave up within 1 s.
- The offline check refuses Node's fetch, socket, TLS, DNS, HTTP and HTTPS entry points. Native code that opens its own sockets is not covered, and the sync binary is about 18 MB of native code.
- The exact lookup ran on a test table in each engine, not through W01's LocalMemoryStore, which waits for PR 241.
- The quick_check probe damages only the first table's root page. A deeper leaf page was not tried.
- The source classifier counts any release record for a subject without checking that the release contains the merge. The recorded release is under the subject `app`, so no Expert release is claimed.
