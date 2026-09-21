# Proposed contract: Luna default for the Diomedes conversation and message-scoped Stop (third revision)

Status: proposed. Revised against the second independent review (HLC-R2 findings 1-3 and the native-ordering and provisionHome notes). Baseline `88b737b`; production implementation unchanged. This document resolves each remaining finding and returns to independent review before any code.

## 1. Decisions and supersessions

Unchanged from the previous revision: `aws-bedrock` (Luna) is the initial default route of the Home and every project Diomedes conversation, independent of the project's Work route; unconfigured AWS refuses by name with no fallback to Claude; supported routes remain selectable; consequential Home actions require an explicit target; Runtime, Store, Trust, command identity, and driver authority remain the owners. I-19 and I-20 are superseded as specified below, recorded in a new appended contract round. The three review records stay byte-for-byte unchanged.

## 2. Route policy, shared representation, migration

Shared representation (finding 3): `AWS_BEDROCK_ROUTE` is declared in `server/engines/aws-bedrock.ts`, which this lane must not edit and shared browser code must not import. The default is therefore a dependency-safe typed literal in `shared/engines.ts`: `CONVERSATION_DEFAULT_ROUTE: Route = 'aws-bedrock'`, checked by the existing `Route` union. Equality with the server constant is asserted by a test that imports both (`AWS_BEDROCK_ROUTE === CONVERSATION_DEFAULT_ROUTE`), so a server-side rename fails loudly rather than drifting.

Guard separation (finding carried forward): the supported-route predicate `isConversationRoute(route)` is defined beside the existing `isModelApiRoute` used by the send path and is reused by both the Home thread PUT guard and the send-path check, so update and send can never disagree. It accepts `claude-code` and model-API routes, refuses anything else by name, whole-request, before any field changes, keyed on `isHomeProject`. The default constant is used only by the two provisioners.

Choice marker and explicit path: `Conversation` in `shared/types.ts` gains `engineChoice?: 'person'`, stamped by the existing thread PUT route when the request body sets `engine`. For project conversations the existing explicit-choice path is the Console's per-thread engine picker, which the AWS lane already extended to offer AWS Bedrock when unblocked; it writes through the same PUT and is unchanged. That picker cannot see the hidden Home project, and this contract does not claim it does. For Home, the bounded UI change is identified exactly: `DiomedesHome` already loads the Home thread, so it derives `route` from `conversation.engine` and passes it to `<Diomedes>` as a new prop; `<Diomedes>` renders one route caption and, on the conversation scope, a compact two-entry route control (Claude Code; AWS Bedrock shown per the existing availability rule) writing through the existing PUT endpoint addressed by thread id. No settings page, wizard, or approval flow is added.

Adoption rule, identical in both provisioners, inside the existing lock, writing only when something changed: if the Diomedes thread's `engine` differs from `CONVERSATION_DEFAULT_ROUTE` and `engineChoice` is absent, set it and persist; `engineChoice: 'person'` is preserved.

Migration trigger, both halves now specified:

- Client: `DiomedesHome.ensure(null)` always POSTs `/home/conversation`, exactly as the project scope already POSTs its provisioner on every send. The cached binding no longer short-circuits Home.
- Store: `provisionHome`'s `if (bound) return bound` early return is amended so that, still inside the same lock, it loads state, finds the designated thread, applies the default/choice check above, persists only on change, and then returns the bound pair. An existing binding therefore still gets migrated by the same send-time call.

Reads stay pure: `GET /home/conversation`, project state reads, and `diomedesThread` never write. Compatibility effect stated plainly: unmarked historical pins migrate once at next send; a deliberate unmarked project re-route is re-pinned once and re-choosing through the picker then persists. Replays use the command's recorded runId and driver-by-prefix, never `thread.engine`, so old commands keep their original driver and identity after a re-pin.

## 3. Stop: endpoint, lookup, ordering

