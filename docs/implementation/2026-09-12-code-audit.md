# September 12 code audit: what scales with the project, what is duplicated, what is dead

September 12, 2026. One pass over `server/`, `shared/`, `client/` and `desktop/` at `da84689`
(current `main` when the pass started), reading for request-path work that grows with
project or history size, process and stream handling in the engine adapters, render cost in
the Console, duplicated helpers, error handling, typing, and dead code. Line numbers below
are as of `da84689`; the cleanups in §8 move a few lines in the files they touch.

Every file under the four directories was opened. Where a number is given it was measured;
where a finding says "read" it was not timed. Nothing in `docs/DIOMEDES_*.md`, `AGENTS.md`,
`evidence/`, `scripts/`, the workflow or any CSS file was touched.

## 1. Method

Reading: every `.ts`, `.tsx` and `.mjs` under the four directories, in dependency order
(`shared/` and `server/store.ts` first, then routes, engines, harness, team, trust,
connections, then the Console, the Workbook and the desktop shell). The six September 11
records and the integration record were read first so the pass knew which code was days old.

Measuring: a throwaway Vitest file (not committed; the tree is clean of it) drove the real
`Store` and pure functions with synthetic states. Sizes were chosen to bracket a project that
has been used for months: 1k, 5k, 20k and 50k History entries; 0, 10 and 50 waiting changes.
The machine was otherwise idle apart from two unrelated agents. Numbers are means of 20
to 2000 repetitions after one warm-up call; treat them as order-of-magnitude, not as a
benchmark suite.

React render cost was not measured. There is no render profiler in the test harness, and
the brief said to memoize only where measured, so the Console findings below are call-site
counts, not milliseconds.

## 2. High

### 2.1 `GET /api/projects/:id/state` reads every waiting change from disk and clones the whole state

`server/store.ts:1456–1491` (`projectState`). For each change in `state.changes` it awaits
`this.current()` (a file read, line 1469), calls `latestFile` (line 1472) and hashes the
current text up to three times (lines 1475, 1478). It then `structuredClone`s the entire
state including History (line 1488).

Measured with a real `Store`, 5,000 History entries:

| waiting changes | `projectState` per call |
|---|---|
| 0 | 13 ms |
| 10 | 39 ms |
| 50 | 110 ms |

The 13 ms floor is the clone (14 ms for a 3.8 MB state measured separately; 63 ms at
20,000 entries) plus `refreshCounts` (§3.1). Each waiting change adds about 2 ms of file
read and hashing. Every client refetches this route after every SSE event while a run is
streaming (`client/console/Shell.tsx:265–282`, debounced 70 ms), so with a run writing
files and two Console windows open the service does this work several times a second.

Why it matters: this is the one route every screen depends on. A project with fifty
unreviewed changes and a long History pays over 100 ms of server time per refresh, before
the JSON is serialized or the client parses it.

Fix (contract change, not applied): compute `changedSince` when a change is created and
when the folder watcher reports a write, not on every read; keep `current` out of the
state route (the review pane already fetches the diff it shows); paginate History behind
its own route so `state` carries the last N entries. Until then, the cheap local win is to
skip the file read when `fs.stat` mtime and size match the last read.

### 2.2 The SSE fan-out serializes the whole state twice per change per client, and no client reads it

`server/app.ts:2359–2394`. On every `change` the listener sends a `state` event carrying
`statePayload(state)`, then nine slice events each carrying its slice, then `projects`.
The Console (`client/console/Shell.tsx:271–282`), the landing page (`client/App.tsx:142`)
and the Workbook (`client/Workspace.tsx:201`) register the same handler on every event name
and ignore `event.data`; each of them debounces a `GET state` refetch.

Measured, per connected client, per change:

| History entries | state bytes | `JSON.stringify` cost (state + slices) |
|---|---|---|
| 1,000 | 1.1 MB | 2.6 ms |
| 5,000 | 3.8 MB | 9.3 ms |
| 20,000 | 14 MB | 36 ms |

