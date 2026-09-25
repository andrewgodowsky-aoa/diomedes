# OS01 — Task priority: build prompt

**Node:** `OS01.I` (implementation). An independent `OS01.R` review follows on the composed candidate; the builder does not review its own work.
Revision: rev 2, 2026-09-25. Rev 1 was reviewed the same day (`docs/implementation/2026-09-25-os01-prompt-review.md`); every fix and owner decision from that review is written in below.
Owner: Andrew (Diomedes Systems LLC)
Model: Claude Opus 5.5 builds. Astra or another independent model reviews; the builder never reviews.
Worktree: `F:/Diomedes/diomedes-wt/task-priority` on `feature/task-priority`, created from current `origin/main`. Never read code from `F:/Diomedes/diomedes`; that checkout is parked on an old docs branch.
Package node: `OS01.I` (number 23c) in the unified execution package, reviewed by `OS01.R` (24c). Linear DIO-110.
Inputs, all on main in this repository:
- `docs/product/ADR-owner-surface-2026-09-25.md`, rev 5, decisions D7 and D6. Where rev 5 and this prompt ever differ, this prompt wins for OS01.
- `docs/implementation/owner-surface-discovery-2026-09-25.md`, sections 3.1, 3.16 and 5 ("One sort"), plus 8.8 and 8.9. Sections 8.10–8.12 (automation capacity, run class, allowance) are OS12 context, not OS01 scope.
- `docs/implementation/2026-09-25-os01-prompt-review.md`, for why each rule below exists.

## Current state

Main (at least `df28d5c`, v0.2.0) has no priority, due date or planning revision on `Task`. The discovery report's line numbers are pinned to `90f23fa`; PRs #144 and #145 have since changed `client/console/BoardView.tsx`, `client/console/ThreadView.tsx` and `server/app.ts`, so re-find every anchor on your own base.

- The ready queue sorts within a project by `readyAt → createdAt → taskId` (`shared/ready-queue.ts`, `planReadyQueue`) and serves projects least-recently-served first. `readyAt` is not a stored `Task` field: `readyAt()` in `shared/ready-queue.ts` derives it from the task's moves and falls back to `createdAt`.
- Task creation runs through a strict v1 admission schema with replay digests (`server/task-admission.ts`, `server/command-admission.ts`) and `Store.createTask`. Several other creators call it: plan conversion, conversation actions, team tools, wake, fork, connection issues and the harness bridge.
- The task PUT route (`/api/projects/:id/tasks/:taskId` in `server/app.ts`) changes name, description, owner and state, and ignores `assignedTo`. Assignment is OS02's; do not touch it.
- The discovery compiler probe found that a required `priority` produces 10 diagnostics: the `Task` object literal inside `Store.createTask` (`server/store.ts`, about line 1951) and nine test fixtures.
- There is no organization timezone anywhere on main. Only automation schedules carry an IANA zone (`shared/automation-schedule.ts`).
- There is no task permission yet. `task:prioritize` arrives with OS04. In OS01 the local Console user may edit priority and due date.

## Outcome

A person using the Console can set a task's priority (1–5) and optional due date anywhere a task is listed. The change is durable, attributed, versioned and replay-safe. Every actionable work list in the app sorts by the same rule, and the ready queue honours priority within each project's fair turn. Legacy tasks migrate to priority 3. Nothing about AI start consent, project fairness, automations, assignment or hosted access changes.

## Decisions you implement (do not re-decide)

**Priority**
- `type Priority = 1 | 2 | 3 | 4 | 5`; 1 = do first.
- Required on every `Task`, including AI-created and automation-created tasks.
- Default 3 at creation when the creator supplies none.
- Migration sets absent values to 3. A malformed stored value fails migration loudly (backup, refusal, plain message); it never silently becomes 3.

**Due date**
- `due?: string` is a plain calendar date, `YYYY-MM-DD`, stored exactly as the person entered it, with no timezone conversion.
- Validate the format and that it is a real date. Do not parse it into `Date` for comparison; compare the strings.
- OS01 computes no "overdue", "today" or "late". A later lane that shows those chooses the timezone.

**Labels**
- One shared table: 1 *Do first*, 2 *Today*, 3 *This week*, 4 *When you can*, 5 *Backlog*.
- Packs and organizations may override the words later. Do not build the override.
- Labels only: no auto-decay when a period passes.

