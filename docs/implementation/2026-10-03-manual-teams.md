# Free manual teams on the Board (S1), 2026-10-03

DIO-175 lane S1 and DIO-176, from the subscription-aware orchestration plan
(`deliverables/subscription-aware-orchestration-20261003/IMPLEMENTATION.md`, sections 4.8,
4.10, 5 S1, 6.5 and 7). Branch `feature/manual-teams` on `74d2a8c`. Owner: Andrew.

Free accounts use manual teams, so nothing in this lane calls the Agent gate or a managed
(Nectovia) route. One run per project and the five-wakes-per-ten-minutes limit are unchanged.

## What was built

1. **Assign from the Board (DIO-176).** `PUT /api/projects/:id/tasks/:taskId` accepts
   `assignedTo: string | null` from the person (`server/manual-teams.ts`,
   `applyTaskAssignment`). A string must be a current Team member's slot: an unknown slot is a
   400, a stopped member a 409, and the task is unchanged either way (the route runs under
   `store.locked()`, which reloads the task on a refusal). `null` clears. An Agent Team
   assignment (`ownedAssignment`) and a card whose work is running are refused with a 409. The
   same assignment again changes nothing and writes no History. History: "You assigned X to Y"
   and "You cleared the assignment of X" (kind `task-assigned`). The card's Assign control on
   Inbox, Ready and Blocked cards lists current members by their Console route names and offers
   Clear assignment. It replaces the Blocked-only "Route to", which the server ignored.
2. **Manual cards.** A manual team is the person-run Team: the project's TeamService members
   acting outside any Agent Team root. `taskCreateAsMember` gives their cards
   `{ ...emptyTaskWorkflow(), inbox: true, style: 'external-proposal', manual: true }`, unless
   the creator is the lead or member of an Agent Team exchange that is still open. The two
   fields are optional on `TaskWorkflow`; `workflowOf` copies them only when present, so an old
   record reads exactly as before. `admitWork` resolves a manual card's assigned member
   (`manualCardStart`), refuses a route other than the member's engine, skips the loop and the
   team options, and calls `nativeWork.start` with the member's engine, Agent and requested
   model and `manualSlot`, which keeps saved profiles from routing the run. The loop start
   (`native-loop-routes.ts`) and the trusted `requestTaskHandoff` refuse manual cards, so only
   the person's `/handoff` and `/approve-phase` move a manual card's phase. The Ready queue holds
   manual cards for the person. The task inspector shows the member's engine with the route
   source "The assigned Team member works through it". The Board's Start, drag and inspector
   send the member's engine (`boardStartRoute`), so the send dialog names it.
3. **Manual hand-off.** `shared/manual-handoff.ts` defines `ManualHandoff` exactly as briefed,
   strict zod validators with length caps (outcome 2,000 characters, at most 8 changed files of
   400 characters, 10 checks and 10 open issues of 300 characters, 500 records per project), and
   the coverage helper. `POST /api/projects/:id/handoffs` validates the body, the two live cards,
   the two members (each slot must be the one its card is assigned to; the member taking over
   must be current) and the changed files (this project's text documents, stored by the
   listing's own name), appends to `ProjectState.manualHandoffs`, writes History ("You handed
   off X to Y on Z", kind `manual-handoff`) and persists through the Store's durable write.
   `GET /api/projects/:id/handoffs?taskId=` lists the records touching a card, newest first.
   Every non-sample start of a card with a hand-off into it must send every file the hand-off
   names, or it is refused with a 409 naming them (N05). The Board's start dialog for that card
   starts with the hand-off files (N08). The form opens from a member's lane in the Team view and
   from the card on the Board; the next card shows "Hand-off from <member>" with the outcome,
   changed files, checks and open issues.
4. **Worker rows.** `shared/work-rows.ts` is the relay lane's file, copied byte for byte from
   `phone-relay-messages` and confirmed with `cmp`. `server/work-rows.ts` is the production
   `WorkRowsSource`: `session` rows for Sessions, `team-member` rows for a member's wake, a
   manual card's run or a member working with no Session yet, `h14-worker` and
   `external-worker` rows for the live H14 lead's children (an external engine route is an
   external worker). Payer by route: Nectovia `nectovia-credits`, model-API routes `your-key`,
   `codex`, `claude-code`, `opencode`, `cursor`, `devin` and `oh-my-pi` `your-subscription`,
   sample and fixtures `local`, anything else `unknown`. Labels are the Console route names (a
   managed row reads Nectovia). Verification is read from History with the pure H17 reader;
   `not-run` when there is no record. `GET /api/projects/:id/work/rows` returns the snapshot, and
   the existing `/api/events` listener sends a small `work-rows` event with only the snapshot,
   when it changed. The client hook (`client/work-rows.ts`) reads the endpoint and the event; the
   Team view shows the rows above its composer and the Agent conversation shows the running ones
   in a new `workers` slot. `app.locals.workRows` exposes the source for the relay.