So at 5,000 entries every recorded write costs 9 ms of CPU and pushes 7.6 MB through the
socket for each open window, and the bytes are discarded on arrival. A run that records
twenty files in a minute with two windows open moves 300 MB.

Fix (API shape, not applied): send `{ projectId }` only; the clients already treat every
event as "something changed, refetch". If any consumer does need a slice, send that slice
and nothing else. A one-line change on the server and none on the clients, but it is a
change to what `/api/events` delivers and belongs in a slice with its own record.

### 2.3 The Files pane re-walks the project folder under the store lock on every state event

`client/console/Shell.tsx:363–390`: while the Files pane or the palette is open the effect
re-runs on every new `state` object and calls `listDocuments`. `server/app.ts:1008–1011`
routes that through `route()` with the default `locked = true` (`app.ts:654–657`), and
`server/store.ts:689` (`listDocuments`) is documented as an explicit fresh walk, not the
cached listing that `projectState` serves.

Read, not measured this pass. The store's own comment (`store.ts:1460`) records 11 s for
a 190k-file folder. During that walk every write route waits on the lock, and the Console
refetches on every event while a run is writing files, so the walk is re-queued as fast as
it completes.

Why it matters: the September 11 Files record already names the refresh-on-every-event
behaviour as a follow-up. What it did not say is that the listing runs inside the write
lock, so a large folder stalls run progress, not just the pane.

Fix (behaviour change, not applied): pass `false` as the second argument to `route()` for
the two document GETs (the walk reads the folder, not the store), and key the effect on the
last History entry id rather than the whole `state` object so it re-runs when a file was
recorded, not when a session heartbeat arrived. Both change when the pane refreshes; the
integrator owns that decision.

## 3. Medium

### 3.1 `refreshCounts` calls `now()` once per History entry

`server/store.ts:601`: `state.history.filter((h) => h.time.slice(0, 10) === now().slice(0, 10))`.
`now()` allocates a `Date` and formats it, per entry. Measured at 5,000 entries: 3.55 ms
per call; 0.08 ms with `now()` hoisted out of the filter. `refreshCounts` runs inside
`projectState` (line 1467), once per project in `projects()` (line 614), and on every write
path that calls `persist` through `writeRecorded`. Applied in §8.

### 3.2 `EngineService.generate` re-runs discovery and the health check on every request

`server/engines/service.ts:323–324`. Each `generate` awaits `discover(true)` (a fresh scan
of the install locations) and `check()` (spawns the CLI with `--version` or equivalent)
before it spawns the request itself. Read, not measured. On a host with three CLIs installed
that is three `stat` walks and one child process per turn, before the turn's own process.
Fix: cache the last check per engine for a short window (the setup screen already shows a
"Check again" action) and re-check only after a failure.

### 3.3 Engine stderr is captured and never read

`server/engines/process.ts:72` declares `private stderr`, line 115 appends to it, and no
line reads it (grep for `this.stderr` finds only line 115). When an engine exits early the
error the user sees is the generic `PROCESS_EXITED` text; the CLI's own explanation was in
that buffer. Fix (behaviour change, not applied): include the last stderr line in the
`PROCESS_EXITED` and `STARTUP_TIMEOUT` errors after passing it through `secretScrubber`,
because CLI stderr can echo tokens and paths. The dead field is removed in §8; the `data`
listener stays so the pipe drains.

### 3.4 Harness routes refresh every project's team secrets and round-trip the response through JSON on every call

`server/harness/routes.ts:16–17` calls `host.refreshSecrets()` (`host.ts:348–352`: for every
project, read the team secrets file and add each token to the scrubber set) and then
`host.scrub()` (`host.ts:381–386`: `JSON.stringify` with a replacer, then `JSON.parse`).
Read, not measured. The secrets refresh is one file read per project per request; the
scrub is a full serialize and parse of a run record that can hold every tool call's
output. Fix: refresh secrets when a team secret is written (the store knows), and scrub
strings while building the response rather than after.