**One comparator** for actionable work lists:
- Order: `priority → due (dated first, ascending) → readyAt(task) → scoped stable id`, where `readyAt(task)` is the existing derivation in `shared/ready-queue.ts`.
- Undated tasks sort after dated ones at the same priority.
- The comparator is pure, does not mutate its input, and lives in `shared/task-priority.ts`.

**Ready queue**
- Apply the comparator inside each project's line in `planReadyQueue`.
- Keep least-recently-served project order, consent holds, the `global`/`perProject` limits and deterministic ties exactly as they are.
- Name this in the contract doc as the one place priority does not override fairness. A priority-1 task in another project still waits its turn.

**Not sorted by priority**
- Plan-step order (`client/console/board-model.ts`, `client/console/progress-bars.ts`), History, conversation turns and message order.
- Where one component shows both, keep "work-list order" and "plan order" explicitly separate.

**Planning revision**
- Add `planningRevision: number` to `Task`. Legacy tasks migrate to 1.
- Only priority and due-date edits increment it. State moves, name and description edits, and scheduler activity never touch it, so a background state change never makes a person's priority edit fail.
- Every priority or due edit carries `expectedPlanningRevision` and fails with a typed conflict on mismatch.
- A same-command retry returns the original receipt, not a second move.

**Priority moves**
- `priorityMoves?: { at, by, from, to, dueFrom?, dueTo? }[]` on `Task`, append-only.
- `by` is the existing `Owner` type for now; OS02 widens actors. Leave a comment, not a union.
- Record `by` truthfully (standing decision 8):
  - The Console control records `'you'`.
  - A conversational edit the person asked for in their own words records `'you'`, and its command receipt names the conversation and turn that carried the request.
  - A team tool, an AI worker or any change Diomedes initiates records `'diomedes'`.
  - Never record `'diomedes-with-ok'` for a priority move.

**One writer**
- Priority and due edits go through one server mutation (`server/task-commands.ts`). The PUT route, the conversational edit seam and team tools all call it. No second writer.
- A priority change never:
  - starts AI work;
  - changes `owner`;
  - rewrites an admitted Work or Approval command's digest;
  - reorders a claim the scheduler already made.
- The scheduler rechecks the chosen task before claiming and never reissues a claimed command after a reorder.
- Bot-initiated changes use the same command and are logged the same way. Do not build new bot UI; the seam in `server/interaction-service.ts` just gains the typed field.

**The control (`client/console/TaskPriority.tsx`)**
- Five levels, with the text label always visible, not just the number.
- Choosing a level saves at once, with no confirmation step. The control shows "Saving…", then either the new label or a plain conflict message with a way to reload and retry. The change is recorded and reversible by choosing again, so there is no undo prompt. Never show optimistic success before the server's receipt.
- The due date is edited in the same control, with a clear-date action.
- Keyboard: operable without a pointer (arrow keys between levels, Enter or Space to choose, Escape to close), with visible focus.
- Touch: targets at least 44 by 44 CSS pixels.
- The same control appears on the Board, palette task results, the Ledger open-task list and the thread's task header.

**Downgrade**
- The migration raises the project-state schema version. The existing registry refuses newer state, so an older build cannot open a migrated project.
- The contract doc names this and the backup file the migration writes. Release notes must say it before this ships.

## Scope — edit / add

Follow the discovery report's section 3.1 list. In short:

**Shared**
- `shared/types.ts`: `Priority`, `due`, `priorityMoves`, `planningRevision`, and `TaskCreationInput.priority?` / `due?`.
- `shared/task-priority.ts` (add): comparator, label table and validators.
- `shared/task-commands.ts` (add): edit intent and receipt.
- `shared/ready-queue.ts`.

**Server**
- `server/task-admission.ts`, `server/command-admission.ts`.
- `server/task-commands.ts` (add).
- `server/store.ts`: default, planning revision, migration hook and recorded priority move. The label table belongs in `shared/task-priority.ts`, not here.
- `server/migrations/registry.ts`, plus `server/migrations/task-records.ts` (add).
- `server/app.ts`: create, PUT and conversational wiring.
- `server/durable-controls.ts`: fork inherits priority and due explicitly.
- `server/team/{service,board,tools}.ts`: accept and emit priority; sort before list limits.
- `server/interaction-service.ts`, `server/ready-scheduler.ts`.