Endpoint: `POST /api/projects/:id/threads/:threadId/messages/:commandId/interrupt`, strict empty body, same `authorize` and `commandIdSchema` as its siblings. No client-supplied engine or runId exists to distrust.

Response (200), in `shared/conversation.ts`:

```
type InterruptState = 'requested' | 'settled' | 'idle' | 'superseded';
interface InterruptResponse { commandId: string; runId: string | null; state: InterruptState; }
```

Lookup (finding 1): `InteractionTurns.interrupt(projectId, threadId, commandId)` reuses the existing `InteractionHost.locate` that `outcome` already uses - no new lookup interface, no duplicated test hosts. `locate` finds the command's run through the driver's turn step. Its `settled` flag describes the run; `answered`/`turnResult` describe this message's result. The service returns `settled` only when the command's own recorded result exists; a terminal run with no recorded message result is not reported `settled`. No durable command -> 404, which is truthful at that instant and is not a promise the command will never run.

Driver surface, identical additive method on both drivers, using only the existing `active` map and `AbortController`:

```
interruptCommand(projectId, runId, commandId): Promise<{ state: 'requested' | 'idle' | 'superseded' }>
```

Body, on both drivers: first `await this.get(projectId, runId)`, the existing read that validates the run belongs to the project and surfaces unknown runs through the existing error path, so the method never ignores its project argument. Only then, in one synchronous block with no awaited gap: `const active = this.active.get(runId)`; no entry -> `idle`; `active.commandId !== commandId` -> `superseded`; otherwise `active.controller.abort()`; then `await active.promise.catch(() => undefined)` and return `requested`. On the native driver this is sufficient because that controller already feeds the admitted turn input via the existing `AbortSignal.any` merge; no control journal, no `session.interrupt()` call, and the existing general `control()` methods are preserved untouched. The recorded turn outcome remains the authority on both routes.

Ordering and the real gap, stated exactly (finding 2): `request()` installs its `active` entry synchronously while the asynchronous drive is starting, and `locate` sees the command only once the turn step is durable. So the windows are: before any durable command exists (interrupt -> 404); active installed but the abort-capable entry is exactly the one the compare checks (matched -> `requested`, mismatched -> `superseded`, absent -> `idle`). No window is hidden and none is claimed durable. A duplicate Stop after A settles answers from the durable record and need not repeat its first status; it is bound to A forever and can never affect B. An old Stop naming A while B is active answers `superseded` and aborts nothing. `requested` is a transport acknowledgement only; the confirmed interrupted outcome is read on the outcome read and on replay.

## 4. Client: cancellation, identity, timing

Pre-dispatch cancellation uses existing pieces only (finding 2): `deliver` keeps a per-delivery `cancelled` flag checked after `where()` resolves and before `transport`, so a Stop during ensure prevents dispatch entirely. Inside `sendMessage` and `resendPending`, the locked section re-checks `signal?.aborted` before `save`/`dispatch`, so a Stop that landed while waiting on the Web Lock saves and sends nothing. After dispatch, the existing transport abort does double duty: `stop.current.abort()` aborts the fetch, and the HTTP connection signal is already forwarded through `RequestContext` into the resolved input and merged into the admitted turn's signal - so a turn still in preparation observes it. A test holds a fake preparation step, aborts, and asserts the admitted input signal fired and no provider dispatch occurred, then reads the durable record for what it actually holds - unresolved or absent where the turn recorded nothing - rather than asserting a fabricated interrupted outcome. The recorded turn alone decides when interruption is confirmed.

