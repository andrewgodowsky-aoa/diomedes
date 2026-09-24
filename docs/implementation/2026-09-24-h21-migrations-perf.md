# H21: migrations, crash recovery, a performance gate and the completion journey

Linear DIO-26. Branch `feature/h21-migrations-perf-gate`, from `integration/overnight-batch-3`
with `origin/main` merged in. Before this, the audit found SSE backpressure and crash-recovery tests
(`server/store.ts` journal and recovery, `tests/*recovery*`, `server/harness/run-store.ts`). Four
things were missing before H21 could be called done: versioned migrations, a crash matrix, a
performance gate and the completion journey. This record covers all four.

## What is implemented

### 1. One migration framework (`server/migrations/`)

- **`framework.ts`** is pure. A `DurableFamily` names:
  - the version field;
  - the version this build writes (`current`) and the oldest it still reads;
  - the version a record *without* the field reads as (`unversioned`, or null to refuse it);
  - one migration per step, `n → n + 1`.

  `migrateRecord` carries a record forward one step at a time. It never mutates its input, and it
  returns a current record as the same object. `assertReadable` only checks whether a record can be
  read. The refusals are typed (`MigrationRefusal`) and each says in plain words what was refused
  and that nothing was changed:
  - `newer-version`
  - `unknown-version`
  - `retired-version`
  - `not-a-record`
  - `missing-migration`
  - `invalid-migration`: a step that did not produce the next version.

  `familyProblems` checks the registry itself: every step from `oldest` to `current` is present,
  and there are no stray steps.
- **`files.ts`** holds `openVersionedFile`.
  - An absent file gives `null`.
  - A current file is returned as it is and never rewritten.
  - An older file is first copied, byte for byte, to a backup beside it:
    `<file>.v<from>.<sha256 prefix>.bak`. Only then is the file replaced by its migrated form,
    through the one durable write (temp file, fsync, rename). The replace re-checks that the file
    still holds the bytes that were migrated, so a concurrent writer is never overwritten.
  - The backup's name comes from its content. A process stopped between the two writes therefore
    leaves a backup that the next open finds and reuses, and then finishes the rewrite.
  - Backups are never deleted automatically (decision 10).
  - A backup of the same name but with different bytes stops the migration, and the file is left
    untouched.
  - A newer or unknown version, or JSON that cannot be read, is refused, and the file is left byte
    for byte as it was.
  - Backups end in `.bak`. Every directory reader that lists `*.json` (occurrences, definitions,
    runs) therefore never mistakes one for a record.
- **`registry.ts`** lists every durable family (`DURABLE_FAMILIES`), with its location, version
  field, current version and reader. The families read through the framework are:

  | Family | File | Current | Wiring |
  |---|---|---|---|
  | `settings` | `settings.json` | 1 | `Store.init` / `recoverAndReload`: `assertReadable` before `migrateSettings`. A newer file stops the service with the file untouched. |
  | `project-state` | `projects/*/state.json` | 1 | Now **stamped** `schemaVersion: 1` by `Store.persist`. A file without the field (every file before H21) reads as 1. The field is dropped on load, so the in-memory `ProjectState` shape does not change. A newer file stops the service with the file untouched. |
  | `harness-run` | `projects/*/harness/runs/*.json` | 1 | `FileRunStore.read` goes through `migrateRecord`. The refusal keeps its code, `unsupported_run_version`. |
  | `automation-occurrences` | `workspaces/automations/*.json` | 2 | `openVersionedFile` at `init`. A Milestone A (v1) file is backed up and carried to v2 when it is opened, instead of being read as v1 and rewritten on the next `put` with no backup. A newer file is marked unreadable and left alone, as before. |
  | `automation-definitions` | `workspaces/automations/definitions/*.json` | 1 | `migrateRecord` at `init`. A refusal marks the file unreadable, as before. |
  | `pack-store` | `packs/store.json` | 1 | `migrateRecord` in `load`. The refusal keeps its code, `unknown-store-version`, and its message. |
  | `ready-queue` | `ready-queue.json` | 1 | `assertReadable` before the schema parse, so a newer file is refused by name instead of "unreadable". |

  **Still checking their own version** (in the registry with `throughFramework: false`, a reader
  file and a note):

  | Family | Why it is not wired |
  |---|---|
  | `project-registry` (`registry.json`) | A bare array with nowhere to carry a version. It needs an envelope before its first bump. |
  | `write-journal` (`pending/*.json`) | Short-lived, and recovery removes it. Its embedded project record is checked by the state validators. |
  | `automation-host` | **Behaviour gap:** an unreadable or newer host record is *replaced* by a new one. It holds only a host id and a heartbeat, but a newer build's file would still be overwritten. The proposed fix is to refuse a `v > 1`; that changes scheduler start-up behaviour, so it is recorded here and not made tonight. |
  | `job-caps`, `managed-allowance`, `workspace-configuration`, `spend-exposure`, `discovery` | Each refuses any `v !== 1` in its own words. Wiring each is mechanical, but their refusal wording and their tests belong to other lanes. |
  | `change-review`, `customization-benefit`, `billing-events` | Written as `v: 1`. The version is not checked on read. |
  | `engine-bindings`, `engine-verification`, `approved-read-servers`, `aws-bedrock-connection` | Validated by a zod schema with a literal version, so a newer file is refused as malformed rather than as newer. |

  Remembered approvals, control receipts, verification records and Ready-queue claims are records
  **inside** `state.json`, so the `project-state` family covers them.
