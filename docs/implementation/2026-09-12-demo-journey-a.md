# Demonstration journey A, traversed on the packaged candidate

September 12, 2026. Brief 01 names two demonstration journeys and neither had been walked. This is
journey A, the ordinary user: open the app, pick an account, make a project, get two exports into
it, ask for an operations brief, put a task in front of a worker, watch it, read the result and its
sources, ask for one revision, close the app and find the work again.

It was traversed against the exact packaged candidate at
`F:\Diomedes\diomedes-wt\release-20260912\release\Diomedes-win32-x64\Diomedes.exe`
(sha256 `ae8ef98af1b83cacc237c1649de8a993b1577c0365e5b98066d4ad93404f249a`, embedded BUILD\_INFO
version 0.1.1, base commit `da84689`, sourceStatus `committed`). Nothing in that directory was
touched. The traversal is `scripts/demo-journey-a.mjs`; its per-step record is
`evidence/demo-journeys/a/journey-a.json` with one screenshot per step beside it.

This is a measurement, not a build. Where a step has no control in this build it is recorded as not
reachable rather than worked around with a new one.

## 1. What was traversed

| Step | Status | What happened |
|---|---|---|
| 01 open the app | traversed | The portable exe launched with its own profile, data and projects directories. |
| 02 first-run questions | traversed | Welcome, Business, Guided detail, the default file-change answer. |
| 03 check this computer | traversed | Discovery from the screen's own button; four engines listed. |
| 04 sign-in and the known failure | traversed | Per-engine check; oh-my-pi is signed out and the screen offers a recovery. |
| 05 select a supported account | traversed | Claude Code, model `sonnet`, switched on and made the default. |
| 06 finish setup | traversed | Open Diomedes; the Projects page. |
| 07 create a project | traversed | The New project dialog; the Console opened on it. |
| 08 attach two exports | **not reachable** | There is no attach control. The exports were written as fixtures. |
| 09 business workspace | traversed | Created from the Workspaces panel; it says it is a development identity. |
| 10 answer the setup questions | traversed | Eleven questions through the questionnaire's own controls. |
| 11 turn the setup on | traversed | Prepared and activated; revision 1 running. |
| 12 choose where the business writes | traversed | Bound to the project from the Workspaces panel. |
| 13 request the operations brief | **intervention** | Drafted, but from a path no screen can choose; a second request is refused. |
| 14 open the brief and its sources | traversed | Opens in the Files pane with a Sources section. |
| 15 make a task and find it in Ready | **not reachable** | No Console control creates a task, and none moves one. |
| 16 start the task and watch progress | traversed | Two confirmations, a row in Working, a run that failed with a reason. |
| 17 ask for one revision | traversed | Sent and answered on Claude Code, but with no document attached. |
| 18 close and reopen | traversed | Everything was still there; nothing was left running. |

Fifteen of the eighteen steps were traversed with ordinary controls, one needed intervention and two
are not reachable at all. Of the fifteen, twelve needed no explanation; the three that did are steps
02, 05 and 17, described next.

## 2. Where a person needed explanation or intervention

**The On switch and Use as default race each other.** On the AI setup screen, clicking *Use as
default* and then the On switch in immediate succession leaves settings holding
`defaultEngine: claude-code` and `claude-code: false` — the switch is lost. Every later request is
then refused with "Turn the selected engine on in Settings before using it," which does not say that
the switch a person just set has been unset. Both controls are controlled inputs that only reflect
their value after the save returns, so a person clicking at ordinary speed can produce this. The
traversal sets the switch first and waits for the saved value before setting the default; the script
also re-clicks the switch if the default overwrote it, and says so in the record when it has to.

**The setup radios do not move when clicked.** The first-run *Kind of work* and *Detail preference*
radios stay unselected until their save returns. Nothing is lost; the delay is just visible.

**Requesting the brief twice.** The first request drafts. The second is refused with "This document
changed since you opened it. Read its current version before saving." — a message about a document
the person never opened.

**The brief a person gets is empty of claims.** Because the exports they can put in a project are
not the file the setup selects, the first brief says "There is nothing new in the approved exports
since the previous brief" and then names one file it could not read. Both sentences are true; read
together they suggest a quiet week rather than a source that was never found.

**Starting a task asks twice, and the first question names the wrong party.** The Board's inline
confirm reads "Hand to You?" — `workerOf()` returns "You" for a task owned by `you`, which is the
task's owner and not the route the work is about to leave on. Confirming it then opens a second
modal, "Send this task?", which does name Claude Code. A person is asked twice for one start, and the
question that comes first is the one that does not say where the work is going.

**The revision has no document.** The composer sends the instruction without carrying any project
document, and its reply says so: "No documents were supplied with this request, so I have no source
material to draw a brief from or to keep source markers for." The thread head states that sending
shares "this instruction and selected documents", and in ask mode there are no selected documents to
share and no control to select any.

