# 3b — Team (multi-worker view)

Date: 2026-09-08. Branch: `field/density-20260908` (worktree `F:\Achilles\diomedes-wt\field`).
Files: `client/console/TeamView.tsx` (replaced), `client/console/team.css` (new),
`client/console/types.ts` (one optional prop: `TeamProps.onAddMember?()`).
Nothing else touched; the Shell mounts the view unchanged and does not yet pass
`onAddMember`, so the empty-team block currently shows no Add button until the
Shell wires its existing "Add a helper" modal to the prop.

## What was built

Three (or N) concurrent execution lanes on one grid, lead first then members by
`createdAt`, each lane a `subgrid` (`grid-row: 1 / -1`) over
`grid-template-rows: auto auto auto minmax(160px,1fr) auto auto` so header,
context, action, stream, message and controls align across lanes. Structural
dividers are hairlines between lanes; each lane carries its own vertical spine.
Lane class maps member status directly: `working`, `waiting`, `error` →
`blocked`, `idle`, `stopped`.

- Task row: `data-focus-point` point (live while any lane works) + `<h1>` (focus
  task, else the lead thread's task, else the project name) + mono
  `N lanes · {lead} leads` + right-aligned handoff count
  (`N handoffs, last HH:MM {From} to {To}` over member-to-member `message`s,
  `0 handoffs` when none). Hairline drop to the lanes' top rule via
  `.task::after`.
- Header: spine point, name, `leads`/`member`, mono `engine-id · model`
  (`member.model` ?? thread `helper.model` ?? `"default"`), state word.
- Context meter: hairline track with `--f` fill from the latest session for the
  member thread's task (`engine.context`); `context unknown` when the app has
  none, plus `· N messages waiting` when `unread > 0`.
- Current action: working → latest plain-level log sentence of the live session
  + elapsed (`2 m 10 s`, 10 s tick); waiting → `Waiting for {lead}` or
  `N messages waiting` with letterspaced `WAITING` and a `Start` verb when
  unread; blocked → last log sentence, amber `blocked`, always-visible
  `Start again` + `Message`; idle → `Nothing assigned`; stopped → `Stopped`.
- Stream (`ol.ev3`): last 60 rows with an `N earlier events` loader (+60 per
  click); latest row `.now` on working/waiting/blocked lanes; handoff rows carry
  `data-handoff={message.id}` in both lanes.
- Message: latest to/from mailbox message with `to {name}` / `from {name}`
  attribution (`owner` reads as Diomedes), else `No messages yet.`
- Controls: hover/focus reveal (`Stop` unless stopped, `Start` when waiting with
  unread, `Message` focuses the composer with the member selected, `Thread`);
  always visible on blocked lanes.
- Composer (`.teamcompose`): `Tell the team` textarea, `Diomedes routes it` +
  per-member `to` select, caption, one-record bar, `.send.ready` state,
  Enter-to-send with Shift+Enter/`isComposing` guards, via
  `onMessage(slotId | 'diomedes', text)`.
- Empty team: task row still renders; quiet block
  `No team yet. Add a leader, then members.` + `Add` when `onAddMember` exists.
- CSS: every rule `.console`-prefixed, tokens only, no shadows; the only glow is
  the live point, via `color-mix(in srgb, var(--light) 35%, transparent)`.
  Prototype `1100px` stacking and `860px` rules kept; traveller/landing gated
  behind `html[data-motion='reduced']` and `prefers-reduced-motion`.

## How streams are merged

Per lane, `buildStream()` concatenates three sources, then sorts ascending by
timestamp (stable; log < mail < run order preserved on ties):

1. The member's sessions' log lines — sessions whose `taskId` equals the member
   thread's task (`state.sessions`), every `{time, sentence}` entry. Kind is the
   sentence's first word lowercased when it is one of read, wrote, ran, asked,
   found, sent, opened, changed, checked, start, stop, else `note`; detail is
   the remainder (or the whole sentence for `note`). No `.ms` suffix: the app's
   log entries carry no per-step durations, so it is omitted, not zero-filled.
2. Mailbox messages touching the member (`to` or `from` == slot). A `message`
   with both ends in the roster is kind `handoff` (`from {name}` on the
   receiver's side, `to {name}` on the giver's, both rows sharing
   `data-handoff`); anything involving `owner` is kind `mail` with the summary
   or content truncated to 140 chars.
3. Team runs for the slot: kind `run`, `started` at `startedAt`, `finished` at
   `endedAt` (status collapsed to `finished`; the run `summary` is not shown).

## How the handoff geometry is computed

For the most recent member-to-member `message`: the giver lane is
`.lane[data-lane="{from}"]`, the receiver `.lane[data-lane="{to}"]`, and each
side's anchor is its own `[data-handoff="{id}"]` row. With the `.lanes` box as
origin, `x = lane.left − box.left + (lane is first ? 4.5 : 9.5)` (the spine sits
at 4 px in the first lane, 9 px elsewhere), `y = row.bottom − box.top + 1`.
Level when `|y2 − y1| < 3`. The polyline is
`(x1,y1) → (x2,y1)[ → (x2,y2)]`, drawn as `polyline.live` in `svg.handsvg`.
Redrawn on resize, on any stream scroll (capture listener), on
fonts.ready, and whenever lanes/messages/runs change. A new handoff id while
mounted (and motion allowed) animates a body-fixed traveller along the same
points in 480 ms `cubic-bezier(.16,1,.3,1)`, then `landed`-scales the
receiver's header point. Data is never delayed for the animation: both stream
rows render from the message record first. Verified numerically in the live
check: `box.left 293`, giver lane at 293, receiver at 659, rows bottoming at
286/341 → points `4.5,187.8 375.5,187.8 375.5,243.5` — exactly the prototype's
`drawHandoff` arithmetic.

## What the app cannot yet provide that the prototype showed

- Per-step timings in the stream (prototype's `120 ms` / `80 ms` chips): the
  `Session.log` entries have no durations, so rows carry none.
- The context meter's second half (`· 3 files open`, `· idle 2 m`,
  `· blocked 40 m`): the app exposes only `engine.context` percent, so the
  meter shows `context N%` / `context unknown` plus the unread count.
- The prototype's lane-3 `Give the list` / `Route to Codex` verbs: there is no
  unblock/route callback in the team contract, so blocked lanes offer
  `Start again` (`onWake`) and `Message`.
- `Pause` / `Take over` lane verbs: the contract has `onStop`/`onWake` only;
  controls are Stop / Start / Message / Thread. `onTakeOver` was not added.
- Model line: prototype shows `gpt-5.2-codex · medium` (model · effort); the app
  has no per-member effort, so the header shows `engine-id · model`.
- The task row has no `Permit renewal`-style live session link: with no task
  linked to the lead thread it falls back to the project name (as specified).
- The Shell does not yet pass `onAddMember`, so the empty-state Add button is
  dormant until the Shell wires its modal.

## Live check (real team, `.data-3b`)

Lead Codex (working) + Claude Code (waiting, 2 unread) + OpenCode (error), one
owner mail and one injected member-to-member handoff (scripted via state file;
the public message API only sends as owner). At 1440 px: three aligned lanes,
correct spine variants (solid / dashed / broken), WAITING + blocked tags,
`2 messages waiting` + Start verb, `Start again` + Message on blocked,
handoff rows in both streams, `1 handoff, last 8:58 am Codex to Claude Code`,
polyline verified numerically (see above). At 1000 px: lanes stack,
streams capped, `handsvg` hidden, hands label wraps under the title — per the
prototype's stacking rules. Server stopped afterwards.

## Test summary (exact lines)

- `npx tsc --noEmit` — clean, no errors (run 08:44 and re-run after the
  parallel Board/Palette agents' Shell/types edits; their additions are
  additive optional props, no conflicts).
- `npx vitest run` — `Test Files 10 passed (10)` / `Tests 227 passed (227)`
  in 17.59 s.
- `npx vite build` — clean, `✓ built in 793ms`.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts` — three runs,
  all contaminated by parallel agents sharing this worktree and port 5174:
  run 1: 8 passed, 1 failed (`F17, F20-F22` on a `browserContext.close ...
  trace` ENOENT while another agent held the port), 8 did not run. Run 2
  (after `vite build`): 11 passed, 1 failed (`Usage` chip:
  `expect(locator).toBeVisible() failed, Locator: locator('.usage-chip')`)
  with an HMR reload of `Shell.tsx` by a parallel agent mid-run, 5 did not
  run. Run 3 (after a second `vite build`, clean: `✓ built in 712ms`):
  7 passed, 2 failed, 8 did not run — (1) `native-ui.spec.ts:115` on the same
  trace-file ENOENT race, (2) `ui.spec.ts:305 F17, F20-F22` on
  `expect(violations).toEqual([])` with 52 `Small text` violations, every one
  on Workbook surfaces (Home/Ask/Plan/Work/Review/Tasks/Documents/History copy
  at 12–13.5 px) while another agent has `styles.css` (+756/−? rework),
  `Workspace.tsx`, `App.tsx` and `Settings.tsx` mid-edit. No violation names
  any Team/lane element. None of the failures touch the Team files; the
  earlier failing tests passed on re-runs. A fully green browser run needs a
  worktree without concurrent edits — out of scope for this task.
- `npx tsc --noEmit` (final, after all parallel edits to date) — clean.
- `npx vitest run` (final, 09:02) — `Test Files 10 passed (10)` /
  `Tests 227 passed (227)` in 18.01 s.

Note (09:05): other agents are still editing `Shell.tsx`, `console.css`,
`styles.css`, `Workspace.tsx`, `App.tsx`, `Settings.tsx` in this worktree, so
the browser suite cannot get an uncontaminated run until they land.
`TeamView.tsx`, `team.css`, and the `TeamProps.onAddMember` addition are intact
and verified above. Do not commit (per task brief).