- **Golden fixtures** in `tests/fixtures/migrations/`:
  - `project-state.pre-h21.json` was written by the pre-H21 build (`integration/overnight-batch-3`
    head) through `Store.createProject` and `writeRecorded`, with no `schemaVersion`.
  - `settings.v1.json` comes from the same run, and `settings.v1-0.1.8.json` has the retired
    Workbook keys and the `history` block.
  - `automation-occurrences.v1.json` is a Milestone A file, and `…v2.expected.json` is its exact
    migrated form.
  - There are also `pack-store.v1.json`, `ready-queue.v1.json` and `automation-definitions.v1.json`.

  No historical project-state, settings or run fixture existed in the repository before this, so
  these are the oldest versions that could be found or reproduced.

### 2. Crash-recovery matrix (`tests/crash-matrix.test.ts`)

A real child process (`tests/crash-matrix-child.ts`, run with `node --import tsx`) does three
things:

1. It performs one operation and acknowledges it with a line in `acks.jsonl`, written and fsynced.
2. It starts a second operation.
3. At the named boundary, it `SIGKILL`s itself. There is no `close()`, no `finally` and no flush.

The parent checks that the child died there: a `reached` marker plus the signal (on Windows, a
non-zero exit). It then restarts the same data folder.

| Boundary | What was in flight | Pinned outcome after restart |
|---|---|---|
| `object-write` | history object for the new text, renamed | not applied |
| `journal-append` | `pending/*.json`, renamed | applied once (roll forward) |
| `project-file` | the project file, renamed | applied once |
| `state-temp` | `state.json` temp written, not renamed | applied once (from the journal) |
| `state-rename` | `state.json` renamed, journal still there | applied once |
| `journal-unlink` | journal removed, call not returned | applied once |
| `occurrence-temp` | occurrence file temp, not renamed | second occurrence absent |
| `occurrence-rename` | occurrence file renamed | both present, once each |
| `migration-backup` | v1 → v2 migration, backup written | next open finishes it; one backup, identical to the original bytes |
| `migration-rewrite` | v1 → v2 migration, rewrite renamed | v2, one backup |
| `claim-temp` | Ready claim in `state.json` temp | the task starts exactly once after restart |
| `claim-rename` | Ready claim durable, no session yet | the claim is admitted once, and its session carries the claim's command id |

Every project-write row also asserts the following:
- nothing is left in `pending/`;
- every History `before`/`after` object exists and matches its digest;
- History ids are unique;
- the acknowledged write is recorded exactly once;
- the file on disk equals the newest record's `after`;
- a second restart changes nothing.

As a mutation check, removing `await this.recover()` from `Store.init` turns four rows red
(`journal-append`, `project-file`, `state-temp`, `state-rename`).

### 3. Performance gate (`scripts/perf-gate.ts`, `npm run perf:gate`)

The gate is deterministic in its data, not in its timings.

**Dataset.** `scripts/perf-gate-seed.ts` makes one real project through `Store`:
- `createProject`;
- two `writeRecorded` calls, so there is a real `modified` entry;
- a real task.

