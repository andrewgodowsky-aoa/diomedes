# AgentFS task workspaces (TS05)

Owner request: October 9, 2026. Program NC-TS-2026-10-09.1, packet TS05, prompt `prompts/TS05_IMPLEMENT.md`.
Owner issue: DIO-31, Core Files. Program issue: DIO-317, under epic DIO-226. Architecture: GitHub issue 262.
Owner: Andrew. Builder: Claude Opus 5.5.
Branch: feature/agentfs-workspaces, first based on 92bc57bd678865390f17291beb382642769e73e5, which was origin/main when the patch was written. The reviewed candidate reached main at 6b38ffc88d8bd64509b5bd987cb1b4c980d58b5c on 10 October, and the follow-up in this record is based there.
App worktree: F:/Diomedes/diomedes-wt/agentfs-workspaces.
Operations page: `docs/operations/agentfs-workspaces.md`. Build ledger: `evidence/agentfs-workspaces/BUILD_LEDGER.md`.

## Contract

TS05 adds an optional way to hold a sub-task's working files. It is candidate code, and nothing in the product calls it yet.

- The copy sandbox (`server/sandbox/sandbox.ts`) stays the default, unchanged.
- AgentFS is optional. The adapter runs only when an operator loads a pinned SDK install, and only for a sub-task that runs no program.
- `Store.writeRecorded` stays the one writer of project files. AgentFS holds one job's edits and nothing canonical.
- SQLite stays the local store, and memory is untouched. Free local work needs no account, network or cloud service.
- No paid service, spend or customer credential is involved.

The patch adds one module, one test file, one test fixture, an operations page, this record and a build ledger. It changes no existing file, adds no dependency and vendors nothing.

## Source

| What | Exact ref | State |
|---|---|---|
| App base | 92bc57bd678865390f17291beb382642769e73e5 | origin/main, the merge of PR 249, until 10 October. |
| Main now | 6b38ffc88d8bd64509b5bd987cb1b4c980d58b5c | The performance-audit integration fast-forwarded main here at 03:01Z on 10 October. It carries this patch's reviewed candidate with three repairs on top (Verification, On main). |
| TS00 | 7c40ce5ff7b52d8c93e245d13c7d08a44e44a56e | Accepted by its independent review. In main since 6b38ffc, with the integration's AUDIT-06 (d7b1033) on its test. TS05 reuses its measurements, not its code. |
| AgentFS | `agentfs-sdk` 0.6.4 (tursodatabase/agentfs v0.6.4 at 3a5ed2b) on `@tursodatabase/database` 0.4.4 (turso v0.4.4 at dc7781a) | TS00's probe install, outside this repository. Never a dependency here. |
| Sandbox wiring | PR 248, feature/local-agent-repair-verification at 7cd70ac | Open, with merge conflicts, last updated 2026-10-06. It changes `server/sandbox/sandbox.ts`, both `native-loop.ts` files and `server/native-loop-routes.ts`. |
| Change sets | `server/sandbox/change-sets.ts` | Claimed by the app-wording lane. TS05 reads it and edits nothing. |
| W00 | PR 241 at 144d892 | In main since 6b38ffc. TS05 does not depend on it. |
| Runtime | Node v22.23.2 on win32-x64 | |

Coordination claim claim_mv19iu1z_7a0fd19c (node DIO-31.TS05, from 17:52:04Z) covered the new paths. The integrator recorded an owner-directed transfer of it on 10 October. The follow-up holds claim_mv1ubgrf_7ea0d5a8 (node DIO-31.TS05, from 03:34:12Z on 10 October). No open PR touches these paths.

**The smallest missing piece.** Nothing in the repository held a sub-task's files over a pinned base with one fenced writer, and nothing tested AgentFS's behavior. TS00 measured the SDK's file operations on Windows, its license block and its engine's protections. It did not run a workspace.

## Design

**Where it lives.** `server/files/agentfs-workspace.ts`, the path the package proposed. A workspace sits in `<data>/projects/<id>/harness/workspaces/<job id>/`. The copy sandbox's sweep removes every folder under `harness/sandboxes/` that lacks its manifest, so workspaces need their own folder.

**Loading.** `loadAgentFsSdk(nodeModules)` loads an install an operator made, and only when what Node would load from it is pinned (Phase 1 finding S6).

- Each package is found the way Node finds it, from the file that imports it. The engine is found from the SDK's code, its common package from the engine's code, and the native binding from the engine's loader. The SDK, the engine, the common package and the binding must each be the pinned version.
- The binding's native file must match the sha256 in TS00's artifact manifest.
- A native file beside the engine's loader is refused, because that loader tries it before the binding.
- Only win32-x64 was qualified, so another platform is refused before anything is read.
- The engine's loader reads this process's environment. So `NAPI_RS_NATIVE_LIBRARY_PATH` or `NAPI_RS_FORCE_WASI` set there refuses the load, whatever a caller passes. Before AUDIT-02, a caller's environment that named either variable as `undefined` hid this process's value from the check. Each environment is now checked on its own, and an empty string counts as set.

The JavaScript is checked by version and the native file by hash, which is less than TS00's file-by-file pin of its probe install. The SDK is typed by shape, so the repository never imports it.

**Choosing.** `workspaceAdapterFor` picks the copy sandbox when no SDK is loaded or when the sub-task runs programs. `workspaceProcessExecution` reports that no program runs in a workspace, with the reason `server/trust/environments.ts` gives.