**Client**
- `client/task-create.ts`: carry priority and due through pending input and the receipt.
- `client/task-edit.ts` (add): versioned edit and recovery.
- `client/console/TaskPriority.tsx` (add).
- `client/console/{BoardView,paletteEntries,Shell,types,Ledger,ThreadView,board-model,progress-bars}.ts(x)`.

**Tests**
- Add `tests/task-priority.test.ts`, `tests/task-priority-admission.test.ts` and `tests/task-priority.spec.ts`.
- Edit the fixtures the probe named: `attribution-shared-ui`, `console-activity`, `guidance-maintenance`, `review-diffs`, `software-pack`, `verification-service`, `workbench-board`, `workbench-palette`, `workbench-task-evidence`.
- Edit the behaviour tests: `task-admission`, `task-create-client`, `ready-queue`, `ready-scheduler`, `ready-queue-ui.spec`, `workbench-palette`, `migrations`.
- Add the new spec to `playwright.config.ts` explicitly; a new file is not collected on its own.

**Docs**
- `docs/implementation/task-priority-contract.md`, covering:
  - the exact migration, its backup and the downgrade refusal;
  - the ordering rule and its named exceptions;
  - command and receipt shapes;
  - the `by` mapping;
  - the consumer list and exclusions;
  - the acceptance evidence you produced.

Treat section 3.16's consumer inventory as a regression checklist, not scope. A file that only reads a task ID does not need an edit.

## Hot files, claims and the test slot

Andrew assigns these integrator-owned hot files to this lane for OS01 only: `shared/types.ts`, `server/app.ts`, `server/store.ts` and `client/console/Shell.tsx`.

**Before editing any file:**
- Claim the exact paths through the pinned coordination tool, and release them when the patch returns:
  `F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913/tool/coordination.ts`
- Run it with this worktree's `node_modules/.bin/tsx`.
- Pass `--role opus`, `--pid` naming your long-lived Claude session process (not a short-lived shell), and `--start` with that process's start time.
- A path someone else holds is not yours. Stop and report it; never steal a claim.

**The heavy-test slot:**
- Every Playwright run needs the shared slot. Take it with `slot`, run, then `unslot`.
- If it is held, wait or do other work. Do not run Playwright without it.

**Keep the lane safe:**
- Lock your worktree against the weekly sweep: `git worktree lock --reason "<session> OS01 task-priority"`.
- A fresh worktree has no `node_modules`. Either run `npm ci` in it, or junction it to the shared install (`mklink /J node_modules F:\Diomedes\diomedes\node_modules`) after checking that install matches this branch's `package-lock.json`. If you junction it, remove the junction with `rmdir` before `git worktree remove`, which otherwise deletes through it.

## Out of scope — refuse if you find yourself doing it

- Person assignees or any `assignedTo` change (OS02).
- Run origin, `runClass`, capacity or preemption (OS12).
- Any hosted, remote or Owner Surface code (OS05, OS08).
- Source or PM-tool priority sync (OS13).
- Completion, `'submitted'` or reports (OS09), including the task-state sentence table in `server/store.ts`.
- A permission check such as `task:prioritize` (OS04).
- Pack or organization label overrides.
- Cross-project priority override.
- Auto-decay of labels.
- Overdue or timezone logic.
- Editing `Owner`.
- New dependencies.

## How to work

1. **Read first.**
   - `F:/Diomedes/AGENTS.md`, then this repository's `AGENTS.md` and `CLAUDE.md`.
   - The three canonical documents; report their versions.
   - The three inputs above, in full.
   - Then `server/store.ts`, `server/task-admission.ts`, `server/command-admission.ts`, `shared/ready-queue.ts`, `server/ready-scheduler.ts`, `client/task-create.ts` and `client/console/BoardView.tsx`, before writing anything.
2. **Build in this order.**
   1. `shared/task-priority.ts` and its unit test.
   2. The type change and migration. Run `npx tsc --noEmit` and fix the ten diagnostics.
   3. The command path.
   4. The scheduler.
   5. The UI.
   6. The contract doc.
3. **After each step:** `npx tsc --noEmit` and `npx vitest run` pass.
4. **Before any Playwright run:** take the slot and run `npx vite build`. `tests/native-ui.spec.ts` fails with "dist is older than …" if `shared/types.ts` changed after the last build.
5. **Before the PR is marked ready,** run all four repository gates on the final commit:
   ```
   npx tsc --noEmit
   npx vitest run
   npx vite build
   npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
   ```
   Then the full browser suite, `npx playwright test` with no file arguments, because this change touches Board, palette, Ledger and thread flows. Report per-spec counts, including skipped tests. A full run rewrites committed `evidence/**.png` files; restore them with `git restore -- evidence/` unless a proof commit is intended.
