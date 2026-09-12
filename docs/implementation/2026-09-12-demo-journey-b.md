# Demonstration journey B on the packaged candidate

September 12, 2026. Worktree `F:\Diomedes\diomedes-wt\opus-journey-b`, branch
`opus/journey-b-20260912`, source at `da84689`. The thing under test is the packaged executable at
`F:\Diomedes\diomedes-wt\release-20260912\release\Diomedes-win32-x64\Diomedes.exe`
(sha256 `ae8ef98a…f249a`), whose embedded `BUILD_INFO.json` reads version 0.1.1,
`sourceStatus: committed`, `baseCommit da84689`. Nothing was rebuilt, repackaged, committed or
pushed, and no file under `client/`, `server/`, `shared/` or `desktop/` was changed.

This is a measurement, not a change. Journey B is brief 01's technical-user path: activate the first
Software Engineering pack, open a small disposable repository, inspect the loaded project
instructions, assign a bounded change through the real OpenCode account route, see the file
operation and its validation, inspect the result in the app, and test Stop with a queued follow-up,
including one visible known failure that yields a recovery action.

The headline is short. Everything around the engine works. The engine turn itself did not produce a
proposal on either of the two live attempts, on two different models, for two different reasons, so
the middle of the journey — exact proposal, approval, recorded write, diff — was not measured on a
real route in this build.

## Rerun on the published bytes (candidate `4fb8656`, v0.1.1-experimental.3)

Everything below this section describes the first run, on the `da84689` candidate, whose headline
was that the engine turn produced no proposal. The script was rerun against the candidate published
as `v0.1.1-experimental.3`
(`F:/Diomedes/diomedes-wt/release-20260912-4fb8656/release/Diomedes-win32-x64/Diomedes.exe`, record
`evidence/release-candidates/diomedes-0.1.1-windows-experimental-20260912-4fb86560c1d7.json`) on a
fresh profile, 08:09 to 08:11 UTC on 12 September. `evidence/demo-journeys/b/journey-b.json` and its
screenshots are now that run; the earlier `mimo-v2.5-pro` attempt is kept under `run2-mimo/`.

| Result | First run (`da84689`) | Published run (`4fb8656`) |
|---|---|---|
| traversed | 12 of 22 | 19 of 22 |
| intervention | 2 | 2 (review the diff from the Workbook; the History button switches surface) |
| not reachable | 3 | 1 (editing an existing source file from the Console) |
| failed | 5 | 0 |
| live turns | 2 on `opencode-go/glm-5.2`, no proposal | 2 on `opencode-go/glm-5.2`, proposal approved and written |

The middle of the journey is now measured on a real route:

- **assign-the-bounded-change:** "Send this task?" confirmed from the Board; the session ended
  waiting on `opencode-go/glm-5.2`.
- **exact-proposal:** the proposal names exactly `NOTES.md` and shows its text before any write.
- **approve-and-record-the-write:** approved; one change record for `NOTES.md`; History reads
  "opencode-go/glm-5.2 changed 1 file".