**The lease.** `lease.json` records the job, its fence, the base reference and the database name. It also holds the allowed paths, the source generation, the SDK versions, the state and the limits. A caller's copy is never trusted: each operation reads the lease from disk again. The lease on disk must also be the workspace the caller's lease names, with the same fence, database name and base reference. A lease for a workspace made again since is refused with `workspace_replaced`. It opens, hands back, copies and removes nothing of the new workspace, though both live in the same folder (S1).

**Asking again.** Asked again for a job with an open workspace, `materialize` returns it only when the scope and limits are the ones asked for. Otherwise it refuses with `workspace_spec_changed`, so asking again never widens a job's scope or limits (S4).

**Pinning.** Each file in scope is read once, kept under its sha256 and listed in `base.json`. The hash of `base.json`'s exact bytes is the base reference. A read of a pinned file is checked against its hash.

- Who may read the scope is read before the bytes and again after them. A change in between refuses the workspace with `workspace_source_changed`, so a lease records the generation its bytes were read under (S5). Until AUDIT-01, the lease kept a third read, taken after that check. So a change in the gap could bind bytes read under one generation to the next (Phase 2's O3). The lease now keeps the generation checked around the bytes. When the path guard leaves files out, the smaller set's generation is read before the final check.
- A file the path guard refuses, such as a link or a private name, is left out. Any other failure to read a file stops the workspace, so no file goes missing from a base unseen (O6).
- The new database is bound to its project, job and base reference in its own key-value store (S3).

**The database's name.** `delta-` and 16 random hex digits, new for every workspace made or opened, including one made again for the same job. The SDK facts below say why.

**The database's settings.** A database stores its own chunk size, and the SDK writes in chunks of whatever size it finds there. A size of one byte multiplies a write's rows and journal far past what the write reserved. A negative size never finishes a write. So a database whose chunk size is not the SDK's own 4,096 bytes is refused before it is used, with `workspace_delta_settings` (S3).

**One owner and one writer.** The assignment file holds `<job id>#<generation>`. The first `materialize` makes it, and `reassign` moves it. Both run under the Store's lock, so two reassignments never take the same generation (S2). Opening, writing, listing, copying and handing back each check the fence first.

One set of tools may write at a time. In this process a writer is held from before its lock file is made. So a second writer opened at the same moment is refused at once. Without that, the second could find the first's lock written but not yet held, take it for one left behind and take it over. That was found after round 2's mutation stage. A writer that fails to make its lock file holds nothing, so no later writer is refused for it. The lock file is made with an exclusive create, and names its process and a random nonce. Only the writer holding that nonce lets go of the lock, so tools that outlived their workspace never free the next one's writer. Each write also checks that its workspace is still the one its lease names (S1). A lock left by a process that is gone is taken over, and one held in this process or a live one blocks.

**Tools.** `list_project_files`, `read_project_file`, `write_file` and `propose_file`, with the copy sandbox's names and answers. Paths go through `relativeName` and the scope. A pinned file the route may not read stays hidden. Each write reserves its cost first, as the Limits section of the operations page describes.

**Hand-back.** `proposeOutputs` lists what changed against the base and returns the digest of that list. Changes and dropped names are listed in the code-unit order of their names. A locale's order can differ between hosts, and the digest covers the order, so every host lists them the same way (O5).

Listing also counts every plain file in the database by its actual bytes against the workspace's change budget. That includes unchanged copies of pinned files and files outside the scope. Past the budget, listing and hand-back refuse with `workspace_budget` before any write. So bytes written into the database around the tools cannot pass the tools' budget (AUDIT-03).

`promote` runs under the Store's lock and makes every check before its first write. It needs the current fence, a closed writer and an intact base. The digest and the bytes must match what was listed, and the source generation must match what was pinned. Each change then goes through `Store.writeRecorded` with the pinned sha as the expected version.

- The fence is read again before each write. The lock keeps this process's reassignments out, but another process can move the fence on disk. Writes made before it moved stay, each in History (S2).
- Each write is read back from History and from the project before it counts.
- A 409 whose current sha equals the new bytes counts as a write that already landed, as change sets do.

Then the workspace is spent. A change that waits for a person or meets a conflict carries the pinned sha it was made against and its own. A spent workspace takes no more writes but still opens to read, so a person can review such a change by its sha (S7).

**The Store's lock.** Reassigning, the first claim of a job, disposing, an import's final step and the whole hand-back run under the Store's lock. So a reassignment or a disposal asked for during a hand-back waits for it to finish.

The Store treats anything thrown inside its lock as its own failure. It reloads every project and interrupts every approval waiting to run (`recoverAndReload` in `server/store.ts`). A refusal, or a failure in a workspace's own files, leaves the Store as it was. So the adapter carries those out of the lock and throws them there (Phase 1 note O4). Only a failure inside `Store.writeRecorded` is thrown inside the lock, because it can leave the Store's state behind its files. The Store then reloads from disk. A retry recognises a change that landed by its bytes, and records each change once.

**Decision: a receipt that does not match is not a Store failure.** When History or the project does not hold the bytes just written, the hand-back stops with `workspace_receipt_mismatch`. That is thrown outside the lock, without the Store's recovery. The write returned, so the Store's state agrees with its own files. The mismatch is between what the adapter asked for and what landed. Reloading every project and interrupting every pending approval would not fix that, and would fail other people's work for it. The workspace stays open, and a retry meets the project as it is then.

O4 also suggested running the pre-write checks before taking the lock, so the lock is not held while a database is opened and walked. That is deferred. Checks made before the lock would have to run again under it, and the walk is bounded by the workspace's limits.

**Checkpoints.** `exportCheckpoint` needs the current fence and closed tools. It copies only into a folder of its own. A destination inside app data or any project's folder is refused, judged by real paths so a link cannot hide where it leads (O8). Project folders are read from the Store's registry as they are, without the project listing, which checks each folder and refreshes its counts. The destination must be empty. Export reserves disk space, copies the base list, every pinned file and the database with its journal files, then writes `checkpoint.json` last. A copy that fails removes what it wrote, and a folder it made (O1).

`importCheckpoint(source, job)` opens a checkpoint as the job its caller names, in that job's project, and refuses a checkpoint made for another (S3). Before anything is copied, it checks that:

- the checkpoint names this project and job, its workspace is not spent, and its fence names this job and a generation in the form this host writes;
- it was made with the SDK and engine versions this host runs;
- its base list matches the lease's reference and names the same project, job and scope;
- it fits this host's limits;
- each database file is the lease's database or one of its journal files, and every file is a plain file of its listed size and sha;
- who may read the sources is the same on this host as when they were pinned;
- the job has no other owner here and no workspace here.

The import then reserves disk space and copies each file through the same check again, so what lands is what was checked (O7). It opens the copy under a new database name, and checks that the database holds exactly the changes the checkpoint lists. Last, under the Store's lock, it checks the owner and the folder again. It writes the job's owner when this host has none, then the lease. If the lease cannot be written, an owner made for it is removed, since it would refuse the job's next owner. A refused or failed import leaves nothing of itself.

**Decision: an import takes this host's limits.** A checkpoint carries the limits it was made under, and the receiving host does not adopt them. An opened checkpoint gets this host's limits, and one larger than they allow is refused before anything is read or copied. Limits bound this host's disk and the work it runs, so they are this host's to set. A checkpoint is a file anyone can edit, so it cannot raise them for itself. An import also counts the database's files by their actual bytes against this host's change budget. It does so while it checks their hashes, before it publishes an owner or a lease (AUDIT-03).

Phase 1 also offered the tighter of each pair. That would keep a job's own smaller budget from its first host. It needs each limit taken in its own safe direction, since more free-disk headroom is the safer one. That choice belongs to the wiring, where the receiving loop can name a job's limits.

Two imports for one job at once in one process would copy into the same folder. The one that failed would then overwrite the other's base list or remove its files. While one import is under way, a second for the same job is refused with `checkpoint_destination_used`. This was found while the record was written, after Phase 1.

Checkpoints are not signed, so an import checks completeness and integrity, not who made it.

**Disposing.** `dispose(lease)` removes the workspace a lease names: its database, its pinned files and its lease. The job's owner stays. It runs under the Store's lock, and a lease for a workspace made again since removes nothing (`workspace_replaced`, S1). A lease whose job has moved to a newer owner also removes nothing. It is refused with the same `workspace_replaced`, where the other methods say `workspace_stale_assignment` (Phase 2's O2, open).

**Tool log.** `observations` returns each call's name, status and times, marked `trust: 'observation'`. It never returns arguments, results or errors, and reading it changes nothing.

**Encryption and sync.** `refuseUnsupportedModes` refuses encryption, sync or both by code before anything is made.

**Access.** No permission code changed. Full access still needs an isolated environment, and this installation has none. A lease always says `isolation: 'file-tools-only'`, so a workspace never stands in for isolation.

## SDK facts measured

All ran on win32-x64, on `agentfs-sdk` 0.6.4 over Turso 0.4.4, from scratch scripts in folders outside the repository. Every fact the adapter depends on is also a test, in the test file's real-SDK block "what agentfs-sdk 0.6.4 on Turso 0.4.4 does itself".

| Probe | Time | What it found | What the adapter does about it |
|---|---|---|---|
| 1 | 18:39Z | Windows paths open, and nested writes make their folders. Reads return bytes. A missing path throws ENOENT, and a write under a file throws ENOTDIR. `..` is not resolved, and a path without its leading slash reads the same file. A link can be made and `lstat` reports it, but reading it throws ENOSYS. The tool log records any call it is given. | Paths go through the project's own rules before the SDK sees them. Links are never read, written through or handed back. The tool log is read as observations only. |
| 2 | 18:47Z | A second connection to an open database can write, and the first sees it. A closed database left a 4,096-byte main file and a 280,192-byte `-wal` file. Copied together, they open with every file. The main file copied alone opens empty, with no error. | A hand-back reads every change again against the digest. Checkpoints copy every journal file. The disk cap counts journal files. |
| 3 | 19:15Z | Database files swapped on disk under a path this process had opened were not seen: the process kept answering from the old database. A child process saw the swapped files, and so did a path never opened. | This explained the first gate run's one real-SDK failure. A binding test that passed on the stand-in failed on the real SDK. |
| 4 | 19:16Z | A database removed with its folder and made again at the same path came back with the old rows before any write. After a write, a close and a reopen, the old file was still listed. The file on disk was 0 bytes. | With one fixed name, a workspace made again for a job would have shown the old job's edits. Its own writes would not have reached the disk. |
| 5 | 19:18Z | After the same removal, a new file name was clean: a 4,096-byte main file and a 197,792-byte journal. A database copied with its journal under a new name kept its rows. | Every workspace gets a new name. An import renames the database and its journal files together. An empty database file is refused. |

Two more facts came out of round 2 rather than a probe.

- **A folder goes while its database is open.** On Windows, the real SDK's database folder could be removed while a session still held the database open. The test of tools that outlived their workspace does exactly that, and passes. So disposal never waits on open tools, and those tools' next write is refused because their workspace is gone or replaced.
- **Reading writes to the database (Phase 1 note O3, from the SDK's source).** Every open of a database writes its schema version. Every read updates a file's access time. So reads, listings, `observations` and hand-backs grow the database's journal, and nothing reserves that growth. The tools' call budget bounds it, and the disk cap is measured before every write. Where this record says reading changes nothing, it means nothing in the Store or the run service. The database's own bytes do change.

## Acceptance

Each case runs twice, on the stand-in for the SDK (`tests/fixtures/agentfs-double.ts`) and on the real SDK when `NCTS_TURSO_NODE_MODULES` names its install. Test names are from `tests/agentfs-files-conformance.test.ts`.

| Case | Tests | What they show | Still unproven |
|---|---|---|---|
| TS-041 Parallel overlays | The four TS-041 tests. | Two jobs on one file each edit their own copy. The first change applies. The second is a conflict that names the current sha, and the first one's bytes stay. A second writer is refused until the first closes, on this host's instance and another's. Two writers opened at the same moment in one process get one writer between them, and a writer whose lock file could not be made holds nothing. | |
| TS-042 Incomplete delta | The three TS-042 tests, "a database made for another workspace is refused" and "a checkpoint opened again on the host it came from keeps its writes on disk". | A complete checkpoint opens on another host, reads files the job never touched and lists the same changes. One missing a pinned file, its base list or a database file is refused, naming what is missing. A file name or database name that would leave the checkpoint is refused before it is used. The job's database alone holds only what the job wrote. Another workspace's database is refused, even under the right name with lists rewritten to match it. A checkpoint opened again on its own host gets a new name, and its later writes reach the disk, even while this process still holds the old database. Round 2 added the tests under "a checkpoint opens only as the job it was asked for". A checkpoint opens only as the job its caller names, with an owner this host reads and agrees with, under this host's limits, and only where the same people may read its files. A file changed after the import checked it is refused as it is copied. A second import for a job while one is under way is refused, and the first stays whole. An export never lands in app data or a project's folder, even through a link. | Who made a checkpoint, since checkpoints are not signed. |
| TS-043 Oversized copy-on-write | The five TS-043 tests. | A few-byte change to a 320,011-byte pinned file costs the whole file. With 200 KB of budget it is refused before anything is written. A write is also refused when it would take the database past its size on disk, journal files included, or leave too little free disk. On the real engine, whose journal outweighs its database file, a cap just above that file alone refuses the first write. Pinning, copying a checkpoint and opening one reserve their disk space first. A scope over the limits is refused whole. Round 2: a database that stores another chunk size than the SDK's own is refused before it is used, and a checkpoint larger than this host's limits is refused before anything is copied. | |
| TS-044 Managed HOME escape | The three TS-044 tests. | Fourteen hostile paths are refused or not found, for reads and writes: parent folders, absolute paths, drives, UNC, `~`, environment variables, alternate data streams, device names and `.env`. A fake home holding a fake credential is never read. A file the route may not read stays hidden. No program runs, and a copy sandbox's processes get no home or credentials. | The operating-system boundary. None exists here, and the AgentFS command-line tool was not run. |
| TS-045 Encryption and sync | The three TS-045 cases. | Encryption with sync, encryption alone and sync alone are each refused by their own code, and nothing is made. | |
| TS-046 Late revoked output | The two TS-046 tests, and round 2's tests under "a lease opens only the workspace it was given", "the Store’s lock" and "pinning a base". | Once the job moves to a new owner, the old workspace cannot open, write, list, copy or hand back. A changed source generation stops the hand-back and leaves the workspace unspent. A lease for a workspace made again since opens, hands back, copies and removes nothing of the new one. Tools that outlived their workspace write nothing into the next one and never free its writer. A reassignment or disposal asked for during a hand-back waits for it. An owner change another process makes on disk stops the hand-back before its next write. A change in who may read the scope while it is pinned makes no workspace. | |
| TS-047 Upload replay | The two TS-047 tests, as an analog. | After an acknowledged hand-back, neither the tools nor a direct write to the database reach the project. The committed bytes, the History entry and the stored object stay as they were. An open writer blocks a hand-back. | Real upload links. Core Files object storage is not built. |
| TS-048 Audit versus effect | The TS-048 test. | A forged successful send and a forged charge in the tool log show as observations, without arguments, results or errors. History, needs, changes and tasks are unchanged. | |

The other tests cover the rest of the contract. Changes the loop may not apply wait for a person, with their reasons. Changes made after they were listed are refused. A hand-back retried after a crash is recognised by its bytes and recorded once. Names the project could not hold are refused or dropped. The copy sandbox stays the default, and its sweep leaves workspaces alone. An interrupted workspace is made again. A missing or empty database is refused, and a workspace made again for a job starts from its pinned base.

Round 2 added tests for the rest of Phase 1's findings:

- Asking again returns the same workspace only for the same scope and limits.
- Changes are listed in the same order on every host.
- A spent workspace still opens to read, so a waiting change can be reviewed by its sha.
- A file written into the database outside the scope, or under a name the project holds as a file, is refused by the tools and dropped on hand-back.
- A pinned file or the base list changed on disk is refused, never read as another, and a failed export leaves nothing.
- A file that cannot be read while it is pinned stops the workspace instead of going missing from it.
- A database bound to the same job and base in another project is refused.
- A write the Store fails partway makes the Store recover, and a retry records each change once. A write whose record names other bytes stops the hand-back without that recovery.
- The loader refuses overrides, an unqualified platform, another version of any package Node would load, a stray native file and a native file with another hash.

The integration added a regression for each of its three repairs, AUDIT-01 to AUDIT-03, described above. Its workers ran them on the stand-in only.

## Blocked proofs

| Proof | Why it is blocked | What clears it |
|---|---|---|
| An operating-system boundary for managed jobs (TS-044) | No isolated environment exists on this installation. | An isolated environment qualified under the trust work. |
| AgentFS mounts and `run` on any platform | The command-line tool was not downloaded or run. | Andrew approves downloading `agentfs-x86_64-pc-windows-msvc.zip` and running it in an isolated folder. |
| Real upload links (TS-047) | Core Files object storage is not built. | Object storage, then this case run against its links. |
| Redistribution of `agentfs-sdk` | No license text upstream (TS00). | The maintainers publish it. |
| The loop using workspaces | Its wiring sits in files that open PR 248 changes. | PR 248 lands, then a small wiring change. |
| Routing waiting changes to a person | Part of the same wiring. | The wiring above. |
| Who made a checkpoint | Checkpoints are not signed. | Signed checkpoints, if hosts start trading them. |
| Electron and darwin-arm64 | Neither was run. | The same tests in Electron and on a Mac. |
| A newer engine | The name rule answers Turso 0.4.4's in-memory reuse. | The real-SDK tests run again on the newer pair before its pin moves. |

Checkpoints made by an earlier draft of this patch, with a fixed database name, do not open now. None was ever shipped.

## Decisions for Andrew

1. **A 409 that matches the new bytes.** A hand-back can meet a 409 whose current sha equals its new bytes. It counts that as its own earlier write, as change sets do (`server/sandbox/change-sets.ts`). If a person wrote the same bytes on their own, the hand-back reports that write as its own and names their History entry. Phase 1 asked whether to keep this. It is unchanged, so the two paths behave alike until Andrew decides.
2. **Two workspaces made at once for one job.** Each `materialize` clears the job's folder before it pins, outside the Store's lock. The Store's file writer makes a missing parent folder again (`durableWrite` in `server/store.ts`), so a lease can be written into a folder another call just emptied. So of two calls for one job at the same moment, the later can clear the earlier's work. The earlier caller then gets an error, or a lease that opens nothing (`workspace_replaced`). No project file is written either way. A guard like the import's would refuse the second call instead, which changes the rule that asking again returns the same workspace. Found while this record was written, after Phase 1.

## Deferred, with reasons

- **O2, taking over a stale writer lock.** Within one process, a second writer opened at the same moment could take over the first's lock. That was found after round 2's mutation stage, and is fixed as "One owner and one writer" above describes. Across processes it stays open. Two processes taking over one stale lock at once can both believe they hold it. A partly written lock reads as live, and a reused process id can make a dead lock look live. Each case fails closed: a hand-back refuses while any writer looks live, and each write checks its lease. The Store serializes writes within one process only, so a second process on one data folder is outside what this patch claims. A takeover by atomic rename would close the race when the wiring needs it.
- **O4, checks before the lock.** Described under the Store's lock above.
- **E8, memory across many workspaces.** Measured in Phase 2 (Q11, under Verification). After warm-up, memory grew by a few kilobytes a cycle, which shows no leak.
- **Phase 2's O1 and O2.** No test covers the re-read check in `promote`, and `dispose` reports a newer owner with another code than the other methods use. Both are optional and go to a follow-up patch.

## Pillar impact

- **Pillar 09, trust as part of the architecture.** Revocation and assignment are checked at hand-back, and again before each write. The tool log is never a receipt. A workspace never claims to be isolation. A workspace's refusal never makes the Store interrupt approvals waiting elsewhere.
- **Pillar 14, source permissions through agents.** A file the route may not read stays hidden in the workspace. A change in who may read the sources stops the hand-back and stops a workspace being pinned. A checkpoint does not open on a host where they differ.
- **Pillar 12, one strong core.** The copy sandbox stays the default, and free local work is unchanged. AgentFS adds an option and takes nothing away.
- **Conflicts.** None found. The adapter pins a storage library's exact version and its native file's hash. Pillar 05's rule against version allowlists covers connected engines, and its 2026-09-27.2 amendment keeps artifact integrity, so it does not apply. Phase 1's review read it the same way and saw no owner decision needed. A newer SDK needs the same tests run again before its pin moves.

## Verification

Every run below took the coordination heavy slot first.

### Round 1

**First quick run, about 19:13Z.** tsc passed. On the stand-in, 27 tests passed, 3 failed and 32 were skipped. On the real SDK, 55 passed and 7 failed, of 62.

- Six failures, three on each SDK, were one test fault. A read-only session's run named write tools its registry did not hold. The test now names only the tools the session has.
- The seventh, on the real SDK only, led to probes 3 to 5 and the per-workspace name.

**Full run, 20:13:02Z to 20:31:10Z, slot slot_mv1ek4n1_71f0dcbf, on tree 96d5466a1d077b2014c947f5a2f7b39f320300c6.**

- tsc passed.
- The TS05 file on the stand-in: 33 passed and 37 skipped, of 70. The skipped tests need the real SDK.
- The same file on the real SDK: 70 passed, of 70.
- The full unit suite passed on its second run, 20:31:27Z to 20:41:28Z, under slot slot_mv1f7t0a_74a019ba: 623 files, 10,552 tests passed and 42 skipped. The first run lost one file to the install, not the patch. `tests/native-auth.test.ts` failed to load while another worker was still unpacking Electron's binary, and no test failed. The build ledger's step 17 has the detail.
- The vite build passed.
- Playwright on `tests/ui.spec.ts`, `tests/native-ui.spec.ts` and `tests/field.spec.ts`: 37 passed. It rewrote two committed screenshots, and both were put back.

**Mutation checks, in the same slot.** A script applied each one only when its pattern matched exactly once. After each, the module and the test file were put back and checked against their sha256. Each ran on the stand-in and on the real SDK. The counts are failed tests in each SDK's block. Every one was caught.

| Mutation | What it breaks | Stand-in | Real SDK | Caught by |
|---|---|---|---|---|
| M1 | Every workspace gets the same database name. | 1 | 1 | A workspace made again for a job starts from its pinned base. |
| M2 | An empty database file is opened. | 1 | 1 | A workspace whose database is missing or empty is refused. |
| M3 | An import keeps the checkpoint's database name. | 2 | 2 | TS-042's complete checkpoint, and a checkpoint opened again on the host it came from. |
| M4 | A database bound to another job or base is opened. | 1 | 1 | A database made for another workspace is refused. |
| M5 | A stale owner can copy a checkpoint. | 1 | 1 | TS-046, after the job moves to a new owner. |
| M6a | Pinning reserves no disk space. | 1 | 1 | TS-043, pinning, copying and opening each reserve first. |
| M6b | Copying a checkpoint reserves no disk space. | 1 | 1 | The same test. |
| M6c | Opening a checkpoint reserves no disk space. | 1 | 1 | The same test. |
| M7 | The database has no cap on disk. | 1 | 1 | TS-043, the database measured on disk. |
| M8 | Journal files are not counted on disk. | 0 | 1 | The same test, on the real SDK only. |
| M9 | A checkpoint copies the database without its journal files. | 0 | 4 | Both TS-042 checkpoint tests, the reservation test and the reopen test, on the real SDK only. |
| M11 | Any database name is accepted from a lease or a checkpoint. | 1 | 1 | TS-042, a checkpoint missing a file is refused. |
| R1 | M1, with its name assertion removed. | 0 | 1 | A workspace made again for a job, on the real SDK only. |
| R2 | M3, with the name checks taken out or changed to accept the kept name. | 0 | 1 | A checkpoint opened again on the host it came from, on the real SDK only. |

The stand-in keeps no journal and reads its file again on every open. So M8, M9, R1 and R2 can only show on the real engine. R1 and R2 show that behavior alone catches the two faults the engine finding is about. M8 and R2 are caught only by the two tests strengthened before this run, as the build ledger's step 15 describes. Without them, both faults would have passed.

The tree and the worktree's status were the same after each run as before it. The candidate given to review is that tree with this section and the ledger filled in, and no test reads either file.

### Round 2

**Phase 1 review, 20:46:02Z to 21:02:33Z.** The independent reviewer read candidate 2d05ec3a and ran nothing. It was the workflow's code-reviewer agent on Claude Opus 5.5, at high effort. Its verdict was to make specified corrections. The Design section above names each change by its finding, and the build ledger's step 20 lists them.

**Quick runs, each under its own slot.**

- 21:44:17Z, slot slot_mv1hth30_73c00a07. tsc failed on a quoting fault in the test file, and no test loaded.
- 21:44:54Z to 21:46:05Z, slot slot_mv1hu9t8_98b3aa27. tsc passed. Stand-in: 53 passed and 55 skipped, of 108. Real SDK: 108 of 108 passed.
- 21:50:51Z to 21:52:12Z, slot slot_mv1i1x5m_c3c46996. tsc passed. Stand-in: 54 passed and 56 skipped, of 110. Real SDK: 110 of 110 passed.
- 22:07:22Z to 22:08:56Z, slot slot_mv1in5qu_7a5715ae, with the import guard. tsc passed. Stand-in: 55 passed and 57 skipped, of 112. Real SDK: 112 of 112 passed.

**First full run, from 22:12:10Z, slot slot_mv1itbz3_77a4a793, on tree aee9c8383f99184128c71e804541900716aa0fb9.** tsc passed. The TS05 file: 61 passed and 63 skipped of 124 on the stand-in, and 124 of 124 on the real SDK. All 52 mutations were caught. The full unit suite passed: 623 files, 10,580 tests passed and 68 skipped. While the mutations ran, a read of the writer lock found the race that "One owner and one writer" describes. So the run was ended before the build, and the fix went in.

**Final run, 23:15:46Z to 00:01:13Z on 10 October, slot slot_mv1l35jk_e9b6890a, on tree 9e4a888a4fc3b568b498b7832327bb25d5c828b1.**

- tsc passed.
- The TS05 file on the stand-in: 63 passed and 65 skipped, of 128. The skipped tests need the real SDK.
- The same file on the real SDK: 128 of 128 passed.
- The full unit suite passed: 623 files, 10,582 tests passed and 70 skipped. Its totals differ from round 1's only by this file's own counts, because its real-SDK block is skipped there.
- The vite build passed.
- Playwright on the three named specs: 37 passed. It rewrote two committed screenshots, and both were put back.

**Mutation checks, in the same slot.** The method is round 1's, and so are the counts: failed tests in each SDK's block. The loader's tests run outside both blocks, so their counts are given in the last column. Every one was caught.

| Mutation | What it breaks | Stand-in | Real SDK | Caught by |
|---|---|---|---|---|
| M1 | Every workspace gets the same database name. | 3 | 5 | a workspace made again; an old lease; tools that outlived their workspace; TS-046, a new owner; two imports at once |
| M2 | An empty database file is opened. | 1 | 1 | a missing or empty database |
| M3 | An import keeps the checkpoint's database name. | 2 | 2 | TS-042, a complete checkpoint; a checkpoint reopened where it was made |
| M4 | A database bound to another job or base is opened. | 2 | 2 | another workspace's database; another project's binding |
| M5 | A stale owner can copy a checkpoint. | 1 | 1 | TS-046, a new owner |
| M6a | Pinning reserves no disk space. | 1 | 1 | TS-043, reserving first |
| M6b | Copying a checkpoint reserves no disk space. | 1 | 1 | TS-043, reserving first |
| M6c | Opening a checkpoint reserves no disk space. | 1 | 1 | TS-043, reserving first |
| M7 | The database has no cap on disk. | 1 | 1 | TS-043, the disk cap |
| M8 | Journal files are not counted on disk. | 0 | 1 | TS-043, the disk cap, on the real SDK only |
| M9 | A checkpoint copies the database without its journal files. | 0 | 11 | TS-042, a complete checkpoint; TS-042, the database alone; TS-043, reserving first; a checkpoint reopened where it was made; an import as another job; an import's owner; a minted owner taken back; an import under this host's limits; when a checkpoint may be copied or opened; two imports at once; an import's read rights, on the real SDK only |
| M11 | Any database name is accepted from a lease or a checkpoint. | 1 | 1 | TS-042, an incomplete checkpoint |
| R1 | M1, with its name assertion removed. | 2 | 5 | an old lease; tools that outlived their workspace; TS-046, a new owner; a workspace made again; two imports at once |
| R2 | M3, with the name checks taken out or changed to accept the kept name. | 0 | 1 | a checkpoint reopened where it was made, on the real SDK only |
| Ma | S1: a lease is not compared with the workspace on disk. | 2 | 2 | an old lease; tools that outlived their workspace |
| Mb | S1: disposal removes whatever workspace the folder holds. | 1 | 1 | an old lease |
| Mc | S1: a writer lets go of any lock, not only its own. | 1 | 1 | tools that outlived their workspace |
| Md | S2: reassignment runs outside the Store's lock. | 1 | 1 | a reassignment during a hand-back |
| Me | S2: disposal runs outside the Store's lock. | 1 | 1 | a disposal during a hand-back |
| Mu1 | O4: a failure in the Store's writer is carried out of the lock, so the Store never recovers. | 1 | 1 | a Store write that fails |
| Mu2 | O4: every failure is thrown inside the lock, so the Store recovers for each refusal. | 2 | 2 | a Store write that fails; a receipt that does not match |
| Mf | S2: the fence is not read again before each write. | 1 | 1 | an owner change from another process |
| Mg | S3: an import opens as whatever job its checkpoint names. | 1 | 1 | an import as another job |
| Mh | S3: an import ignores the owner this host has for the job. | 1 | 1 | an import's owner |
| Mi | S3: an import accepts a fence in any form. | 1 | 1 | an import's owner |
| Mj | S3: an owner minted for a failed import is kept. | 1 | 1 | a minted owner taken back |
| Mt | S3: an import keeps the limits its checkpoint carries. | 1 | 1 | an import under this host's limits |
| Mn | S3: the database binding is not checked for the project. | 1 | 1 | another project's binding |
| Mk | S4: asking again ignores the scope and limits asked for. | 1 | 1 | asking again |
| Ml | O5: changes are sorted in the locale's order. | 1 | 1 | code-unit order |
| Mm | S3: a database that stores another chunk size opens. | 1 | 1 | another chunk size |
| Mo | S6: the native file's hash is not checked. | 0 | 0 | the loader: the engine's own imports (the loader's tests: 1 in the stand-in run, 1 with the real SDK) |
| Mp | S6: a native file beside the engine's loader is ignored. | 0 | 0 | the loader: the engine's own imports (the loader's tests: 1 in the stand-in run, 1 with the real SDK) |
| Mq | S6: only the environment passed in is read, not this process's. | 0 | 0 | the loader: overrides (the loader's tests: 1 in the stand-in run, 1 with the real SDK) |
| Mr | S6: the engine's common package is not checked. | 0 | 0 | the loader: the engine's own imports (the loader's tests: 1 in the stand-in run, 1 with the real SDK) |
| Ms | S6: any platform falls back to win32-x64's pins. | 0 | 0 | the loader: platforms (the loader's tests: 1 in the stand-in run, 1 with the real SDK) |
| Mw | S7: a spent workspace refuses readers too. | 1 | 1 | a spent workspace opens to read |
| Mv | E2: a checkpoint's database file names are used as paths unchecked. | 1 | 1 | TS-042, an incomplete checkpoint |
| Mx | O1: a failed export leaves what it copied. | 1 | 1 | a pinned file or base list changed |
| My | O8: an export may go into app data or a project's folder. | 1 | 1 | where a checkpoint may go |
| Mz | O8: the export destination is judged without following links. | 1 | 1 | where a checkpoint may go |
| Na | A second import for a job runs while the first is under way. | 1 | 1 | two imports at once |
| Nb | S5: who may read the scope is not read again after pinning. | 1 | 1 | read rights change while pinning |
| Nc | An import does not check who may read its files on this host. | 1 | 1 | an import's read rights |
| Nd | O6: a file that cannot be read while pinning is left out. | 1 | 1 | a file unreadable while pinning |
| Ne | O7: an import copies files again without checking them. | 1 | 1 | a checkpoint changed while copied |
| Nf | E3: a pinned file is used without its hash checked. | 1 | 1 | a pinned file or base list changed |
| Ng | E3: the base list is used without its hash checked. | 1 | 1 | a pinned file or base list changed |
| Nh | Claim 9: a write's record is not checked against the bytes it was given. | 1 | 1 | a receipt that does not match |
| Ni | E5: a file under a name the project holds as a file is handed back. | 1 | 1 | a file where the project has a file |
| Nj | E4: a checkpoint is copied while its tools are open. | 1 | 1 | when a checkpoint may be copied or opened |
| Nk | E4: an import ignores a newer fence this host holds for the job. | 1 | 1 | when a checkpoint may be copied or opened |
| Nl | A writer is held in this process only once its lock file is made. | 1 | 1 | TS-041, two writers at once |
| Nm | A writer that fails to make its lock file keeps its hold. | 1 | 1 | TS-041, a lock file not made |

- Nl and Nm ran first, and each was caught by the test written for it.
- R1 now fails on the stand-in as well. Its two failures there are S1's tests, under "a lease opens only the workspace it was given", which tell workspaces apart by their database names. In round 1 it showed on the real engine only.
- Under M1 and R1 every workspace shares one database name. So on the real engine, a test can meet a database an earlier test left in memory. The count then depends on the order tests ran in. M1 failed 4 real-SDK tests in the first full run and 5 here. Both runs caught it.
- M8, M9 and R2 still show on the real engine only. The stand-in keeps no journal and reads its file again on every open.
- There is no M10. The numbering skipped it, and no mutation was removed.

The tree and the worktree's status were the same after the run as before it. The candidate given to Phase 2 is this tree with this section and the ledger filled in. `git diff --stat` between the two names only this record and the ledger, and no test reads either.

### Phase 2

**Phase 2 review, from about 00:08Z to 03:14Z on 10 October, on candidate 9ea1870dc57d48a3a88fa37765af49432850e068.** Its digest, the sha256 of `git diff --binary 92bc57b 9ea1870`, is e26b6438851610b2f517e73d233b6509d8803854295c6eae780bbe19348c74d5. The same reviewer as Phase 1 ran it in a worktree of its own, under the heavy slot, and paused between 00:46Z and 02:14Z. It changed no file of the patch.

- tsc passed. The TS05 file on the stand-in: 63 passed and 65 skipped, of 128. On the real SDK: 128 of 128 passed.
- Its reproductions: on the stand-in, 16 passed and 15 skipped; on the real SDK, 30 passed and 1 skipped. P1 to P3 retry a hand-back after a failed write and race two hand-backs. Q1 to Q10 reproduce each of Phase 1's findings S1 to S7, and each passed. Q11 made and disposed of a workspace 200 times on the real SDK. After warm-up, memory grew by a few kilobytes a cycle, which shows no leak (E8).
- All 54 of the builder's mutations were caught on both SDKs. So were 11 of the reviewer's own 13, Va to Vl. Ve survived and changes nothing: it removes an early owner check in `importCheckpoint`, and the same check runs again under the Store's lock. Vi1 survived because no test covers the re-read check in `promote` (O1).
- Verdict: accept, with three optional notes. O1: a test whose database returns other bytes on a second read, expecting `workspace_outputs_changed`. O2: `dispose` names a newer owner `workspace_replaced`, where the other methods say `workspace_stale_assignment`. O3: `pinBase` kept a generation read after its check, which AUDIT-01 had already fixed on main.
- Not rerun by the reviewer: the full unit suite, the build and Playwright. The candidate differs from the gated tree 9e4a888a only in this record and the ledger.

### On main

The performance-audit integration fast-forwarded main to 6b38ffc at 03:01Z on 10 October. It took 9ea1870 as a prerequisite and added three repairs to this module and its tests. AUDIT-01 (b42c85e) keeps the generation checked around pinned bytes. AUDIT-02 (23daef9) checks the loader's two environments apart. AUDIT-03 (55227d5) applies the change budget at listing, hand-back and import. Each repair's note, under `docs/implementation/2026-10-09-performance-audit/`, gives its reason and its failing and passing runs.

- The integration's record says its parent ran tsc, the full unit suite, the build and the three browser specs on the combined candidate before the fast-forward. It gives no counts, and this record restates none.
- The integrator reviewed the repairs. This packet's reviewer has not.
- Each repair's worker ran the TS05 file without `NCTS_TURSO_NODE_MODULES`, and no run of its real-SDK block on main's code is recorded. That run comes first in the ledger's next steps.

## Publication boundary

Authored, implemented and gated on tree 9e4a888a. Independently reviewed: Phase 1 asked for corrections, which are made and gated, and Phase 2 accepted candidate 9ea1870. Integrated into main at 6b38ffc through the performance-audit integration, with three repairs that its integrator reviewed and this packet's reviewer has not. Not deployed: Workers Builds skipped the merge. Not released.

Not DONE, for four reasons. The repairs on top have had no review in this packet, and no run of the real-SDK block on main's code is recorded. O1 and O2 are open, and the proofs under Blocked proofs remain. TS05 cannot ship until the SDK's license text exists, and the loop cannot use it until PR 248 lands.