It then gives the project a fixed id and clones those records with fixed ids, timestamps one minute
apart, fixed contents and fixed mtimes. The full dataset is 10,000 History entries, 2,000 files
(40 folders of 50) and 500 tasks; it seeds in about 0.5 s. `--small` is 500 entries, 100 files and
50 tasks.

**Metrics.** Each is the median of `--runs N` (default 5), taken after one warm-up.

| Metric | What is timed |
|---|---|
| `coldStart` | Spawn `node --import tsx server/index.ts` until `GET /api/settings` answers 200. This includes the tsx transpile. |
| `projectStateLoad` | In-process `new Store(...).init()` over the big project. This includes the re-persist with fsync that `init` does. |
| `filesList` | `GET /api/projects/:id/documents`. The route walks the folder on every call. |
| `historyPage` | `GET /api/projects/:id/history`. **The endpoint has no pagination**, so this is the full History response. |
| `boardProjection` | There is no server Board route. This times `GET /api/projects/:id/state`, then the parse, then the client's pure `taskEvidence` for every task and `planGroups`, which is what `BoardView` consumes. |
| `sseFanout` | 50 raw HTTP clients on `/api/events`. One `POST /tasks` is sent, and the time runs until every client has the `projects` frame that ends that fan-out. |

**Thresholds.** A metric fails when its median is more than `max(baseline × factor,
baseline + 250 ms)`. The factor defaults to 2. The 250 ms floor keeps a small metric from flapping
on scheduler noise. A metric with no baseline is reported as `new` and does not fail, and neither
does a baseline metric the run no longer measures. A baseline recorded for a different dataset size
turns every metric into `new`.

**Flags.** `--record` rewrites `scripts/perf-baselines.json`, and is refused together with
`--small`. The others are `--json <path>`, `--factor F` and `--small`.

**Clean-up.** Service children and the temp folder under `test-results/perf-gate-<pid>/` are removed
on exit, on a signal and on an error.

**Baselines** (`scripts/perf-baselines.json`), recorded on linux x64 with 4 CPUs and Node 22.22.2:

| Metric | Median ms | Fails above |
|---|---|---|
| coldStart | 1699.5 | 3399.0 |
| projectStateLoad | 118.8 | 368.8 |
| filesList | 117.7 | 367.7 |
| historyPage | 120.2 | 370.2 |
| boardProjection | 187.7 | 437.7 |
| sseFanout (50 clients) | 4486.1 | 8972.2 |

Two later full runs passed. The first measured 1602.3, 112.3, 116.2, 111.3, 155.1 and 3994.8 ms;
the second measured 1524.9, 123.4, 90.4, 95.2, 147.8 and 3878.1 ms.

**Finding: SSE fan-out is the slow path.** It takes about 4 to 7.5 s for 50 clients on the big
project. On every change the `/api/events` listener sends the **full** `statePayload` to each client
separately, and that payload holds all 10,000 History entries. It then sends `tasks` and `history`
again. The `POST` that caused the change waits for this, because `persist` emits `change`
synchronously. It is also the noisiest metric: one early run on a loaded machine gave 7569 ms, close
to the 8972 ms threshold. The proposed follow-up is to send a change notice or a delta over SSE and
let clients fetch what they show, or to paginate History. That is a separate slice, not done here.

**Baselines are per machine.** CI runners should record their own baselines before the gate
blocks; see the proposed CI wiring below.

### 4. Completion journey (`tests/completion-journey.spec.ts`, `npm run test:journey`)

The spec has its own config, `playwright.journey.config.ts`. It has no shared dev server and is not
in the main `testMatch`. The spec owns its service:
`node --import tsx server/index.ts --production`, serving the built `dist/`. It runs on a free port
(never 5174 or 47632), with a fresh data folder under `test-results/`.

It walks this journey:
1. A fresh install with 0 projects.
2. First run in the UI: detail, permissions, "Skip AI setup".
3. A new project, created in the UI.
4. A task from the Board, and Start: a sample session.
5. "Go ahead for this whole task", so the run reaches `done` with one waiting change and its
   `changed` History entry.
