# Proposed contract: Luna default for the Diomedes conversation and message-scoped Stop

Status: proposal for independent review before any code. Target integration: `feature/core-agent-bot` (PR #29). Base: 2120ae6. This document adopts Andrew's decisions; it does not close any open review gate and asserts nothing as built.

## 1. Decisions adopted and supersessions

Adopted, verbatim in effect:

- AWS Bedrock (`aws-bedrock`, the Luna model route) is the initial default route for the Home Diomedes conversation and for each project's Diomedes conversation.
- The conversation default is independent of the target project's Work route. `project.ai`, CD-1 selection, the saved Work route, and the "Use AWS for new work" card setting are untouched.
- A missing AWS connection, expired key, model mismatch, or zero spend authority refuses the send by name (the existing 409 path that names AWS Bedrock). It never falls back to Claude.
- Ordinary supported routes remain available. No API-only-forever policy is introduced. A person may still explicitly choose Claude Code on a Diomedes conversation.
- Consequential Home actions still require an explicit target project, never the last-used project. The existing `needs-target` and `home-is-not-a-target` outcomes are unchanged.
- Runtime, Store, Trust, command identity, and driver authority remain the owners they are today. No second scheduler, status store, or permissions engine is added.

Explicit supersessions, to be recorded in the implementation document (not by editing the historical review files):

- I-19 is superseded in part. The Home thread's engine is no longer pinned to the literal `claude-code`. The guard becomes: `PUT /api/projects/:id/threads/:threadId` refuses, for the reserved Home project, any engine that is not a supported conversation route (`claude-code` or a model-API route), with 409, before any field changes, still keyed on `isHomeProject`, never `settings.home`. Naming the current engine changes nothing. Name, permission, and Mode stay the thread's own.
- I-20 is superseded in part. `provisionProjectConversation` and `provisionHome` create and re-pin to the conversation default route (a named constant), not to literal `claude-code`.
- The three independent review records are not revised: `2026-09-21-core-agent-contract-review-r7.md`, `2026-09-21-core-agent-client-review-r2.md`, and `docs/implementation/cd01-bounded-review-20260921/` remain byte-for-byte unchanged. Supersession lives in a new appended round in `2026-09-20-core-agent-contract.md` and in this contract's implementation doc.

## 2. Route policy

Authority: `selectedEngine` in `shared/ai-selection.ts` remains the single selector. Order is unchanged: explicit `thread.engine`, then prior assistant turn route, then `project.ai`, then saved default. This contract changes what gets written into `thread.engine` for Diomedes conversations; it does not add a new selector or a settings platform.

- New constant `CONVERSATION_DEFAULT_ROUTE = AWS_BEDROCK_ROUTE` in `shared/engines.ts` beside `AWS_BEDROCK_ROUTE`. All four sites that today say literal `'claude-code'` for Diomedes conversations (two provisioning paths, the home PUT guard, the adoption re-pin) reference the constant.
- `provisionHome` creates the Home thread with `engine: CONVERSATION_DEFAULT_ROUTE`. `provisionProjectConversation` creates the project Diomedes thread the same way. Both keep the lock-held, write-only-when-changed, adopt-or-create semantics already proved.
- Explicit choice: a new optional thread field `engineChoice?: 'person'` is stamped by the thread update route whenever a person's PUT sets `engine`. Provisioning re-pins a Diomedes thread to the default only when `engineChoice` is absent. A person's explicit Claude Code selection is preserved across re-provisioning and restart.
- Unsupported update semantics: a PUT naming any route that is not `claude-code` or a registered model-API route is refused by name with 409, on Home and on project Diomedes threads alike (the send path already refuses these; the guard now matches it). Other threads are untouched by this contract.
- Send-time refusal is unchanged in mechanism: route off in Settings, missing/expired connection, or zero spend each produce the existing named 409. No silent re-route, no fallback.

Migration and write trigger:

- Existing Home threads are provably system-pinned: I-19 made re-routing Home impossible, so every `claude-code` Home pin is one the system wrote. `provisionHome` re-pins an unmarked Home thread to the default inside the same locked, only-when-changed write. This is the only migration, and it runs on the next ensure (POST conversation), which the client only calls on send.
- Project Diomedes threads: `provisionProjectConversation` re-pins adopted threads whose `engineChoice` is absent. A thread the person explicitly routed keeps its route.
- Reads never write. `GET /home/conversation`, project state reads, and `diomedesThread` selection create, repair, and re-pin nothing. A UI that only opens the page observes the old pin until the first send; that is accepted and disclosed, because the alternative is a read path that mutates.

Genuine user-policy ambiguity, flagged rather than resolved by fiat: on a project Diomedes thread that a person deliberately re-routed to Claude Code before this lands, there is no marker distinguishing that choice from the old system pin. Proposed default: unmarked threads are treated as system-pinned and migrate once, at next ensure. Cost: one person's deliberate project-level Claude pin is re-pinned once and they must re-choose it (which now sticks, via `engineChoice`). The alternative (never migrate unmarked threads) fails "initial default" for every existing install. Andrew confirms or reverses this one-line choice.

## 3. Message-scoped Stop: endpoint, lookup, ordering

Endpoint: `POST /api/projects/:id/threads/:threadId/messages/:commandId/interrupt`, mounted in `interaction-routes.ts`, strict empty body, same `authorize` and `commandIdSchema` as siblings. It never accepts an engine or runId from the client.

Response (200), added to `shared/conversation.ts`:

```
type InterruptState = 'requested' | 'settled' | 'idle' | 'superseded';
interface InterruptResponse { commandId: string; runId: string | null; state: InterruptState; }
```

- `requested`: the owning driver compared the active command to `commandId` and invoked abort this call, or an identical recorded interrupt replayed. This is not a claim of durable interruption.
- `settled`: the command's durable record is already terminal (answered, refused, or previously interrupted). Nothing was aborted.
- `idle`: the run exists but no turn is active. The command is voided so a not-yet-admitted request cannot run later.
- `superseded`: a different command is active on the run. Nothing was aborted.

Errors: 400 malformed commandId; 404 unknown thread or command (a command another thread or project owns is indistinguishable from unknown); 503 runtime unavailable. Durable truth after `requested` comes only from the existing outcome read (`GET .../messages/:commandId`) and the run record. Server and client both treat `requested` as a transport acknowledgement, never as proof.

Lookup: `InteractionTurns.interrupt(projectId, threadId, commandId)` resolves the command's run through the same durable record the outcome read uses (command to sourceMessageId to lineage/runId), then picks the driver by the recorded runId's `model-` prefix via the existing `driver()` helper. A route change after dispatch therefore cannot misroute the call, and a client-supplied engine cannot either, because none is accepted.

Ordering cases and the atomicity rule:

- Critical fact adopted as a requirement: the existing `control(commandId)` takes a control request id and aborts whatever is active on the run. The new call must bind interruption to the target command. Both drivers keep `active.commandId` and `controller`, so the binding is a synchronous compare of `this.active.get(runId).commandId === commandId` immediately before `controller.abort()`, with no `await` between the read and the abort. For the native driver the abort is `connection.session.interrupt()` inside the control step executor; the compare runs inside that executor, so the executor itself performs check-then-call with no awaited gap. A mismatch inside the executor returns a truthful `superseded` receipt rather than throwing.
- Duplicate Stop: the native driver keys its control step by the target commandId, so a duplicate replays the recorded receipt. The model driver re-runs compare-then-abort; an already-aborted controller makes it a no-op, and once the turn settles the service-level settled check answers `settled`.
- Unknown or pre-admission: 404 when no command record exists. When the command is admitted but not yet dispatched (the window between resolve and `request()`), the service sees a non-dispatched record and calls the driver; the driver records `commandId` in a per-run `voided` set and answers `idle`. `request()` rejects a voided `requestId` once, consuming the mark, before any controller is created. The mark is consumed on first use so a later deliberate Send again of that same command is not permanently blocked, and recorded replays (which require a dispatched record that never existed for a voided command) are unaffected.
- Route change: handled by the durable runId lookup above; a recorded `model-` run interrupts on the model driver even if the thread has since moved to Claude Code, and vice versa.
- New command on the same lineage: active command B, Stop names A. If A's record is settled the answer is `settled`; otherwise `superseded`. B is never aborted for A's sake.
- Old response after Stop: the message's own promise resolves or rejects as it would have; the outcome read remains the authority for what the turn became.

Additive driver surface (same contract on both drivers):

`interruptCommand(projectId, runId, commandId): Promise<{ state: InterruptState }>`

plus the `voided` set and its single check in `request()`. The native driver wraps the abort in its existing claim + control-step + park machinery for evidence; the model driver aborts the controller directly, matching its existing `control()`.

## 4. Client Stop timing

`client/conversation-send.ts`:

- New `interruptMessage(projectId, threadId, commandId)` posting the endpoint.
- Ownership is exact, not inferred: `sendMessage` and `resendPending` accept an `onClaim(commandId)` callback invoked inside the Web Lock when the claim this call will dispatch names this delivery's input. Reading a shared claim is not ownership; the callback fires only when the locked claim's input equals this delivery's normalized input (covering both the fresh-claim and shared-retry cases, since both are the same command). A mismatched claim means another window owns a different message; Stop then cancels locally only.
- Inside the locked section, before `save`/`dispatch`, re-check `signal.aborted`. A Stop that arrived while this call waited on the lock causes `UnconfirmedMessage` with nothing saved and nothing sent. Same check in `resendPending`. This closes the "waiting Stop later dispatches" hole.

`DiomedesHome.tsx`:

- `onStop` becomes `stop()`: capture the current visit fence (`turn.current`), abort `stop.current` as today, mark the delivery cancelled so a still-pending `ensure` resolves into no dispatch, and, if `onClaim` already delivered a commandId, POST the interrupt for exactly that commandId. On resolution, refresh via the existing `load(scope)` under the `owns()` fence.
- Stop after the response has arrived is a no-op: `stop.current` is cleared in `deliver`'s `finally`, and the page suppresses the POST when nothing is pending. A late Stop of a finished command can never name a newer command, because it carries the commandId captured at press time and the server compares against the active command regardless.
- Presentation stays ephemeral: an optional "stopping" affordance while the POST is in flight; durable status (stopped, answered, refused) is rendered only from the conversation/outcome read. Scope and visit fences are unchanged; a response landing after the person moved on mutates nothing.

## 5. UI boundaries

- The Diomedes page (`Diomedes.tsx` via `DiomedesHome.tsx`) is the visible default entry. Its route display and picker must show the AWS Bedrock default by name; when AWS is unconfigured the existing availability rule governs the picker, and a send on the default route produces the named refusal rather than a silent Claude substitution.
- The legacy Console `/ask` composer is unchanged in transport and gains no Stop. Where it resolves a conversation route that is a model-API route, the existing named refusal-with-pointer stands and renders; it is not a back door into the AWS-default Home thread, and it never silently retargets Claude.
- Work Stop ownership is preserved separately; this contract adds no Stop to work surfaces and expands no work Mode. Ask/Plan/auto and permissions on threads are unchanged.

## 6. Ownership constraint

`server/harness/model-session-run.ts` is claimed by the AWS lane owner (PID54288, `claim_muay9o8x_4fda3e50`). This contract does not edit it, bypass its private fields, or propose a parallel runtime. It specifies the exact additive patch for owner review and application or handoff: the `interruptCommand` method in section 3, a `private readonly voided = new Map<string, Set<string>>()`, and the consume-once `voided` check at the top of `request()`. No existing method body changes except that single inserted check. `claude-session-run.ts` is unclaimed and takes the equivalent change in this lane.

## 7. Bounded file plan

- `shared/engines.ts`: `CONVERSATION_DEFAULT_ROUTE`.
- `shared/types.ts`: `Conversation.engineChoice?: 'person'`.
- `shared/conversation.ts`: `InterruptState`, `InterruptResponse`.
- `server/store.ts`: default-route creation and marker-respecting re-pin in both provisioners.
- `server/app.ts`: superseded Home engine guard, `engineChoice` stamping in the thread PUT, durable command-to-run locate for `turns.interrupt`, mounting.
- `server/engines/interaction-routes.ts`: interrupt route.
- `server/interaction-service.ts`: `interrupt()` orchestration.
- `server/harness/claude-session-run.ts`: `interruptCommand`, `voided`, `request()` check.
- `server/harness/model-session-run.ts`: owner-applied equivalent per section 6.
- `client/conversation-send.ts`: `interruptMessage`, `onClaim`, aborted-signal re-checks.
- `client/console/DiomedesHome.tsx`: `stop()` wiring; `Diomedes.tsx` verify-only (Stop affordance already exists as `onStop`).
- Tests: new `tests/conversation-interrupt.test.ts`; revisions and additions below.
- Docs: appended round in `2026-09-20-core-agent-contract.md` recording the I-19/I-20 supersession; new implementation doc for this change.

## 8. Acceptance matrix

Server, HTTP level (fake transport, real app): malformed commandId 400; non-empty body 400; unknown command 404; cross-thread command 404; settled command returns `settled`; duplicate interrupt replays to the same answer; interrupt on a `model-` run reaches the model driver after the thread re-routes to Claude Code.

Store: Home provisions with `aws-bedrock`; second call writes nothing (persist spy); unmarked Home thread re-pins once inside the lock; `engineChoice: 'person'` survives provisioning and restart; project adoption re-pins unmarked, preserves marked, touches no other thread; Home refused by `provisionProjectConversation` with 409; unknown project 404; pure reads (GET home, state read) leave state bytes identical on a stale pin.

Drivers, real with fake transport: matching `interruptCommand` aborts exactly that turn; mismatched command leaves the active turn provably running (the compare-then-abort ordering test interleaves a new admission between lookup and control); voided command's first `request()` rejects before any step and consumes the mark; a different command on the same run still admits; `SESSION_IDLE` maps to `idle`, terminal run to `settled`; native duplicate replays the recorded step.

Service and flow: Home conversation sends on AWS with no Claude session created (spy); unconfigured AWS refuses by name, atomically, no partial turn or lineage; project flow end to end on the default route; Home consequential action without explicit target still returns `needs-target`; same command replayed after a route change reads its own record on its original driver; Stop of an old command on a lineage whose active command is newer returns `superseded`; fresh restart: binding, marker, and a recorded interrupt all survive.

Client: Stop before `ensure` resolves dispatches nothing; Stop during Web Lock wait saves and dispatches nothing (the in-lock re-check); Stop after dispatch POSTs the captured commandId only; Stop after response POSTs nothing; a claim whose input differs is never interrupted by this window; interrupt resolving after scope change mutates nothing; a command confirmed interrupted is shown only from the outcome read.

Guard mutations: every added authority check (Home route guard, marker check, active-command compare, voided check, in-lock abort re-check, claim-ownership check) gets red, removal, restoration, green, with any surviving removal disclosed by name.

Contract-driven test revisions (non-frozen, Claude-pin asserting): `tests/project-conversation.test.ts` (literal `claude-code` creation and pin assertions become `aws-bedrock` plus marker cases), `tests/home-conversation.test.ts` (I-19 guard cases re-targeted at unsupported routes, with `claude-code` and `aws-bedrock` both accepted), any engine-pinning cases in `tests/conversation-send.test.ts` and `tests/diomedes-home.spec.ts`. The three review records named in section 1 remain byte-for-byte unchanged.
