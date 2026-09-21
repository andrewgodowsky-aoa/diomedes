# Producer record: server lane of Home Luna and message-scoped Stop

Date: 2026-09-21. Base `ff02829ee626661e22d6019ab4088eef90f77658`, worktree
`diomedes-wt/core-agent-home-luna`. Implements the server half of
`2026-09-21-core-agent-home-luna-contract.md`, accepted as design in review r4. This record
describes what was written and what kills each guard's removal. It claims no test pass and no
acceptance; the parent runs the gates and the independent review judges the code.

## Exact changes

- `shared/engines.ts`: `CONVERSATION_DEFAULT_ROUTE: Route = 'aws-bedrock'`, a typed literal with
  no server import, and `isConversationRoute(value)`, which accepts `claude-code` and every
  model-API route via `isModelApiRoute` and refuses everything else.
- `shared/types.ts`: `Conversation.engineChoice?: 'person'`. Present only when the person set
  `engine` through the thread update; absent means provisioned, and a provisioner may re-pin it.
- `shared/conversation.ts`: `InterruptState = 'requested' | 'settled' | 'idle' | 'superseded'`
  and `InterruptResponse { commandId, runId, state }`.
- `server/store.ts`: `provisionHome` creates the home thread on the default route, re-pins an
  unmarked designated thread on the bound early return and on adoption, preserves a marked
  choice, persists only on change, inside the lock. `provisionProjectConversation` does the same
  for the thread `diomedesThread` picks, refuses the reserved home project, touches no sibling
  thread, and persists only on change.
- `server/app.ts`: the home thread update refuses a non-conversation `engine` with 409 before
  any field is written, keyed on `isHomeProject`; an explicit `engine` update stamps
  `engineChoice: 'person'`; the send path inside `resolve` refuses a non-conversation route and
  an unconfigured route by name before any lineage or turn is admitted.
- `server/interaction-service.ts`: `ConversationDriver` gains `interruptCommand(projectId,
  runId, commandId)`. `InteractionTurns.interrupt` locates the command through
  `InteractionHost.locate` across every lineage, resolves the owning driver from the recorded
  run id, answers `settled` when the command's own `turnResult` exists, and otherwise returns
  the driver's acknowledgement unchanged. No client-supplied run or engine is read.
- `server/engines/interaction-routes.ts`: `POST
  /api/projects/:id/threads/:threadId/messages/:commandId/interrupt`, strict empty body refused
  with 400 before the command is validated or located, then the existing authorization and
  error mapping.

## Guards and the tests that kill their removal

- `isConversationRoute` refusing `sample` on the home PUT: the r7 reproducer in
  `tests/home-conversation.test.ts` (`updateStatus: 409`) and the predicate case in
  `tests/home-luna-routing.test.ts`.
- Atomic refusal before any field: `R-17: a refused home engine change is whole` reads every
  writable field before and after the mixed request, across a restart.
- `engineChoice` stamp on explicit update: `the home update accepts a supported conversation
  route and records it as the person's` and `a route the person chose survives provisioning and
  restart`.
- Provisioner re-pin of unmarked threads, including the bound early return and crash adoption:
  `a bound home whose thread was never deliberately routed is re-pinned` and `an adopted
  pre-upgrade home thread is re-pinned`.
- Persist-only-on-change: the `persist` spy assertions in the re-pin test and in `a second send
  finds the same conversation and writes nothing at all` (project lane).
- Send-path refusal before admission: `unconfigured AWS is refused by name and nothing is
  admitted, sent or recorded` asserts the state file is byte-identical after the refusal.
- Strict empty body and command validation: `the interrupt endpoint names the command in its
  path and takes nothing else` covers malformed ids, every non-empty body shape, a missing
  project, an unknown command, and a cross-thread command.
- `settled` only from the command's own result, never fabricated from a terminal run: `an
  answered command is settled; a failed turn and a terminal run are idle`.
- `requested`/`superseded`/`idle` through the owning driver: `an active turn is requested to
  stop` and `a Stop for an older command while a newer one is active is superseded`.
- Driver resolution by run id after a route change, and replay on the original driver: `a Stop
  follows the command's own run across a route change, and replay keeps the original driver`.
- Pre-dispatch cancellation on the existing request-context signal: `a connection dropped while
  preparation is held aborts the admitted input and dispatches nothing` parks the fake Claude
  session's public `openSession` boundary while the turn step runs, aborts the HTTP client,
  waits until the server has observed the response close, then releases the gate. It asserts
  the admitted input's signal fired (the driver closes the freshly opened session and no
  provider turn is dispatched) and reads the saved command as it actually is: `interrupted:
  false`, outcome `unresolved`, Stop `idle`. This case is authored but currently unexecuted;
  the parent runs it and reports failures before any repair.
- `CONVERSATION_DEFAULT_ROUTE` equals `AWS_BEDROCK_ROUTE`: `the shared conversation default
  names the server-owned AWS Bedrock route`.

## Known limitations

- `requested` is a transport acknowledgement, not durable proof; the recorded turn and the
  outcome read stay the authority, and the tests assert that separation rather than a fabricated
  interrupted state.
- A Stop for a command that has not reached a durable turn answers 404, truthful at that
  instant; it is not a promise the command will never run.
- The pre-durable window between `active` installation and turn-step durability is the
  driver's, specified by the contract; no window is hidden and none is claimed durable.
- The work order forbade commands, so this author ran no test, typecheck or build on this
  lane. The parent's own executed run is recorded under Corrections below; this author's
  correction to it is likewise unexecuted pending the parent's rerun.
- The client lane (`conversation-send.ts`, `DiomedesHome.tsx`, `Diomedes.tsx`) and the driver
  lane (`model-session-run.ts`, `claude-session-run.ts`, already carrying `interruptCommand`)
  are other authors' files and are untouched here.

## Unresolved dependencies

- `driver(runId)` selects the model driver on the `model-` prefix and the native driver
  otherwise; that contract is the drivers lane's and is already satisfied in this worktree.
- `turnResult` non-null means a succeeded turn step; a failed turn leaves nothing to read, which
  is what makes its Stop `idle`. That semantic is the drivers' and is relied on, not re-decided.

## Corrections after the parent's initial executed review

- HSR-1. The parent executed the focused suite at candidate
  `b387059367cca89dfa32268793ac2132b748aeb3`: 140 tests passed including the held-preparation
  case above, and `the interrupt endpoint names the command in its path and takes nothing
  else` failed. Raw evidence is `home-initial-vitest.log` and `home-initial-results.json` in
  `F:/Diomedes/deliverables/core-agent-continuation-20260921/`; the review is
  `docs/implementation/2026-09-21-core-agent-home-initial-review.md`. The fixture had sent the
  scalar JSON body `'halt'` through the same loop as the three forbidden-object bodies and
  demanded the endpoint's `no body` wording for all four. The scalar is refused earlier by the
  app's strict JSON parser with `The request is not valid JSON or is too large.` The loop now
  covers only the object bodies with the endpoint wording check, and the scalar asserts the
  parser's own 400 response separately. Every payload and every 400 assertion is preserved;
  no production handling was changed. This correction has not been re-run by this author.