## 3. What is not reachable in this build

**Attaching a file.** FIL-02 is not implemented and nothing stands in for it. The Files pane
(`client/console/FilesPane.tsx`) lists and reads; it has no attach, add, import or drop control, and
the traversal found none by role or label. The two fictional exports — a made-up bakery's weekly
sales CSV and inventory Markdown — were therefore written into the project folder through
`POST /api/projects/:id/documents/create`. That is backend fixture preparation, and it is listed as
such in the evidence. **Attach is not reachable by app controls in this build.**

**Naming which exports the brief reads.** The active configuration's approved-file scope carries
exactly one path, `weekly-operations-exports`, fixed by the pack variant in `shared/packs.ts`. The
questionnaire has no question about it, the setup review screen shows it but cannot change it, and
the Workspaces panel chooses only which project the business writes into. So an ordinary user cannot
point the brief at the two exports they actually have. To see the brief read anything at all, the
traversal wrote a third fixture at that exact path — an extensionless file name no person would
guess — and says so.

**Creating a task, and moving one to Ready.** No Console control creates a task. `POST
/api/projects/:id/tasks` exists and the frozen Workbook uses it; the Console only updates a task's
state and assignment. Nor is there a move: a task with no run is *projected* into Ready by
`taskEvidence`, and the Board offers Start, Stop, Review, Route to and Reopen but no column move.
"Move the task to Ready" is therefore not an action a person performs here. The task was created
through the API and the Board was then driven normally from Ready.

**Codex on the setup screen.** The brief expected the first-run screen to list Codex native beside
the other four. It lists `claude-code`, `opencode`, `oh-my-pi` and `cursor` only —
`EXTERNAL_ENGINES` in `shared/engines.ts` — although `codex` is still a route. A person setting up
cannot see or choose Codex there.

## 4. Two defects worth a source fix

Neither was fixed here; both are described so someone who owns the file can decide.

**The weekly brief can be prepared once per project.** `WeeklyBriefService.run` reads the previous
draft with `store.current(...)` and passes that *text* as the recorded writer's `expected` value.
`store.writeRecorded` compares `expected` against `hash(beforeText)`, a sha256. The first run passes
because both sides are null; every later run compares a sha against a document body and is refused
with the 409 above. The fix is to pass the hash of that text, as `POST
/api/projects/:id/documents/write` already does with `baseSha`.

**The previous brief is never written, so change detection never runs.**
`server/workspace-routes.ts` reads `previous` from `diomedes/last-brief.md`, and nothing anywhere
writes that path. `previous` is therefore always null, so `reportedText` returns empty, every source
line counts as added, and "Unchanged since the previous brief" can never be reached honestly. The
two defects hide each other: because a second run is refused, the missing previous file has not bitten
yet.

## 5. The known failure and its recovery

Induced at setup, as the brief suggests: an engine that is installed and supported but not signed
in. On this machine, after the per-engine check, Claude Code reported signed in with 2 models,
OpenCode signed in with 15, Cursor signed in with 37, and **oh-my-pi** did not.

Its row says: "The isolated native OMP profile exited before it could report metadata. Configure
supported OpenAI API access in the native profile, then recheck." Below it the screen offers
**Configure OpenAI API access**, with a caption naming the OMP auth documentation and the OpenAI
billing page, saying that OpenAI API billing is separate from ChatGPT, that Diomedes creates an empty
template only if missing and never reads the key, and that rechecking verifies local configuration
only. The row's switch stays disabled while the engine is unusable, so the failure cannot be
half-selected.

That is a stated cause and a next action, not a spinner and not a silent substitute. The recovery
button was not clicked: it runs the provider's own tool against a real account, which this
measurement does not do.

A second, unplanned failure appeared in the real run and is worth recording as the more interesting
one. Starting the task on Claude Code ran for 15 seconds, showed one row in Working, and ended
failed, with History reading: "Work stopped: The engine did not return a valid file proposal. No
files were changed. Start again to request a new proposal. No project files were changed." The task
moved to Blocked. The sentence says what happened, what was not touched, and what to do next. It
reproduced on all three real runs that reached the provider, with a bare task name and with an
instruction naming two files in the project — so the Claude Code build route did not produce a proposal the adapter could read in either
case. The session's model is recorded as null, and the Work panel shows "Claude Code model not
recorded", which is a truthful-attribution gap against decision 8.

## 6. The reopen check

The window was closed the way the app handles it — `BrowserWindow.close()`, which reaches
`window-all-closed` and `app.quit()` in `desktop/main.mjs`. No process was killed. Relaunched with
the same profile, data and projects directories, the project, its task, four documents and nine
History entries were all still there, and the Console reopened on the project.

