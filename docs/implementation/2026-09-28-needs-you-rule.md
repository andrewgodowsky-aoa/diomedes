# The one needs-you rule - 2026-09-28

## Work order

- Feature: needs-you-rule. Item 1 of Andrew's 2026-09-28 build order, the critique's P0/P1:
  "Home, ledger and Board agree on what's waiting, with each item named and its buttons right
  there." Part 1a (fd3154e) is the rule and every reader of it. Part 1b names each waiting item
  on the home, with its button.
- Prompt ID: none. Andrew's choice in chat.
- Owner: Claude (Opus 5.5), session 0eb01d3d-0a26-4fd3-89e4-6a8a3a80ac7d, coordination seat
  opus, process 39060.
- Branch: feature/needs-you-rule.
- Worktree: F:/Diomedes/diomedes-wt/needs-you-rule.
- Base: 66334d512ef51c808d460b6e177690d87ecfaaa0 (origin/main when the work began).
- Coordination: part 1a held claims `claim_mukuohc7_860bccdd`, `claim_mukutfgw_d3b1af86`,
  `claim_mukvnyhc_abc901ee` and `claim_mukzvyxg_abd59771`, released after fd3154e; part 1b holds
  `claim_mul0b0o3_320d7ae4`, released after its commits. Two integrator hot files changed under
  owner overrides: `server/store.ts` (journaled 2026-09-28T06:12:26Z) and, in part 1b,
  `shared/types.ts` (widened 08:49:24Z). `client/console/Shell.tsx` is held by PR169-RESUMED and
  is not touched; its part is a patch for the integrator.

## The problem

Three places decided "needs you" three ways.

- The server's project status, which the home, the spine and the Projects list count, counted
  open Needs only. Changes to review, a phase to approve and a failed run counted zero, so the
  home could say a project needed nothing while its Board showed work waiting.
- The activity overview listed every Blocked task under Needs you, including a run waiting on
  its engine and a task record with no run behind it, neither of which waits on anyone. It put
  work to review under a second heading, Ready for review.
- The points disagreed. The Board painted every Blocked task red, the ledger painted Review and
  Blocked alike amber, and the plan bars drew a run that went wrong as still ahead. The two
  also printed ages from different starts: the Board from the last move, the ledger from
  creation, both as "N m".

## The rule (`shared/needs-you.ts`)

What waits on the person in one project:

- an open Need, an approval only the person can give. It is one item, though its task also
  shows under Review;
- a Review task: a phase to approve, changes to review, or a task record to review;
- a Blocked task whose run failed or went wrong (`task.reason === 'went-wrong'`), to look at
  before it is retried.

Nothing else counts: a run waiting on its engine, a task record with no run behind it, queued
or running work, done or deleted work. Items are listed newest first, dated by the Need or by
the task's run.

`taskEvidence` moved to `shared/task-evidence.ts`, so the server can read it;
`client/workbench/task-evidence.ts` re-exports it. It gained `wait: 'review' | 'failed' | null`,
so a task's column and whether it waits on the person are decided in one place. Its column
logic is unchanged.

`evidenceTone` gives every point one colour per state: amber waits on you, red failed, the
accent is running, grey is done, and nothing else takes a colour.

`counts.waitingForYou` keeps the raw open-Need count. Nothing on screen reads it, so no surface
shows it beside the rule's count.

## Who reads it

| Surface | Before | Now |
| --- | --- | --- |
| Project status `needsYou` (home, spine, Projects) | Open Needs | `needsYou(state).length`. `counts.waitingForYou` stays the raw open-Need count. |
| Activity overview | Every Blocked task; work to review under Ready for review | The rule, plus automation attention. A run waiting on its engine lists under Working. Ready for review is gone. |
| Ledger, Needs you | Open Needs, each with Review | The rule. Approvals keep Review; a task to review or a failure opens the Board. Failures are red. |
| Board card points | By column: Blocked red, Review amber | `evidenceTone` |
| Ledger points | By column: Review and Blocked amber | `evidenceTone` |
| Plan bars | Only a failed run red; a run that went wrong still ahead | Review waits (amber); failed or went wrong fails (red) |
| Home project line, spine | "Needs your OK" | "Needs you", since it now covers review and failures too |
| Ledger ages | Since the task was added | The Board's `ageOf`: since it last moved, with the same title |
| Project status `waiting` (1b) | Did not exist | The newest three items by name; absent when nothing waits |
| Home report (1b) | A count per project | Up to three items by name across projects, each with one button; a project row counts only what the list leaves out |

## The home names what waits (part 1b)