### 3.5 The Connections desktop view reads every run file every 2.5 seconds

`client/connections/Connections.tsx:27` polls `GET .../connections/desktop` on a 2.5 s
timer. `server/connections/desktop.ts:182` answers it with `await this.host.list(projectId)`,
which (`host.ts:359–379`) reads and parses every saved run file in the project and checks
authority on each. Read, not measured. A project with a few hundred runs turns a status
poll into a few hundred file reads twice per five seconds. Fix: keep a run index in
memory (the `RunService` already knows the ids it wrote) or subscribe to `/api/events`.

### 3.6 `DesktopConnections.propose` and `adoptExact` clone and persist the whole project state

`server/connections/desktop.ts:94–100` and `127–133, 151–154`: `structuredClone(this.store.state(projectId))`,
one field changed, `store.persist(state)`. Read, not measured, but the clone is the same
14 ms at 5,000 History entries as §2.1, and the persist writes the whole file. Fix: mutate
under `store.locked` like `ConnectionsService.mutate` (`service.ts:316`) does.

### 3.7 The Board computes each task's evidence up to four times per render

`client/console/BoardView.tsx:81` defines `evidenceOf` as a plain closure; it is called at
line 82 (`columnOf`), 253 (the row prop), 293 (`workerOf`) and 301 (`workerTitleOf`). Each
call filters and sorts `state.sessions` and scans `needs` and `changes`
(`client/workbench/task-evidence.ts:15–23`). Counted, not timed. With T tasks and S
sessions each render is 4 × T × (S log S) before React reconciles anything, and the arrival
effect at line 108 runs `columnOf` again for every task. Fix: `useMemo` a `Map<taskId,
evidence>` on `[tasks, state.sessions, state.needs, state.changes]` and read from it.
`client/console/Ledger.tsx:64–69` has the same shape with two calls per task.

### 3.8 The Workbook History page reverses History once per day group

`client/Workspace.tsx:1762–1785`: `[...state.history].reverse()` to build the day list,
then `[...state.history].reverse().filter(...)` again inside the map for every day. With D
days and H entries that is (D + 1) copies of H per render, and `todayRows()` (line 1006)
does one more. Counted, not timed. The Workbook is the legacy screen (`client/App.tsx`
still mounts it), so this is worth fixing only if it stays. Fix: reverse once into a
`useMemo`, group by day in one pass.

### 3.9 `withinServiceWindow` builds an `Intl.DateTimeFormat` per call

`server/rules.ts:35–41`. Measured: 0.037 ms per call with a fresh formatter, 0.002 ms with
a formatter cached per time zone. It runs once per enabled rule per incoming event
(`rules.ts:84`), so it is small per event and only matters under a burst. Applied in §8
with a per-zone cache; the result is identical because the formatter is immutable.

### 3.10 Owned-process errors are worded for Codex whatever the engine

`server/integrations.ts:218, 237, 274, 280, 287, 293, 306`: `killOwnedProcess` and the
protocol guards say "The owned Codex process could not be stopped", "Codex returned invalid
protocol data" and so on, but the same code now owns Cursor and OpenCode children. A Cursor
user who hits a protocol limit is told Codex did it. User-facing copy, so a recommendation:
take the engine label as a parameter, as `EngineError` in `server/engines/process.ts` does.

### 3.11 The Settings Developer section hard-codes a path from another machine

`client/Settings.tsx:597`: `Storage: F:/Achilles/diomedes/.data`. The tree moved from
`F:/Achilles` to `F:/Diomedes` and the data directory is whatever `--data-dir` or the
desktop shell chose. Product copy, so a recommendation: show `health.dataDir` from
`/api/health`, which already reports it.