6. The change review: "What changed", "1 file changed", and the added text.
7. A declared `file-exists` check, then "Run checks", then **Verified**.
8. Keep, via the API.
9. SIGTERM (exit 0), then a new process on the same data folder, then a reload.
10. After the restart, all of these must hold:
    - the project is listed;
    - the Board still reads Verified, and so does the thread record, with the same evidence;
    - the change review is unchanged;
    - the task is `done` and the change is `kept`;
    - the same History entry is present;
    - the file on disk is byte for byte what was approved.

It passed 3 times in a row, in about 17 s each.

**Gap:** keeping a waiting change goes through `POST /review/:changeId` because the Console has no
Keep or Undo control. `reviewChange` in `client/console/Shell.tsx` has no caller; `tests/ui.spec.ts`
F15 takes the same route. The Console's History screen was removed on 2026-09-23, so the History
entry is checked through the change review's `history-entry` reference and the state API.

## Decisions taken conservatively (Andrew's to confirm)

1. **A newer settings or project file stops the service.** The file is left untouched, and the
   message names the version. The alternative, reading it anyway, could rewrite fields this build
   does not understand, which decision 10 forbids for evidence.
2. **Project state is stamped from now on** (`schemaVersion: 1`). Without the stamp, a future
   version 2 file could not be refused by this build.
3. **A migration writes its backup beside the file and never deletes it.** Deleting backups is a
   data-lifecycle decision, so it is not a switch (decision 10).
4. **Occurrence files migrate when they are opened, not on the next write.** This makes the backup
   possible. A Milestone A build then refuses the migrated file, which it already did after the
   first write from Milestone B on.

## Tests

- `tests/migrations.test.ts`: 42 tests covering the registry, pure migration, the golden fixtures,
  `openVersionedFile` (backup, idempotence, stop between writes, refusal with the file untouched)
  and each wired reader end to end. Before the wiring, 5 of them were red.
- `tests/crash-matrix.test.ts`: 12 rows.
- `tests/perf-gate.test.ts`: 8 tests. Seven cover the comparison: the median, passing under the threshold, failing over 2×, the floor, new and missing metrics, no baseline file, and flag parsing. The eighth seeds `--small` and checks that `Store.init()` accepts it. The test was written first and was red (module not found) before the implementation existed.
- `tests/completion-journey.spec.ts`: 1 Playwright journey.

## Proposed canonical-doc patch

**Project Memory** (`docs/DIOMEDES_PROJECT_MEMORY.md`), in the section on evidence and durable
records, add:

> **Versioned durable records.** Every file Diomedes keeps in its data folder belongs to a registered
> family with a schema version (`server/migrations/registry.ts`). A build reads its own version,
> carries an older file forward one version at a time and keeps a byte-for-byte backup beside it,
> never deleted automatically, and refuses a newer file without changing it. A newer project or
> settings file stops the local service with the reason, rather than being read by a build that
> cannot understand it.

**Live Roadmap** (`docs/DIOMEDES_LIVE_ROADMAP.md`), in the H21 row or the harness completion clause,
record that H21 is implemented:
- versioned migrations through one framework, with 7 families wired and the rest listed;
- a crash matrix of 12 boundaries;
- `npm run perf:gate` with recorded baselines, not yet in CI;
- the completion journey, `npm run test:journey`, not yet in CI.

Also record the open follow-ups: wiring the listed families, the automation-host refusal, a CI job
for the perf gate and the journey, and a Console Keep/Undo control.

**Core Pillars:** no change.

**Proposed CI wiring (not done tonight):**
- A `perf-gate` job on `ubuntu-latest` running `npm ci`, then `npx tsx scripts/perf-gate.ts --runs 5`.
  It would be non-blocking for two weeks while baselines per runner are recorded. After that it
  would block, with `--factor 2`.
- A `journey` job running `npx vite build`, then `npm run test:journey` on Windows and macOS.

## PILLAR IMPACT

Evidence durability, via decision 10, is advanced. A newer build's records can no longer be
silently misread or rewritten by an older build in the seven wired families. Every migration keeps
the old bytes. The crash matrix proves that no acknowledged write is lost or duplicated at any of the
tested boundaries. No conflicts.

## ROADMAP IMPACT

H21 (DIO-26): versioned migrations, the crash matrix, the performance gate and the completion
journey are implemented and tested on this branch. H21 is DONE subject to review. The follow-ups
listed above do not block it.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

There is a draft PR against `main`, which is not merged. There is no version bump, no change to the
native-runtime hashes and no packaging. Gate counts are in the PR description.