6. **Fix real failures only.** Never weaken an assertion or turn a live test into a mock pass.
7. **Deliberately amended tests.**
   - Amend `tests/ready-queue.test.ts:76` ("only its oldest Ready task") to priority-then-oldest, and record the change in the contract doc.
   - Keep these as they are:
     - `tests/ready-queue.test.ts:90` and `:142`: fair interleaving and tie-breaks.
     - `tests/ready-scheduler.test.ts:131`, `:333`, `:350` and `:386`: with every task at the default 3, oldest still starts first.
     - `tests/migrations.test.ts:70`, `:286` and `:303`.
     - Old v1 admission receipts stay readable.
   - Line numbers are as of `df28d5c`; re-find them if the file moved.
8. **Commit, push, open a draft PR.** This prompt is Andrew's approval for commits and pushes to `feature/task-priority`, and for one draft PR titled `OS01: task priority, due date and work-list ordering`. It is not approval to merge.
   - Commit in small, described commits.
   - Never add a `Co-Authored-By` trailer or any AI-attribution line to a commit, and never add "Generated with Claude Code" to the PR. The repository is public.
   - Do not merge, and do not touch main.
   - Do not edit the execution package, `RUN_ORDER`, checksums or completion status.
   - Do not mark anything DONE. An open PR is not DONE.
   - Do not edit the canonical documents; report proposed changes instead.
9. **End with a report in the PR description:**
   - **What works.**
   - **Exact commit.**
   - **Test commands and real counts,** naming their source.
   - **What you excluded and why.**
   - **PILLAR IMPACT:** pillars advanced, risks or conflicts, and observable proof.
   - **ROADMAP IMPACT:** exact status changes and the evidence for each.
   - **Build, publication and deployment status,** kept separate from the above.
   - **What is implemented versus only recorded.**
   - **Anything left uncommitted or unpushed.**
   - **Anything you had to decide that this prompt did not settle.** Flag it; do not bury it.
   - **What OS01.R should look at hardest.**

## Required acceptance

What OS01.R will check on the exact candidate:

- **Migration.**
  - Every legacy task in a fixture store loads with priority 3 and planning revision 1.
  - A corrupt stored priority refuses with a backup and a plain message.
  - An older build's registry refuses the migrated project state, and the contract doc names the backup.
- **Admission.** Creating a task with no priority yields 3; with `priority: 1` it yields 1; with `priority: 7`, or a due date that is not a real `YYYY-MM-DD` date, admission rejects it with a typed error.
- **Concurrency.**
  - Two concurrent edits with the same `expectedPlanningRevision`: one wins, the other gets a typed conflict, and no duplicate move is recorded.
  - Retrying the winner's command returns its original receipt.
  - A state move between two priority edits does not cause a conflict.
- **Attribution.** A Console edit records `by: 'you'`; a team-tool edit records `by: 'diomedes'`; a conversational edit asked for by the person records `by: 'you'` and a receipt naming the conversation turn.
- **One order everywhere.** Board, palette task results, the Ledger open-task list and the thread task header all show the same order for the same tasks, and offer the same control. Plan steps in the same view keep plan order.
- **Ready queue.**
  - With two projects each holding a priority-1 and a priority-5 task, the plan claims one per project in least-recently-served order, priority-1 first within each.
  - Changing a priority between plan and claim causes a recheck, not a duplicate start.
  - A claimed task is not reissued after a reorder.
- **No side effects.** No AI session starts because of any priority or due edit, and `owner` is unchanged by any edit.
- **The control.**
  - Choosing a level saves immediately and shows "Saving…" and then the result or a conflict message.
  - It works keyboard-only and by touch, with targets of at least 44 px.
  - Labels are visible, not just numbers.
  - The due date can be set and cleared in the same control.
- **Gates.** All four gates and the full browser suite pass on the final commit, with real counts reported.
- **Contract doc.** It names the ordering rule, its exception inside the ready queue, the `by` mapping, the downgrade refusal and the exclusions above.

## Execution and return

Return the draft PR link, its head commit, and the report from step 9. Release every path claim and the test slot before you stop. If you cannot finish, commit what passes, say plainly where you stopped and why, and leave the worktree locked for the next session.
