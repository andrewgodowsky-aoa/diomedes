# Team wake — open questions (muse/team-wake, 2026-09-06)

Unsettled points from the wake task, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. Where is the recipient thread's permission read from?

- Options: (a) `Conversation.permission` on the member's `threadId`; (b) a new field on
  `TeamMember`; (c) the member's Session.
- Pick: (a). `Conversation.permission` already exists, `migrateConversation` defaults it to
  `'show-first'`, and the wake spec names "Conversation.permission". Missing conversation or
  missing field both fall back to `'show-first'`.

## 2. Exact wake text?

- Options: (a) `"From <sender name>: <content>"` joined by blank lines, oldest first;
  (b) include timestamps/message ids; (c) raw contents only.
- Pick: (a), exactly as the task states. Sender name is the sending member's `name`
  (`'Owner'` for `from: 'owner'`, raw slot id if the sender row is gone). Same renderer is
  used for auto-wake and the owner wake route.

## 3. What counts toward `unread` and the wake text?

- Options: (a) every unread message addressed to the slot; (b) only `type: 'message'`.
- Pick: (a). `shutdown_request` / `idle_notification` addressed to the slot are rare and the
  owner should see them when waking the helper. `TeamMember.unread` is filled by `teamState()`
  on the live objects, so it is also persisted into `state.json` (recomputed on every read).

## 4. Wake route error precedence (400 vs 503)?

- Options: (a) 400 `'Nothing is waiting for this helper.'` first, then 503
  `'Runs are not available here.'`; (b) the reverse.
- Pick: (a). Nothing-to-do beats service-unavailable, and it matches the order in the task.

## 5. Over-budget History entry — which helper is "cheap to call"?

- Options: (a) `store.addEntry` (pure in-memory push onto `state.history`, persisted with the
  state we already persist); (b) skip History.
- Pick: (a). One entry, `kind: 'team-wake'`, actor `'diomedes'`, e.g.
  `"Helper (Probe) has waiting messages; automatic wake paused for 10 minutes (budget reached)"`.
  No History entry is written for normal wakes.

## 6. Starter failures?

- Options: (a) auto-wake swallows the error and parks the member as `'waiting'` (a send must
  never fail because of the wake); the explicit wake route lets the error propagate (500 via
  the normal error handler). (b) fail the send too.
- Pick: (a).

## 7. Which deliveries can wake?

- Options: (a) only `sendAsMember` (team_send_message) and `ownerSendMessage`
  (POST /team/messages); (b) also lead interrupt / shutdown deliveries.
- Pick: (a), per the task. `team_interrupt_agent` / `team_shutdown_agent` deliveries do not
  wake, and `mcp.ts` needed no change (the sender already flows through `sendAsMember`).

## 8. Explicit wake of a `stopped` member?

- The task only says auto-wake skips `stopped` recipients. The owner wake route (`POST
  .../wake`) works regardless of status: the owner asked explicitly, so it starts the run
  (status becomes `'working'` via `acceptRun`) as long as there is unread mail and a starter.

## 9. Locking note for whoever wires the real starter (not this task)

- `maybeWake` calls the starter from inside the service methods, which the routes/MCP tools
  run under `store.locked`. A real starter that needs the store must not synchronously
  re-enter `store.locked` (it is a queue — re-entering from inside deadlocks). Do the
  store-dependent run setup asynchronously outside the lock, or restructure the call.