Each project's status now carries its newest three waiting items by name (`WaitingItem` in
`shared/types.ts`, filled by `refreshCounts`). The home's report reads them: under "Waiting on
you" it lists the newest three across every project, each with its label, what it waits on, the
project, and one button. An approval or work to review says Review; a failure says Check and is
red. A project row below counts only the items the list leaves out ("Two more things are
waiting on you."), and a project whose items are all named is not called quiet.

The button asks the Console to open that project on the Board and names the task or the Need.
The Shell change that opens the item itself is
`docs/implementation/2026-09-28-needs-you-shell.patch`, returned to the integrator because
PR169-RESUMED holds `client/console/Shell.tsx`. With it, a Need opens in the thread where it is
decided, scrolled into view, and a task opens its own thread. Until it lands, the button opens
the project on the Board, where the task waits in Review or Blocked.

## What is not implemented

- **Opening the item itself.** The Shell patch above waits on the integrator; until then an
  item opens its project on the Board.
- **Approve and Decline on the home.** Each item carries one button that goes to it. Deciding
  from the home itself belongs with the approval card (item 2) and is Andrew's call.
- **Automation attention in the server's count.** The client adds it to the overview from the
  automations host. Putting it in `status.needsYou` needs a `server/app.ts` change (a hot file).
- **Inbox proposals.** Left out until Andrew decides whether accepting a proposed task counts.
- **`ProjectActivity.readyForReview`** stays in the type, always empty, because `Shell.tsx`
  reads it in an emptiness check. Drop it when the Shell next changes.
- **The Need block's region name**, "Needs your OK", is unchanged. Browser specs find the
  approval block by that name.

## Tests

- `tests/needs-you.test.ts` (new): an approval counts once; every kind of Review task counts;
  four ways a run fails or goes wrong; nine things that wait on no one are left out; newest
  first; one colour per state; and a real `Store` whose project has zero open Needs reports
  `status.needsYou` 2 (a task record to review and a failed run), equal to the rule over the same
  records.
- `tests/progress-bars.test.ts`: `stepState` reads the evidence's wait. The went-wrong cases now
  draw as failed; "Check the task record" with no reason stays pending.
- `tests/console-activity.test.ts`: changes to review list under Needs you; a run waiting on its
  engine lists under Working; a stale record lists nowhere; a run that went wrong is red.
- `tests/board-model.test.ts`: the plan board's steps read `stepState` the same way.
- `tests/backend.test.ts`: an existing assertion that recorded the undercount. After the
  sample run finishes with two changes waiting, the project now needs the person (1, was 0),
  and needs nothing once Keep all settles the task.
- `tests/ui.spec.ts` F11-F13 and F15-F16: the browser form of the same undercount. After the
  person declines the second request, one change still waits for review, and the project's tab
  now keeps its waiting mark (it was expected to clear). F15-F16 now checks that the mark
  clears once Keep all settles the change. Its comment said the Console could not keep or undo
  a waiting change; the task's thread does, through `ChangeDiffs`.
- `tests/home-brief.test.ts` (1b): the newest three across projects are named, a project row
  counts only the rest, a project whose items are all named is not quiet, a status that names
  none keeps the old sentence, and each item renders one button (Review, or Check in red for a
  failure).
- `tests/needs-you.test.ts` (1b): the store's status names both waiting items, and a project
  with nothing waiting carries no list.

## Verification

Each step ran in this worktree under the coordination heavy slot on 2026-09-28.

Part 1a, at fd3154e (base 66334d5 plus part 1a):

- `npx tsc --noEmit`: clean, before and after the spec change.
- The 16 affected test files (`npx vitest run --maxWorkers=4 <files>`): 334 passed.
- `npx vitest run --maxWorkers=4`: 493 files; 8,252 tests passed and 4 skipped, of 8,256.
- `npx vite build`: built.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`: the first
  run failed F11-F13's closing waiting-mark assertion, the undercount described under Tests
  (22 passed, 13 not run behind it in the serial file). After the spec change, on a fresh
  build: 36 passed.

Part 1b, on fd3154e plus part 1b:

- `npx tsc --noEmit`: clean.
- The 16 affected test files: 337 passed.
- `npx vitest run --maxWorkers=4`: 493 files; 8,255 tests passed and 4 skipped, of 8,259.
- `npx vite build`: built.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`: 36 passed.
- `git apply --check` of the Shell patch against the committed `client/console/Shell.tsx`: applies.
- The home's list, rendered: the real `HomeBrief` with sample projects, on a page that loads the
  built stylesheets in the built-in Nectovia scheme, at 1265 px and at 800 px (the desktop
  window's minimum). Nothing wraps at either width. The second line reads at 8.45:1, the red
  Check at 6.03:1 and the amber Review at 9.18:1, and every button's box sits inside its row's
  lines.

The two evidence screenshots the browser run rewrites were restored after each run.

## PILLAR IMPACT

- **Advances 06 (come back only when a real decision or exception needs you).** The count now
  holds every decision and exception, and nothing that waits on no one. Evidence: the exclusion
  test and the store test.
- **Advances 04 (information where the worker needs it).** The home's number, the ledger and
  the Board now agree, and the home names what waits with a button for each. Evidence: the
  home-brief tests.
- **Advances 08 (deterministic work stays fast).** A pure projection over records; no model.
- **Risk to 06.** A failed run now raises the home's count until someone starts it again,
  reopens it or marks it done. If failures are frequent, the count could read as babysitting.
- **Supersession:** none. Consistent with the project memory's "Needs you owns decisions".

## ROADMAP IMPACT

No status change while the branch is unmerged. When it merges, the critique's "one needs-you
rule" is implemented in source, with the home naming what waits; opening the item itself waits
on the integrator's Shell patch.

## Proposed project-memory patch

After "Needs you owns decisions", add: "What counts is one rule (`shared/needs-you.ts`): open
approvals, work to review, and runs that failed or went wrong. A run waiting on its engine and a
task record with no run behind it wait on no one. The home, the ledger, the activity overview
and the Board read the same rule, and the home names the newest three with a button for each."

## Build, publication and deployment status

Committed locally on `feature/needs-you-rule`: fd3154e (part 1a), 2adca0a (part 1b) and the
commit that records the rendered check of the home's list. Nothing is pushed, merged, released
or deployed, and no version changed. The Shell patch is not applied anywhere.
