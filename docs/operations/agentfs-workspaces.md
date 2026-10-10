# AgentFS task workspaces

Status: candidate code. The loop does not use it, and it has not shipped.
Owner issue DIO-31 (Core Files). Program NC-TS-2026-10-09.1, packet TS05.
Owner: Andrew. Builder: Claude Opus 5.5.
Record: `docs/implementation/2026-10-09-agentfs-workspaces.md`. Ledger: `evidence/agentfs-workspaces/BUILD_LEDGER.md`.

## What it is

A sub-task normally works in a copy of the files it was given (`server/sandbox/sandbox.ts`). That copy stays the default.

`server/files/agentfs-workspace.ts` adds a second way to hold a sub-task's working files. The files it was given are pinned as exact bytes. Everything it writes goes into one AgentFS database of its own, under a name made new for that workspace. When it is done, its changes are checked and written into the project through `Store.writeRecorded`, the writer every other change uses.

AgentFS here only holds one sub-task's edits. It is not the project's file catalog, not memory, and not a record of what happened outside Nectovia. Nothing canonical lives in it.

## Why it is off

- **License.** `agentfs-sdk` 0.6.4 cannot be redistributed. Its package declares MIT but ships no license text, and only its maintainers can fix that (TS00). So the SDK is never a dependency of this repository. The adapter loads an install someone made, after checking every package Node would load from it and the hash of the engine's native file.
- **No boundary for programs.** Running programs inside a workspace needs an operating-system boundary, and this installation has none (`server/trust/environments.ts`). The AgentFS command-line tool, which owns mounts and `run`, has not been downloaded or tested. So the adapter offers file tools only.
- **Wiring.** The loop's sandbox wiring is in files that open PR 248 changes: `server/sandbox/sandbox.ts` and both `native-loop.ts` files. Connecting the adapter is a small change after that PR lands.

## Running it

Nothing in the product calls the adapter yet. Its tests run it two ways:

- On a stand-in for the SDK (`tests/fixtures/agentfs-double.ts`), on every run.
- On the real SDK, when `NCTS_TURSO_NODE_MODULES` names a `node_modules` folder holding `agentfs-sdk` 0.6.4 and its `@tursodatabase/database` 0.4.4. TS00's probe install is one. Its package.json and lock are in TS00's evidence.

```
NCTS_TURSO_NODE_MODULES=<node_modules folder> npx vitest run tests/agentfs-files-conformance.test.ts
```

`loadAgentFsSdk(nodeModules)` loads only what was qualified. It refuses:

- any platform but win32-x64, the only one qualified;
- another version of the SDK, the engine, the engine's common package or its native binding, each found the way Node would find it;
- a native file whose sha256 is not the one TS00 pinned, and a native file left beside the engine's loader, which that loader would try first;
- either loader variable that swaps the native binary (`NAPI_RS_NATIVE_LIBRARY_PATH`, `NAPI_RS_FORCE_WASI`), when this process has it set. The engine reads this process's environment, so a caller cannot clear it.

## How a workspace works

1. **Pin.** Every project file in the sub-task's scope is read once, hashed and kept by its hash. `base.json` lists each path, hash and size, and the hash of its exact bytes names the base. A scope over the limits is refused whole, with the numbers, and leaves nothing behind. So is a scope whose pinned copies would leave too little free disk. Who may read the scope is read before the files and again after, and a change in between makes no workspace. A file that cannot be read stops the workspace, so none goes missing from the base unseen.
2. **Work.** The sub-task gets the copy sandbox's four tools, with the same names and answers: list, read, write and propose. A read comes from its own changes first, then from the pinned bytes, checked against their hash. A write goes only into its own database.
3. **One owner.** An assignment fence names the job's owner. Giving the job to a new owner moves the fence. After that the old owner cannot open the workspace, write, list its changes, copy it or hand it back. Tools the old owner already holds can still read its own copy, and nothing more. A lease names one workspace. Once a job's workspace is made again, an old lease opens, hands back, copies and removes nothing of the new one. One set of tools may write at a time, even when two in one process ask at the same moment. Their lock file can be released only by those tools.
4. **List the changes.** The workspace lists what changed against the base, with hashes, and returns the digest of that list. Every host lists them in the same order.
5. **Hand back.** Every check runs before anything reaches the project. The fence holds, the tools are closed and the base is intact. The changes still match the digest, each path is in scope, and who may read the job's sources has not changed. Each change is then written with the pinned hash as the expected version, and the fence is read again before each write. A file that moved on in the project since the pin is a conflict, and nothing is written over it. Each write is read back from History and from the project before it counts as applied. Then the workspace is spent, and later writes and hand-backs are refused.

