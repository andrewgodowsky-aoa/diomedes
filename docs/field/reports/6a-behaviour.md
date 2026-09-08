# 6a — Astra behaviour on the new Console

Branch: `field/density-20260908`. No commits. Changed by this pass:
`client/console/Shell.tsx`, `client/console/ThreadView.tsx`,
`tests/native-ui.spec.ts` (the two Console tests only, selectors plus the
steps those selectors drive). `client/console/types.ts` needed no change
(ThreadView's new prop is optional and lives in ThreadView itself).
Test runs also rewrote the evidence screenshots the specs always write
(`work-admission-console.png`, `approval-console-record.png`, plus the
workbook pair from the shared fixture). `scripts/desktop-smoke.mjs` shows
modified but was already dirty before this pass started; not touched here.

## Part 1 — the five behaviour edits

Shape copied from the merged `client/Workspace.tsx`, not reinvented.

1. **Reconcile on load** — `client/console/Shell.tsx`, `Shell.load()`.
   After the state arrives it calls `reconcileWorkStarts(projectId,
   data.sessions)` and `reconcileApprovals(projectId, data.needs)`, takes
   the first issue, and `report(issue)`s only when its message differs
   from the last one reported (`reconciliationIssue`
   `useRef<string | undefined>`). `load` deps are now
   `[projectId, report]`. The `role="alert"` bar with Dismiss in
   `client/App.tsx` is untouched.
2. **`startTask` via `startWork`** — `client/console/Shell.tsx`.
   `Shell.startTask` now calls `startWork(projectId, { taskId: task.id,
   route, sources: [], consent: true })` (same empty sources as before)
   instead of the raw `api(.../work/start...)` POST.
3. **`resolveNeed` via `decideApproval`** — `client/console/Shell.tsx`.
   Now `await decideApproval(projectId, need, resolution, allowForTask)`
   then reload. The Workbook voices the outcome with
   `decided.execution`; the Console has no such sentence, so the promise
   is awaited and discarded.
4. **No `allowForTask: true` for approval-versioned needs** —
   `client/console/ThreadView.tsx` (plus confirmation in Shell).
   `Notice` already hides its second button for `need.approval`. The
   thread's decide wrapper is now `onResolve(n, r, n.approval ? false :
   a ?? (r === 'go-ahead' && permission === 'task'))`, exactly Astra's
   Pane guard. The need-preview Modal in Shell has no "whole task"
   button at all (only Don't do this / Go ahead, the latter with the
   default `allowForTask = false`), so the guard is vacuous there — and
   the Modal now mounts `<ApprovalStatus need={previewNeed} />` for
   parity with Astra's preview.
5. **Decision record in the thread** — `Shell.tsx` + `ThreadView.tsx`.
   Shell computes `selectedReceipts`: `state.needs` filtered by
   `n.approvalReceipt` and the same `threadOwnsNeed` rule it uses for
   `needs`, `.slice(-1)`, and passes it as the optional `receiptNeeds`
   prop (this matters: the open-needs `waiting` filter used for `Notice`
   can never carry a decided need's receipt). ThreadView renders
   `{receiptNeeds.map(n => <ApprovalStatus key={n.id} need={n} />)}`
   after the woven timeline items. There is no separate live-run block
   in the new thread (runs are woven into the timeline), so the record
   sits after the whole timeline; it renders nothing without a receipt.

## Part 2 — test control mapping

No assertion weakened or deleted; only selectors and the navigation steps
they require changed.

**Test 1 — `Console task Start recovers both lost responses from state
without duplicating Work`:**
- Old `Start with Sample work` (`.console-board`) → Board view via the
  rail (`navigation "Threads and views"` → button `/^Board/`), board
  `.board[aria-label="Board"]`, first row `.crow`, its `Start` verb
  (clicked directly), then the inline `.confirm`'s own `Start` to commit
  under the default "Show me first" policy.
- Old board `Go ahead` enabled-assertion → Board policy radiogroup
  (`aria-label "Board policy"`) radio `Go ahead for tasks`, still
  asserted `toBeEnabled()`.
- Old board `Show me first` enabled-assertion (after reload, so with a
  fresh rail → Board click first) → same radiogroup's `Show me first`
  radio, still `toBeEnabled()`.
- Old `.console-member` helper → Team view (rail `/^Team/`),
  `.team[aria-label="Team"]`, lane `.lane` containing the name.
- Old `.console-board .task-title` new-task row → `.crow` containing
  the name (with a rail → Board click, since reload resets the view to
  Thread).
- `role="alert"` text, Dismiss, sessionStorage, receipt, history,
  file-bytes and `generationCount` expects byte-for-byte as before.

**Test 2 — `Console exact approval recovers both lost responses from
durable state even with task permission`:**
- Old `.console-pane` filtered by thread name → rail button
  `/Exact approval thread/` click, then thread screen `#scrThread`
  (re-selected from the rail after each reload, since reload resets the
  view/selection).
- `region "Needs your OK"`, whole-task-button count 0, `Expires`,
  `Approval record` / `Decision record` (from `ApprovalStatus`, now
  mounted via `receiptNeeds`), digests, receipt equality, execution
  `applied`, file bytes, history kinds, `generationCount + 1`,
  no-horizontal-overflow, and both `role="alert"` expects unchanged.

## What Astra's Console did that the new Console genuinely cannot do yet

- Astra's Pane changed the permission caption for codex routes and
  approval-versioned needs ("Each proposed file change needs its own
  exact OK."). The new thread head has no permission-explainer line, so
  that sentence was not ported. No test asserts it.
- The Workbook-only surfaces were not ported and have no Console
  equivalent: the `decided.execution` outcome sentence, the
  history-entry `ApprovalStatus`, and the work-session `ApprovalStatus`.
  The Console shows the decision record in the thread only.
- The old preview Modal's conditional "Go ahead for this whole task"
  button has no counterpart because the new Modal never offered a
  whole-task button; parity there is the absence plus the added
  `ApprovalStatus`, not a hidden third button.

## Verify (in order)

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run --configLoader runner` — first run: 360 passed, 1
  failed (an expiry-timing assertion, `need.state` expected `expired`,
  unrelated to this pass — client console files only); rerun:
  `Test Files 14 passed (14)` / `Tests 361 passed (361)` /
  `Duration 27.19s`.
- `npx vite build` — `✓ built in 693ms` (final; bundle hash
  `index-BwJoivmW.js`).
- `npx playwright test tests/native-ui.spec.ts` — `3 passed (7.7s)`.
- `npx playwright test` (all three specs) — `25 passed (33.3s)`: the 23
  that passed before plus the two fixed Console tests.