- **choose-the-model-on-the-thread:** the thread picker now offers the signed-in account's models
  (16 choices including OpenCode's), which closes the picker gap named under pillar 07 below.
- **known failure and recovery:** unchanged and still exact: with OpenCode switched off the start is
  refused by name, no substitute route runs, and the switch in Settings is the named control.
- **stop-the-task and follow-up-fate:** the second run was stopped with the receipt; the queued
  follow-up is recorded as `cancelled · Cancelled by Stop (task)` rather than delivered into its own
  session, which is the fate the brief asked to see.
- **What remains:** the Console has no keep or undo control for a proposal (Review happens on the
  Workbook page); the History button still switches the surface and downgrades the detail level; and a
  bounded change to an existing file cannot be assigned from the Console because no control selects
  a source document and an empty selection lets a text route only create files.

## What was traversed

Twenty-two named steps ran against the packaged EXE with ordinary controls. Statuses are the
brief's four: `traversed`, `intervention`, `not-reachable`, `failed`.

| # | Step | Status | Note |
|---|------|--------|------|
| 1 | onboarding | traversed | Welcome, three questions, AI setup and "Open Diomedes", each with its own control. |
| 2 | path-guard-refusal | traversed | A guarded folder is refused in words and the dialog stays open to correct: "This folder or file is private and cannot be opened by Diomedes." |
| 3 | open-repository | traversed | `greet-kit` opened with the Console's own "Open a folder as a project" control. |
| 4 | make-the-task | not-reachable | The Console has no task-creation control; only the frozen Workbook plan path has one. Made by API as a fixture. |
| 5 | engine-setup | traversed | Settings > Engines: "Native OpenCode Go account connected. Choose an explicit provider/model." 15 models advertised; `opencode-go/glm-5.2` chosen from that list and set as the default on `opencode:opencode-go`. |
| 6 | open-the-task-thread | traversed | The board row's task name opens (and the first time makes) the task's thread. |
| 7 | activate-software-engineering-pack | traversed | Software Engineering is on; one instruction file recorded; zero grants and zero needs — activation granted nothing. |
| 8 | inspect-project-instructions | traversed | "Project instructions loaded · AGENTS.md"; the panel opens and reads the file back. |
| 9 | choose-the-model-on-the-thread | not-reachable | The thread's engine picker lists nothing for OpenCode. Settings > Engines is the only route control. |
| 10 | known-failure-account-unavailable | traversed | With OpenCode switched off while it is the task's route, the start is refused: "Turn the selected engine on in Settings before using it." No substitute route ran. |
| 11 | recover-by-turning-the-engine-back-on | traversed | The refusal names the control that fixes it, and that control works. |
| 12 | assign-the-bounded-change | failed | "Send this task?" confirmed, work admitted, one live OpenCode turn spent. Session ended `failed` after 18.8 s: "Work stopped: OpenCode did not finish within the time limit. Recheck before starting another request. No project files were changed." No model recorded. |
| 13 | exact-proposal | failed | No proposal to inspect: the turn faulted. |
| 14 | approve-and-record-the-write | failed | Nothing was put in front of the person to approve; `needs` stayed empty. |
| 15 | review-the-diff | failed | The Workbook Review page opens but has no change to show, so "Keep all" is disabled. |
| 16 | edit-an-existing-source-file | not-reachable | No Console control selects a source document, and with an empty selection a text route may only create files. The obvious change inside `src/greet.js` cannot be assigned here. |
| 17 | second-assignment-for-stop | failed | The board row offers no Start after a faulted turn, though the fault text says "Start again to request a new proposal". The row reads "Add NOTES.md for src/greet.js · OpenCode · now · Run failed · this thread · Route to". |
| 18 | queue-a-follow-up-while-in-flight | intervention | The queue accepts and shows the follow-up, but no run was in flight (the faulted turn had already settled and could not be restarted), so the in-flight case was not measured. |
| 19 | stop-the-task | traversed | Receipt: "Stopped the task. It reached what was running. Provider work already sent can complete and be charged after Stop." |
| 20 | follow-up-fate | traversed | The queue line settles to "Sent"; the recorded state is `delivered`, into its own session. |
| 21 | inspect-history | intervention | History opens with a day of entries, but the Console's History button switches the surface to the frozen Workbook and downgrades Technical detail to Standard. |
| 22 | reopen-check | traversed | Closed by the window control and relaunched on the same profile: `greet-kit` is listed again and History keeps its day. |

Twelve traversed, two intervention, three not-reachable, five failed.

## Where a person needed help

Four places, in the order they arrive.

The task itself cannot be made in the Console. Journey B says "assign a bounded change"; the Console
gives no control that creates a task, so the fixture was made through `POST /projects/:id/tasks` and
recorded under `backendPreparation`. A technical user on this build reaches the board with an empty
Ready column and no way to fill it from the surface they were told to use.

The route is chosen in Settings, not on the thread. The brief expected the thread's engine picker.
`client/console/Picker.tsx` only offers an engine when `IntegrationStatus.available` is true, and
nothing in `server/discovery.ts` or `server/integrations.ts` ever sets that flag for OpenCode — the
three writers of `available: true` (`server/integrations.ts:566`, `:628`, `:697`) are other paths.
So the picker is empty even while the same account reads "Native OpenCode Go account connected" in
Settings. The reachable route control is Settings > Engines: pick the model in the select, press
"Use as default". That is what this run did.

Review lives in the Workbook. `client/console/Shell.tsx` defines `reviewChange` and wires it to
nothing, so keeping or undoing a change means leaving the Console for the frozen Workbook Review
page. Standing decision 1 says the Console is the one surface; this step contradicts it.

History does the same, and worse: pressing History in the Console rail runs `openInBook`
(`client/App.tsx:495`), which switches the surface to the Workbook **and** silently downgrades a
Technical detail setting to Standard. A technical user loses the detail level they chose, without
being asked.

## What is not reachable in this build, and why

- **Making a task from the Console.** No control exists. Workbook only.
- **Choosing the engine or model on the thread.** `Picker.tsx` gates on an availability flag that is
  never set for external engines. The same flag makes the thread permission panel print
  "Unavailable" beside the OpenCode preset (`client/console/PermissionPanel.tsx:164`) while
  Settings reports the same account as connected.
- **Assigning a change to an existing file.** The Console has no control that selects a source
  document into the run, and `server/native-work.ts:592` refuses to replace an unselected file. With
  an empty selection a text route may only create new files. The bounded edit inside `src/greet.js`
  that the fixture was built around therefore cannot be asked for at all; the assignment had to be
  "create NOTES.md".
- **Restarting a faulted turn from the board.** `client/console/BoardView.tsx:403` renders Start only
  for the `Ready` column. A run that faults leaves the row reading "Run failed" with "Route to" and
  a thread link, and no Start — while the fault sentence tells the person to start again.

## What "file/tool operation and validation" measures on a text route

Nothing in the OpenCode route executes anything inside the project. The adapter
(`server/engines/opencode.ts`, `TEXT_ROUTE_CONTROLS` in `shared/engines.ts`) disables engine tools
and sends only the selected text; the session log says so in its own words: "The adapter disables
engine tools and sends only selected text. This is not an operating-system sandbox." There is no
validation runner — no test, lint or build is run against a proposal.

So on this route the phrase can only mean the five-part chain: the engine returns file text, the app
shows the exact proposal, the person approves it, Diomedes performs the write through the History
transaction, and the diff and the History entry are what remain. The "validation" is the parse and
the guard, not execution: `parseProposal` (`server/native-work.ts:88-140`) caps the reply at eight
files and 128 KB, requires exactly `summary` and `changes`, requires each entry to carry a path,
complete text or `null`, and a short explanation, rejects duplicate paths, rejects unsupported file
kinds, and resolves every path through the guard.

In this run the chain broke at its first link, so links two through five were never exercised on a
real route. They were exercised on the built-in `sample` route during development, which is not
evidence about OpenCode.

## The instruction-delivery boundary (HAR-01)

Confirmed empirically and in the source, both halves.

The Console shows `Project instructions loaded · AGENTS.md`, the panel opens the file, and the text
reads back correctly. The project state records the instruction file. Activation of the Software
Engineering pack adds no permission — the History sentence is "You turned on Software Engineering
for this project. It adds no permission." and the state shows zero grants and zero needs.

None of that text reaches a model. `instructionRules` in `server/capability-packs.ts:114` converts
instruction files into rules, and a repository-wide search finds no caller. The prompt actually sent
is assembled at `server/native-work.ts:470-485`: the strict-JSON instruction, the tool prohibition,
the selection rule, the limits, the selected editable paths, and the requested work. Instruction
files are not among the `documents` and not in the prompt. "Inspect loaded project instructions"
passes; the model never receives them.

## The known failure and its recovery

The brief asked for one induced failure. The run produced two, and only the induced one had a
recovery action that worked.

**Induced, zero turns.** With `opencode` set as the task's route, the OpenCode switch in
Settings > Engines was turned off and the task started from the board. The confirmation dialog
appeared as usual; the start was refused in words: *"Turn the selected engine on in Settings before
using it."* Nothing else ran — no sample route, no fallback model, no spinner. The sentence names
the control that fixes it, that control was used, and the next start was admitted. That is the
useful-recovery case the brief wanted. A second refusal of the same family was captured earlier in
the run: the path guard refusing `F:\Diomedes\diomedes\node_modules` with *"This folder or file is
private and cannot be opened by Diomedes."* while leaving the dialog open to correct
(`server/paths.ts:83`).

**Un-induced, and the real finding.** Both live assignments faulted at the provider, differently:

- Run 2, `opencode-go/mimo-v2.5-pro`, 21.2 s: *"Work stopped: The engine did not return a valid file
  proposal. No files were changed. Start again to request a new proposal."* The adapter only returns
  when the assembled answer is non-empty (`server/engines/opencode.ts:620-626`), so the model answered
  and the answer was not JSON. `parseProposal` calls a bare `JSON.parse` on the reply
  (`server/native-work.ts:96`) and strips no code fence and no surrounding prose, so a model that
  wraps correct JSON in ```` ```json ```` fails identically to one that writes an essay. Evidence
  kept under `evidence/demo-journeys/b/run2-mimo/`.
- Run 3, `opencode-go/glm-5.2`, 18.8 s: *"Work stopped: OpenCode did not finish within the time
  limit. Recheck before starting another request. No project files were changed."* The request
  budget is 120 s (`REQUEST_TIMEOUT_MS`) and the startup budget is 15 s (`STARTUP_TIMEOUT_MS`); an
  18.8 s failure is consistent only with the startup poll, not the request budget, but `abortError`
  maps both deadlines onto the same sentence (`server/engines/opencode.ts:126-142`), so the person
  cannot tell "the local OpenCode server never came up" from "the model was slow". The server's own
  log is not retained, and journey A was running on this machine at the same time by design, so load
  during the OpenCode spawn is a candidate the integrator can rule in or out from their own timings.

Both faults were honest: stated in a sentence, no spinner, no silent substitution, and both end with
"No project files were changed", which the state confirms — zero changes, zero needs, zero history
`file` entries from either session. What is missing is the recovery: the fault says "Start again"
and the board row that would start it again has no Start button.

One further attribution gap. `session.engine.model` is assigned at `native-work.ts:518`, *after*
`parseProposal` at line 505, so a faulted turn records `model: null` — the History and the session
cannot say which model was billed. Even on success the value would be `input.model`
(`server/engines/opencode.ts:630`), the slug Diomedes asked for, echoed back; the provider's own
report is not recorded. The `model` field in the evidence JSON is therefore the requested slug, and
`reportedModel` is null.

## Stop and the follow-up

Both work, and both ran in a degenerate form because there was no live work to interrupt.

The follow-up "Also list the exported names in NOTES.md." was typed into the queue under the
composer and accepted; the queue states when it would run. Stop was then pressed with the `task`
scope and returned a receipt: *"Stopped the task. It reached what was running. Provider work already
sent can complete and be charged after Stop."* That last sentence is the honest one — it does not
claim to have cancelled provider billing.

Because nothing was in flight, the queued follow-up was delivered immediately as its own admitted
session (`state: delivered`, its own session id, its own `commandId` receipt) and Stop reached that
session rather than the original assignment. The queue line settled to "Sent". So the mechanism is
demonstrated — queue, deliver through ordinary admission, receipt, visible fate — but the case the
brief actually asked for, queueing *while a turn is in flight* and stopping it, was not measured.
Reaching it needs an engine turn that lasts long enough to interrupt, which is exactly what this
build did not produce.

## The reopen check

The window was closed with its own control and the EXE relaunched on the same profile directories.
`greet-kit` is listed again, its History keeps the day's entries, and the task is where Stop left it.

The process scan afterwards was name-based (`Get-CimInstance Win32_Process`, matching
`opencode|codex` plus any `node`/`Diomedes` process on a `journey-b` command line). Three processes
matched — `codex.exe` 34484, `codex-computer-use-swift.exe` 19720, `codex-code-mode-host.exe` 21600
— and all three were created on 2026-09-11, before this run; they belong to the person's Codex CLI.
Nothing was killed. No `opencode` and no `Diomedes` process survived the run, so
`leakedProcesses` is empty and the raw scan is kept beside it as `processScan`.

## Live turns spent

Four OpenCode turns in total on the person's account, under the brief's ceiling of eight; two in the
evidence run, under its ceiling of three.

| Run | Model | Route | Turns | Result |
|-----|-------|-------|-------|--------|
| real 1 (abandoned) | none selected | — | 0 | Killed before any assignment when the thread picker turned out never to offer OpenCode; no turn was spent. |
| real 2 | `opencode-go/mimo-v2.5-pro` | `opencode` on `opencode:opencode-go` | 2 | Assignment faulted on the proposal parse; follow-up delivery stopped after 0.8 s. |
| real 3 (evidence) | `opencode-go/glm-5.2` | `opencode` on `opencode:opencode-go` | 2 | Assignment faulted on a timeout; follow-up delivery stopped after 0.7 s. |

The two 0.7 s and 0.8 s sessions are the follow-up deliveries. Each was stopped before any
provider reply arrived and may well not have been billed; they are counted as turns anyway, which is
the conservative reading.

Both models were taken from the fifteen the running app advertises for
`opencode:opencode-go`; no identifier was typed. `glm-5.2` was chosen for run 3 because it is a
different provider family from the one that had just failed to return JSON, and because it is the
family already used for bounded work here. Development ran on the built-in `sample` route in
`--dry` mode and cost nothing.

## Corrections to the brief's stated facts

Each was checked against the source rather than assumed.

- The pack id is `diomedes.software-engineering`, not `software-engineering`; the activate route is
  `POST /api/projects/:id/packs/diomedes.software-engineering/activate`.
- The path guard does not fence projects to `DIOMEDES_PROJECTS_DIR`. It refuses forbidden and
  private paths and app-data paths (`server/paths.ts:83`, `:119`, `server/store.ts:636-637`); a
  folder anywhere else opens. The disposable repository was still created under the journey's own
  `DIOMEDES_PROJECTS_DIR`, and the guard was probed with a folder that is genuinely refused.
- OpenCode Go does advertise DeepSeek models here — `deepseek-v4-flash` and `deepseek-v4-pro` are
  two of the fifteen. Their retirement is a routing policy, not an absence in the runtime. They were
  not used, to respect that policy.
- "Choose a model the runtime advertises for the opencode route" is only reachable from
  Settings > Engines. The thread picker offers nothing.
- The "Send this task?" confirmation belongs to the board start path only: `startTask`
  (`client/console/Shell.tsx:609-613`) raises it for an external route, and it is the sole caller of
  `setSendTask`. The composer's `send()` at line 635 dispatches without it.

## Exact commands

```
node scripts/demo-journey-b.mjs --exe "F:/Diomedes/diomedes-wt/release-20260912/release/Diomedes-win32-x64/Diomedes.exe" --dry
node scripts/demo-journey-b.mjs --exe "F:/Diomedes/diomedes-wt/release-20260912/release/Diomedes-win32-x64/Diomedes.exe"
node scripts/demo-journey-b.mjs --exe "F:/Diomedes/diomedes-wt/release-20260912/release/Diomedes-win32-x64/Diomedes.exe" --model "opencode-go/glm-5.2"
./node_modules/.bin/tsc --noEmit
```

Every launch used `_electron.launch` with its own `DIOMEDES_DESKTOP_PROFILE`, `DIOMEDES_DATA_DIR`
and `DIOMEDES_PROJECTS_DIR` under `test-results/journey-b/`, with `ELECTRON_RUN_AS_NODE` deleted and
`DIOMEDES_TEST_MODE` never set, and waited for the integrator's `browser.lock` to be absent first.
No Vite server and no `playwright test` was started. Evidence: `evidence/demo-journeys/b/`
(27 screenshots, `journey-b.json`, and `run2-mimo/` for the earlier live attempt). Every step has a
screenshot except `reopen-check`, whose shot fires after the window is closed and is therefore
empty.

The 22 step records, `stop`, `followUp`, `backendPreparation` and `limitations` in `journey-b.json`
are the script's own untouched output. Five fields were added by hand afterwards and are marked here
as such: `priorRun` and `totalLiveTurns` (run 2's result, which the script cannot know about),
`knownFailure.secondUninduced`, and `processScan` / `processScanNote` — the process scan was re-taken
by hand with the same query plus a creation-date column, because the filter the script ran at the
time could not tell a pre-existing Codex process from one of ours. The script now records both.

The script is 755 lines against the brief's ~400: roughly 340 for the 22 steps and their notes and
roughly 270 for helpers that a packaged Electron app needs (native `dialog` inertness, a controlled
checkbox saved over HTTP, an error bar that intercepts clicks, the Console/Workbook surface swap).
It was left at that length rather than restructured after the evidence run; `--dry` on the sample
route revalidates any later compaction at no cost.

## PILLAR IMPACT

This run is evidence for pillar 07 and pillar 09 and a warning about pillar 01. Pillar 07 holds
where it matters most: the route is a resource the person selects and switches off, refusal is by
name with no substitution, and the two provider faults were reported as faults rather than papered
over with a fallback model — but the same pillar is undercut by the thread picker never listing a
signed-in account and by the session recording no model for a turn that was billed, since a resource
you cannot see or attribute is not yet interchangeable. Pillar 09 is well served: approval precedes
every write, the Stop receipt admits that provider work already sent can still be charged, History
is the durable record and survives a restart, and the instruction-file boundary is real rather than
claimed. Pillar 01 is where the gap is: the journey exists to solve a bounded piece of work, and on
this candidate no bounded change was produced on a real route in two paid attempts, while the
bounded change the fixture was designed around — editing an existing file — cannot be asked for from
the Console at all. Pillar 04 and pillar 06 take smaller marks: Review and History are only reachable
by leaving the one surface, the History route silently downgrades a chosen detail level, and a
faulted run tells the person to start again on a row that offers no Start.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Source and evidence only in `opus/journey-b-20260912`; nothing built, packaged, committed, pushed,
published or deployed. **Update, 12 September 08:00 UTC:** the rerun described at the top was made on
the bytes published as `v0.1.1-experimental.3` and spent two further OpenCode turns.