Some changes come back as waiting instead. These are changes the sub-task asked a person to decide, changes outside what the loop may apply, and changes the Store refuses for their content. Each waiting change and each conflict carries the hash it was made against and its own. They stay in the spent workspace, which still opens to read, so a person can review each one by its hash. Routing them to a person is part of the wiring that waits for PR 248.

A hand-back holds the Store's lock, so a reassignment or a disposal asked for meanwhile waits for it. Its refusals leave the Store as it was. Only a failure inside the Store's own writer makes the Store reload from disk, and a retry then records each change once.

The lock covers the adapter's own tools. AgentFS does not enforce one writer: a second connection to the same database can write. So a hand-back reads every change again and checks it against the listed digest, and anything written behind the tools' back is refused there.

Tools whose process ended without closing leave their lock file, and the next tools to open take it over. A lock file that cannot be read counts as a live writer, so its workspace refuses writers until the file is removed. Remove `writer.lock` by hand only when no tools for that workspace are open.

## The database's name

Each workspace's database is named `delta-` and 16 random hex digits, then `.db`. The name is new every time a workspace is made. That includes a workspace made again for the same job and a checkpoint opened on another host. The lease records the name, and a name that does not fit that pattern is refused before it becomes part of a path.

The pinned engine is the reason. While a process holds a database, the engine keeps it in memory under its path. On Turso 0.4.4, a database removed and made again at the same path in one process comes back with its old rows. Its new file on disk stays empty, even after a write and a close. A new name never meets the old copy.

So a workspace whose database file is missing or empty is refused, and nothing is opened.

## Limits

| Limit | Default | Why |
|---|---|---|
| Files in the base, and changed files | 200 | The copy sandbox's limit. |
| Bytes in the base | 8 MB | The copy sandbox's limit. |
| Bytes in one file | 1 MB | The copy sandbox's limit. |
| Bytes of changes | 8 MB | A change to a pinned file counts the whole file. |
| The database on disk, journal files included | 32 MB | The engine's journal grows faster than the changes. |
| Free disk left after a write | 256 MB | A workspace never fills the disk. |

Each write reserves its cost before anything is written. A write that does not fit is refused with the numbers. Pinning a scope, copying a checkpoint and opening one reserve their disk space first too. A checkpoint opened here gets this host's limits, whatever limits it carries.

A database stores its own chunk size, and the SDK writes in chunks of that size. A database storing anything but the SDK's own 4,096 bytes is refused before it is used, since another size could write far more than was reserved.

- A change rewrites the whole file. Changing a few bytes of a 300 KB file costs 300 KB.
- The database is measured on disk before each write. On the pinned engine, a new database holding one 9-byte file and a few small records took 4 KB. Its write-ahead log beside it took 280 KB. The check counts the write's own bytes, so a database can pass its cap by one write's journal growth at most. Every write after that is refused.

## Names

The workspace uses the project's own name rules (`relativeName` in `server/paths.ts`). Absolute paths, drive letters, `..`, device names, private names such as `.env` and blocked folders such as `.git` are refused before the database sees them. It also refuses:

- two names that differ only in capitals, since Windows and macOS treat them as one file;
- a file where the base has a folder, or a folder where the base has a file;
- writing to anything but a plain file.

AgentFS can hold links, but 0.6.4 cannot read one back. The tools never read or write through a link, and a link is never handed back. Neither is a file that is not text.