Exact delivery identity (finding carried forward, restated): `sendMessage`/`resendPending` accept `onClaim`; the in-flight entry carries `commandId` plus registered claim callbacks. The same-window `inFlight` branch registers the caller's callback only after input equality is proven. A cross-window waiter fires `onClaim` only when the locked claim's input matches this delivery's; a mismatch still throws `earlier()` with no identity issued. `resendPending` fires `onClaim` only on the dispatch branch; the settled-read path issues no identity and permits no Stop POST. `stop()` aborts the controller, sets `cancelled`, and POSTs `interruptMessage` only for the `onClaim`-issued commandId captured this delivery; cleared in the same `finally` as `stop.current`. A post-resolution Stop is a no-op; `owns()` fences keep stale visits from publishing. There is no timer and no retry: a 404 or `idle` is displayed truthfully as "not confirmed stopped" and the pending delivery's own resolution or outcome read supplies the durable answer. Stop is offered only while the delivery is pending; since aborting the fetch can end pending promptly, no second press is promised - and any press that does occur names only the captured commandId, so it cannot reach a different command.

## 5. UI boundaries

As before: the Diomedes page is the visible default entry (route caption and Home-scope route control per section 2, named refusal on send, Stop while pending). The legacy `/ask` composer is unchanged, gains no Stop, and renders the existing named refusal-with-pointer when it resolves a model-API route; it never silently retargets Claude. Work Stop ownership and all work Modes are untouched.

## 6. Ownership and file plan

`server/harness/model-session-run.ts` is claimed for this implementation as `claim_mub7hn6w_6940be2f` under the authorized transfer; it receives only the additive `interruptCommand`. `server/engines/aws-bedrock.ts` and all residual AWS paths remain their owner's; nothing imports them from shared code. Files: `shared/engines.ts` (typed default literal, `isConversationRoute` beside `isModelApiRoute`); `shared/types.ts` (`engineChoice`); `shared/conversation.ts` (interrupt types); `server/store.ts` (both provisioners, including the `bound` early-return check); `server/app.ts` (PUT guard via predicate, `engineChoice` stamp, send-path predicate reuse, route mount); `server/engines/interaction-routes.ts`; `server/interaction-service.ts` (`interrupt` via `host.locate` and `driver()`); both session-run files (additive method); `client/conversation-send.ts`; `client/console/DiomedesHome.tsx` and `client/console/Diomedes.tsx` (ensure, stop wiring, route prop/control). New tests in `tests/conversation-interrupt.test.ts` plus Stop cases in `tests/conversation-send.test.ts` and `tests/diomedes-home.spec.ts`; a new appended contract round.

## 7. Acceptance matrix

Server: 400 malformed id, 400 non-empty body, 404 unknown/cross-thread command, 404 pre-durable command (truthful, not a never-run promise); `settled` only from the command's own recorded result; terminal-run-without-result -> `idle`; matched active -> `requested` with compare-and-abort atomic after the existing `get` validates project/run; B active + Stop for A -> `superseded`, B running; duplicate Stop bound to A, never affects B; `model-` run reaches the model driver after a re-pin; replay of an interrupted command confirms the recorded outcome on its original driver.

Store/routing: both provisioners default to `aws-bedrock`; the `bound` early return still re-pins inside the lock; `engineChoice` survives provisioning and restart; unmarked migrate once; Home PUT accepts `claude-code`/`aws-bedrock` and refuses `sample` whole-request; reads never write; unconfigured-AWS send refuses by name atomically with no Claude session (spy); shared literal equals `AWS_BEDROCK_ROUTE`.

Client: held-preparation abort propagates through the request signal to the admitted input, no provider dispatch follows, and the saved state is asserted as recorded (unresolved or absent where nothing was recorded), never as fabricated-interrupted; pre-ensure and lock-wait Stops dispatch nothing; post-dispatch Stop posts only the `onClaim` id; in-flight and cross-window identity rules as specified; resend-of-settled sends nothing; stale visits publish nothing.

Superseded expectations only: `claude-code` pin literals in `tests/project-conversation.test.ts`; Home refuses-supported-route cases in `tests/home-conversation.test.ts` (the r7 `sample` reproducer still passes unedited); pin assertions in `tests/diomedes-home.spec.ts`. Frozen admission and AWS oracles and the three review records are unedited. Every new guard gets removal/red/byte-restoration/green with survivors disclosed. Proposed, pending independent review before implementation.