### 3.12 Three `LOCAL_ROUTES` with the same name and different contents

`shared/execution.ts:115` (`['sample', 'harness-runtime']`), `shared/managed-usage.ts:379`
(`['sample', 'localai', 'ollama', 'aioncore']`) and `shared/packs.ts:182`
(`['harness-runtime']`). Each is correct for its own caller, but a reader who greps for the
name finds three answers to "which routes are local", and payer attribution
(`managed-usage.ts:397`) and pack routing (`packs.ts:457`) disagree about `harness-runtime`.
Shared contract, so a recommendation: one exported list in `shared/capabilities.ts` next to
`ROUTE_CAPABILITIES`, with the pack and payer modules filtering it by the capability they
care about.

## 4. Low

### 4.1 Duplicated helpers

| Helper | Copies | Owner if merged |
|---|---|---|
| sha256 of text, null-preserving | `server/store.ts:43` `hash`, `server/approval-admission.ts:30` `contentHash`, `server/harness/capabilities/format-report.ts:149` `digestText` | `approval-admission.ts` already exports one and `store.ts` imports from it; merging `hash` into it is safe, `format-report.ts` should import too |
| "is a plain object" | `server/engines/process.ts:218` `record`, `server/app.ts:185` `plain`, `server/team/routes.ts:9` `plain`, `shared/app-updates.ts:151`, `server/connections/openapi-candidate.ts:18`, `compiled-fixture.ts:67`, `mcp-projection.ts:28` `isRecord`, `server/engines/opencode.ts:41` `object`, `client/work-start.ts:33`, `client/approval-decisions.ts:28` `record` | one in `shared/`; `app.ts` cannot import `team/routes.ts` back without a cycle, so the owner must be a leaf |
| "string or empty" | `server/engines/cursor.ts:62` `string`, `server/engines/opencode.ts:43` `text`, `server/models.ts:31`, `server/managed-usage-routes.ts:63`, `client/work-start.ts:41`, `client/approval-decisions.ts:37` | same leaf |
| `body()`, `organizationId()`, `route()` | `server/workspace-routes.ts` and `server/configuration-routes.ts`, byte-identical | either file, or a `server/route-helpers.ts` |
| `deepFreeze`, `fail` | `server/connections/compiler-demo.ts:61,65` and `compiled-fixture.ts:63,136`; `fail` again in `openapi-candidate.ts:14` and (with a code) `desktop.ts:22` | `compiled-fixture.ts` |
| `emptyValue(AnswerValue)` | `shared/business-setup.ts:329` and `shared/packs.ts:208` | `business-setup.ts` (packs already imports from it) |
| `CEILING_ORDER` | `shared/agents.ts:133` and `shared/configuration.ts:435` | `shared/permissions.ts`, where `PermissionChoiceId` lives |
| PowerShell single-quote | `server/engines/login.ts:10` `psQuote`, `server/engines/install.ts:88` `quote` | `process.ts` next to `launchCommand` |
| `now()` | `server/store.ts:41`, `server/usage.ts:33`, `server/workspaces.ts:95` | any one |

None of the copies disagree in behaviour, which is why they are Low. The cross-module
ones in `shared/` are contract-adjacent and are left as recommendations; the in-`server/`
ones with a clear owner and no import cycle are merged in §8.

### 4.2 Typing

- `server/trust/authority.ts:365, 377, 390`: `(result as Denial).denied === true` three
  times, with `isDenial` exported from `trust/types.ts:158`. Applied in §8.
- `server/native-work.ts:545, 835, 868–869`: `run.team!.slotId`, `need.approval!.expiresAt`
  and friends after a guard that TypeScript cannot see. Correct today; a narrowing local
  would make them checkable. Not applied (each is inside a long function and the change is
  not mechanical).