## Checkpoints

`exportCheckpoint(lease, destination)` makes a copy another host can open. It copies the base list, every pinned file, the database and the database's journal files, then writes `checkpoint.json` last. A folder without `checkpoint.json` is not a checkpoint. Only the job's current owner can make one, and the tools must be closed first. The destination must be an empty folder of its own. One inside app data or any project's folder is refused, even when a link leads there. A copy that fails removes what it wrote.

The journal files matter. On the pinned engine a closed database keeps its rows in its `-wal` journal file. The database file copied without it opens as an empty file system, with no error.

`importCheckpoint(source, { projectId, jobId, owner })` opens a checkpoint as the job you name. It refuses a checkpoint that:

- holds another job's workspace, or another project's;
- names an owner this host cannot read, or one other than the owner this host has for the job;
- was made with another AgentFS build than this host runs;
- is larger than this host's limits allow;
- is missing the base list, any pinned file, the database or any journal file it lists, or has any of them damaged;
- has a database that does not hold exactly the changes it lists;
- was made where other people may read its files than may read them on this host.

It also refuses when the job already has a workspace on this host, and while another import for the same job is under way. Each file is checked again as it is copied, so a file changed meanwhile is refused too. A refused import leaves nothing behind, not even an owner for the job. An opened checkpoint gets this host's limits, not the ones it carries. It gets a new database name on its new host, and each journal file is renamed to match.

An import checks that a checkpoint is complete, intact and meant for the job you named. It does not check who made it, because checkpoints are not signed. So open only a checkpoint from a host you trust. The receiving host's own checks still run at hand-back. Its loop decides what may be written and where. Who may read the sources is checked again, and so is each file's version against the project as it is then.

An export copies. It does not move. Once a checkpoint is opened on another host, dispose of the original or give the job to the new owner. Then only one copy can hand back. If both tried, the Store's expected-version check would stop the second from writing over the first.

## Disposing

`dispose(lease)` removes the workspace a lease names: its database, its pinned files and its lease. The job's owner stays. A lease for a workspace made again since removes nothing, so a late caller never throws away newer work. Disposal waits for a hand-back under way, and does not wait for open tools. Their next write is refused, because their workspace is gone.

## Encryption and sync

The pinned SDK offers neither, and the AgentFS 0.6.4 manual rules out local encryption together with cloud sync. A request for encryption, sync or both is refused by name. Nothing falls back to a workspace without them.

## The tool log

AgentFS keeps its own log of tool calls, and any program that opens the database can write to it. The adapter reads it only as observations: a name, a status and times, never arguments, results or errors. An observation never counts as proof that something was sent, paid or approved, and reading one changes nothing.

## Access and isolation

The adapter changes no permission choice. Full access is not offered on this installation, because no isolated environment exists (`server/trust/environments.ts`). A workspace does not count as one: it holds files and runs nothing. Whatever an owner has chosen for local access stays exactly as chosen, and a workspace beside it is not isolation.

A managed job's programs get the environment that `minimalEnvironment` builds (`server/harness/containment.ts`). It holds the system path and folders, the temporary folders and the shell, with no home folder and no credentials. A workspace adds nothing to it, because it starts no program.

## What is proven and what is not

The record lists each acceptance case, its test and its evidence. Proven only for file tools, on win32-x64, on the stand-in and on `agentfs-sdk` 0.6.4.

Not proven, with what would clear each:

- An operating-system boundary for managed jobs. None exists here.
- AgentFS mounts and `run` on any platform. The command-line tool needs Andrew's approval to download and run.
- Real upload links. Core Files object storage is not built, so the replay case is tested on the hand-back instead.
- Redistribution. The SDK needs its license text from its maintainers.
- Electron and darwin-arm64. Neither was run.
- Who made a checkpoint. Checkpoints are checked for completeness and integrity, and signing them would clear it.
- A second process using one data folder at the same time. The Store serializes its writes within one process only.
- A newer engine. The name rule answers Turso 0.4.4's in-memory reuse. A newer engine needs the same tests run again before its pin moves.