Child processes of the Electron process were listed before the close and checked afterwards against
the live process list: none of `codex.exe`, `opencode`, `claude`, `cursor` or a `node.exe` child
owned by this launch survived it. Journey B was running its own copy at the same time, which is why
the check is by parent process id rather than by name alone.

No uncaught browser error was raised at any point in the run.

## 7. Live turns spent

**Two, both on Claude Code with `sonnet` selected.** One to start the task from the Board, one for
the revision in the thread. `sonnet` is what the setup screen had selected; the runtime did not
record which model actually answered, which is the attribution gap in §5. The setup checks — discovery and per-engine sign-in and model listing — send
no model prompt and cost nothing. The deterministic weekly brief calls no model at all and is
labelled deterministic wherever it appears; a run of it is a file comparison, not authorship.

The whole traversal was developed in `--dry`, which selects no engine, so every route falls back to
the built-in `sample` engine. Across all real runs of this journey, six turns were spent: two earlier
runs reached no provider at all (the engine switch was lost, so the request was refused before it
left the machine, which costs nothing), and three complete runs spent two each — of which the last
is the evidence run recorded here.

## 8. Exact commands

```
cd F:\Diomedes\diomedes-wt\opus-journey-a
node scripts/demo-journey-a.mjs --exe "F:/Diomedes/diomedes-wt/release-20260912/release/Diomedes-win32-x64/Diomedes.exe" --dry
node scripts/demo-journey-a.mjs --exe "F:/Diomedes/diomedes-wt/release-20260912/release/Diomedes-win32-x64/Diomedes.exe"
./node_modules/.bin/tsc --noEmit
```

`tsc --noEmit` is clean on this tree. No unit or browser suite was run: nothing in `client/`,
`server/`, `shared/` or `desktop/` was changed, and the brief forbids `playwright test` while other
work holds the machine. Every launch waited for
`F:\Diomedes\diomedes-wt\release-20260912\test-results\candidate\browser.lock` to be absent first.

The isolated run directories are `test-results/journey-a/{profile,data,projects}`, recreated empty at
the start of each run so the journey always begins at first run.

One correction to the evidence file, stated so it is not discovered later. After the run, the
script's own summary looked the known-failure step up by an earlier name and so wrote
`knownFailure.induced: "not induced"` while step 04 recorded the failure correctly. The lookup is
fixed in the script, and that one derived field was recomputed from the step records already in the
file, which were not altered; the file carries a `knownFailure.recomputedNote` saying so. No further
run was made, because the live-turn budget is spent.

Two other edits landed in the script after the evidence run, listed so that "does this script produce
this evidence" has an honest answer. The screenshot helper dropped a running counter, so files are
named `<nn>-<step>.png` rather than `<nn>-<nn>-<step>.png`, and the files on disk were renamed to
match; the unused counter was removed with it. Neither touches a step, a status or an observation.

## 9. What the integrator has to decide

1. Whether journey A can be demonstrated at all while attach (FIL-02) and Console task creation are
   missing, or whether the demonstration script says plainly that a person prepares those two things
   outside the app.
2. Whether the approved-export selection becomes something a person can choose. As it stands the
   weekly brief reads one extensionless path chosen by a pack variant, so the feature is complete and
   unreachable at the same time.
3. Whether the two brief defects in §4 are fixed before the candidate is shown.
4. Whether the Claude Code build route's failure to return a readable file proposal is a route defect
   or an expected limit of the `-p` adapter; either way it is what a demonstration of "start a task"
   currently produces.
5. Whether ask mode should be able to carry a document, given that the revision step of this journey
   is answered by a model that was shown nothing.
6. Whether the one recomputed field in the evidence file (§8) is acceptable as evidence in this
   repository's terms, or whether a further real run is authorised to regenerate the file whole. The
   step records it was derived from were not altered, and the budget for this journey is spent.

## PILLAR IMPACT

The journey advances pillar 05 by proving that self-setup works unattended on a real machine: the
setup screen found four engines, reported three signed in, and named the fourth's exact obstacle with
the action that clears it. It advances 09 and 06 in the parts that hold — the Board asks twice before
work leaves the machine, a failed run says what was not changed, evidence survives a quit — and it is
evidence against 01 and 12 in the parts that do not: a business person cannot put their own exports in
front of the one deterministic report this build ships, because attaching is unbuilt and the approved
list is frozen in a pack variant, so the work is not yet solved end to end on one surface. Pillar 08
is upheld in design and undercut in practice: the brief is genuinely deterministic and cites every
source, but it can only be produced once per project. Pillar 07 has a truthful-attribution gap to
close, since the session and the reply both record no model even though a model answered. No pillar
was amended and nothing here claims a capability that is not shipped.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Source and evidence only: one new script and one evidence directory in this worktree, nothing
committed or pushed, no package built, no installed app replaced, no release published, no cloud
document written; the only provider calls were the two recorded Claude Code turns on the account
already signed in on this machine.