## Choices

- "Removed member" is a stopped member: stopping is the Team's only removal and a stopped
  member never resumes. `'owner'` is not a member, so assigning to it is a 400; clearing is
  `null`.
- The same assignment is checked after the slot is validated and before the running and
  owned refusals, so a repeated click during a run is a harmless 200, while an unknown or
  stopped slot is still refused.
- A manual card runs only on a ChatGPT (`codex`) or Claude Code member. A model-API member
  would pass the Agent gate in `admitModelApi`, which S1 must never call; other routes are
  refused by name. The run carries no team tools and no slot: the Board's start is a versioned
  Work command, and team helpers are refused for those (`unsupported_work_target`).
- A manual card runs as its member was recorded, like a member's wake: the member's Agent and
  requested model (the route's default when it has none), with profiles not consulted.
- A member's status does not change during a manual card's run; the Team view lane reads the
  run from the Session of a manual card assigned to the member.
- Hand-off coverage (N05) applies to every non-sample start of a card that has a hand-off into
  it, compared case-insensitively as Work does. The hand-off's text never joins the instruction.
- A hand-off's slots must match the cards' assignees, so the record cannot disagree with the
  Board. Changed files must be text documents of the project, so the next card can always
  send them.
- Worker rows keep every active run and the three that ended last, cap titles at
  `WORK_ROW_TITLE_LIMIT` (80) on the server, title an H14 child by its lead's task (never the
  model-written handoff text), map an uncertain verification to `unverified`, label fixtures
  Sample and leave an H14 child's `startedAt` null (the view does not report it yet). Rows are
  read once per change and shared by every listener of that change.
- `LeadWorkers.tsx` was read and not reused: it renders one lead in full, with files, budgets
  and answers, which rows must never carry. The new `WorkerRows.tsx` uses the same verification
  badges.
- The compact slot in the Agent conversation shows the scoped project's running rows only, and
  nothing on All projects.
- `snapshot` answers null only for a project the source can't read. A readable project with no
  rows gets an empty snapshot, so the Console and the relay can clear rows that ended.
- The Board's control is now "Assign", so the existing checks that a row offers no "Route to"
  (`workbench-board.test.ts`, `native-ui.spec.ts`) check for no "Assign" instead.

## Known gaps

- `subscribe` listens to Store changes only, so an H14 child's progress that writes nothing to
  the project shows on the next project change.
- A member's mail wake binds to the member's first open assigned card. When that card is a
  manual card (as it was for every team-created card before S1), the wake path refuses it
  because the card has a workflow. Unchanged by this lane.
- The Team view's header point still reads members' own status only.

## Gates

Each ran under the coordination heavy slot, one at a time, on this tree.

- `npx tsc --noEmit`: exit 0, no diagnostics.
- `npx vitest run`: three full runs. Each ended `Test Files 1 failed | 561 passed (562)` and
  `Tests 1 failed | 9505 passed | 5 skipped (9511)`, with a different test failing each time:
  `automatic-work-host.test.ts` (a Team snapshot taken before the run's last write landed),
  `acp-session-runtime.test.ts` (a poll that timed out) and `run-store-reader-gate.test.ts` (a
  read ordering check). None of the three files is changed here, each passed in the other two
  full runs, and run together on their own they pass 45 of 45. The machine carried 82 node
  processes from other lanes.
- `npx vite build`: 2562 modules transformed, built in 7.64s.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`: 36 passed.
- `npx playwright test -c playwright.agent-team.config.ts`: 11 passed.
- `npx playwright test tests/task-board-ui.spec.ts` (changed, with the two new flows): 6 passed.

Focused: `tests/manual-teams.test.ts` 14 passed, `tests/work-rows.test.ts` 8 passed and
`tests/workbench-board.test.ts` 15 passed. The screenshots Playwright rewrote were restored.