- `server/connections/desktop.ts:146, 152–153, 240, 282, 288`: `plan.request.threshold!`,
  `.find(...)!.adopted = true`, `run.owner!`, `.find(...)!` after a lookup that was just
  performed. The file is also formatted one statement per line at 150+ columns, unlike
  everything around it. Recommendation: format it (`prettier` is in the tree) and replace
  the assertions with the value already in hand.
- `server/configuration.ts:448, 502` (`manifests.find(...)!` after the write that added
  the item), `server/permission-routes.ts:113`, `shared/packs.ts` (`answer!.value` after
  `usable(answer)` in `textOf`, `multiOf`, `moneyOf`), `shared/workspaces.ts`
  (`membership!.role` after `isActiveMember`), `server/rules.ts:42`
  (`parts.find(...)!.value`), `client/Workspace.tsx:957–986` (`state!.needs.find(...)!`
  four times in one render function). Each is a guard TypeScript cannot follow. Read only.
- `client/console/Workspaces.tsx:36` `(view.active as { organizationId: string })` and
  `client/Setup.tsx:211` `as string` after a `typeof` check: redundant casts. Read only.
- `client/connections/Connections.tsx:4` imports a type from
  `server/connections/compiler-demo`. It compiles because `import type` is erased, but it
  is the only client file that reaches into `server/`; the summary type belongs in
  `shared/connection-desktop.ts`. Contract move, recommendation.
- `shared/agents.ts` `agentCompatibility` reads `route[rule.field] as { answer; evidence }`.
  Read only.

### 4.3 Dead code and stale comments

- `server/store.ts:359–360`: `validateAgentResolutions(fresh)` is called twice in a row.
  Idempotent, so harmless; removed in §8.
- `server/engines/process.ts:64, 72, 114–116`: `stderrDecoder` and `stderr` are write-only
  (§3.3). Field and decoder removed in §8; the drain listener stays.
- `client/Workspace.tsx:98`: `localStorage.getItem(...) ? 'ask' : 'ask'` — both branches
  are the same. Line 1057–1058: `const codex = integrations.find(...); void codex;`. Both
  removed in §8.
- `server/configuration.ts:207–215` and `452–462`: two JSDoc blocks stacked on one member,
  the older one left behind when the newer was written. The older block removed in §8.
- `server/managed-usage.ts:435`: `void at;` keeps an unused parameter. The parameter is
  part of the ledger interface, so it stays; the `void` is the honest way to say so. Left.
- `server/billing-events.ts:84`: `seen: string[]` grows by one id per event forever and
  is scanned linearly (`line 142`). Read only; a `Set` with a retention window is a
  behaviour choice.
- `client/console/Ledger.tsx:86`: `[...state.history].slice(-3).reverse()` copies all of
  History to take three. `slice` already copies; applied in §8.
- `client/App.tsx:574, 592, 602, 618, 639`: five inline sorts of `projects` by
  `lastOpenedAt || createdAt` inside JSX, four of them identical. Applied in §8 as one
  memo.

## 5. Error handling and the scrubber

`server/secrets.ts` `secretScrubber` has three callers:

| Site | What it scrubs | Gap |
|---|---|---|
| `server/harness/host.ts:315` | run records on the way out of every harness route, and the warning at `host.ts:369` | none found |
| `server/native-work.ts:330` | the leased team token, on the run's own output | none found |
| `server/support-bundle.ts:41` | every text in the bundle | none found |

Sites that return text a secret could reach without passing through it:

- `server/engines/process.ts:115` stderr (§3.3). Not returned today, so no leak; the
  moment it is surfaced it needs the scrubber.
- `server/connections/desktop.ts:267–268`: `HarnessError.message` and Zod issue messages
  are returned raw. The messages are the harness's own words and Zod's, not connector
  output, so no leak was found; noted because the route bypasses the harness routes'
  scrub.
- `server/app.ts:2467–2470`: `ApiError.message` and `details` go to the client as written.
  Every `ApiError` in the tree was read; the messages are fixed sentences, and the
  `absent(error)` branch at 2481 replaces the filesystem's path-bearing message with a
  fixed one. The generic 500 at 2486 logs the error and returns a fixed sentence. No
  path or secret reaches the client through this middleware.
- `store.emit('engine-text', ...)` (`app.ts:2205`) forwards engine deltas to the SSE
  stream unscrubbed. The engines run as the user with the user's own tokens, and the text
  is what the user asked the engine to say, so this is by design; noted so the next reader
  does not have to check.

Swallowed errors: `catch {}` and `.catch(() => undefined)` were grepped and each read.
The ones in `store.ts` (`refreshDocuments`, `checkFolder`), `usage.ts`, `discovery.ts`
and the desktop shell are all "best effort, the caller has a fallback" and say so in a
comment or a name. Two are worth a second look but were not changed: `server/engines/opencode.ts:434`
closes a child and drops whatever `closeChild` threw, and `client/Workspace.tsx:99` swallows a
`localStorage` failure while choosing between two identical values (§4.3).

## 6. Process and stream handling in `server/engines/`

Read line by line, in the light of the September 11 note that this author writes loosely.

- `process.ts` is sound: a byte cap with `PROTOCOL_LIMIT`, a line splitter that handles a
  partial trailing line, an abort that kills the child and rejects every waiter,
  `close()` that waits for the `close` event with a timeout and escalates to `SIGKILL`.
  The only defect is the write-only stderr (§3.3).
- `cursor.ts:543` `rpc!` inside a callback that is registered before `rpc` is assigned.
  The callback cannot fire before the assignment because the transport starts on the next
  line, so it is correct; a comment saying so would save the next reader the trace.
- `opencode.ts:347, 434, 664`: `closeChild` is called in three places with different
  `primary` arguments; the second (`434`) passes none, so a startup failure's own error is
  lost if `closeChild` throws. Read only.
- `opencode.ts:41–43` and `cursor.ts:62` re-define the object and string guards that
  `process.ts:218` already exports. Merged in §8 where the semantics are byte-identical
  (they are: both return `{}`/`''` for anything else).
- `service.ts:323–324` re-discovers per request (§3.2).
- Every child is spawned with `launchCommand` (`process.ts:38`), which handles the `.cmd`
  shim on Windows in one place. `server/discovery.ts:55` `commandFor` is a second, older
  answer to the same question, used only by `discovery.ts:69`. Read only; merging them is
  a behaviour question because `commandFor` quotes differently.

## 7. Recommendations not applied, and why

| Finding | Why not applied here |
|---|---|
| §2.1 `projectState` disk reads and clone | changes when `changedSince` is computed; contract |
| §2.2 SSE payloads | changes what `/api/events` delivers; API shape |
| §2.3 Files walk under the lock, refetch on every event | changes when the pane refreshes; the Files record already hands it to the integrator |
| §3.2 discovery per request | changes when a missing CLI is noticed |
| §3.3 surface stderr | user-facing error text; needs the scrubber |
| §3.4 harness secrets and scrub | changes when a new token is scrubbed |
| §3.5, §3.6 connections polling and persistence | behaviour and API |
| §3.7, §3.8 Board and Workbook memoization | not measured; the brief said measure first |
| §3.10, §3.11 wording and the Settings path | user-facing copy |
| §3.12 `LOCAL_ROUTES`, `CEILING_ORDER`, `emptyValue`, the `Connections.tsx` type import | `shared/` contracts |
| §4.2 non-null assertions in `native-work.ts`, `desktop.ts`, `packs.ts`, `workspaces.ts` | not mechanical; `desktop.ts` wants a reformat first |
| `Store` has no `setMaxListeners` | changing it changes a warning; the listener count is three per client (`app.ts:1517, 2401`, `usage.ts:214`) and clients are few |

## 8. Applied in this pass

Filled in after the cleanups and the gates; see the commit list at the end of this section.
