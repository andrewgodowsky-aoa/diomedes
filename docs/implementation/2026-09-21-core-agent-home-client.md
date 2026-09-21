# Client implementation: Home Luna default and message-scoped Stop

Status: implemented for review. Scope is the client lane of
`2026-09-21-core-agent-home-luna-contract.md` only: the Diomedes page, its send module and its
tests. The server and shared lanes were concurrent and are not described here beyond what the
client depends on. Tests were authored but not run by this agent; the parent runs all commands,
builds and browser passes.

## What changed

### `client/conversation-send.ts`

- `DispatchIdentity` (`{ projectId, threadId, commandId }`) is the only thing a Stop may name.
  It is issued once, inside the Web Lock section, after the abort recheck and only when the
  pending claim was actually saved or adopted for dispatch. A claim found by the read-only
  outcome path never produces one.
- `sendMessage` and `resendPending` accept `onClaim`. The same-window `inFlight` join registers
  a caller's callback only after the input is proven equal, and every registered callback is
  told the same identity the moment it is issued. A second send with different words while one
  is unconfirmed still refuses with `earlier()` and issues nothing.
- `resendPending` fires `onClaim` only on the dispatch branch (the claim still pending under
  this command). The settled-read branch issues no identity, so a Stop beside a read can never
  reach a command.
- The locked section re-checks `signal?.aborted` before `save`/`dispatch`: a Stop that landed
  while this window waited on the lock writes nothing and sends nothing, and reports so with
  `stopped()` rather than `UnconfirmedMessage`, because nothing was ever at risk.
- `interruptMessage(projectId, threadId, commandId)` posts a strict `{}` body to
  `POST /api/projects/:id/threads/:threadId/messages/:commandId/interrupt`. It carries no run
  id and no engine. It never touches the pending claim: a transport acknowledgement is not a
  settled message.

### `client/console/Diomedes.tsx`

- New props: `route` (the recorded route, or the default a first send takes), `routeChoices`
  (null until a concrete thread exists), `onRoute`.
- `routeName(route)`: `aws-bedrock` reads `AWS Bedrock (Luna)`, `codex` and `sample` read as
  themselves, external engines read `ENGINE_NAMES`. The caption never substitutes another
  engine for the one the thread is on.
- `routeOptions(current, awsOffered)`: `claude-code` always; `aws-bedrock` while offered or
  while it is the current route; any other current route appended as itself. Two entries in
  the ordinary case, and the truth even when the current route is not sendable.
- The instrumentation line gains a route caption (`span.dio-route`). The composer bar gains a
  labelled `Route` combobox beside `In` and `Mode`, rendered only when `routeChoices` is
  non-null and `disabled` while a delivery is pending.

### `client/console/DiomedesHome.tsx`

- `ensure` still POSTs the provisioner on every send for both scopes (`/home/conversation` or
  `/projects/:id/conversation`): the provisioner is also where the route default lands and
  where an unmarked pin is migrated once, so a cached binding is never consulted for it.
  `GET /home/conversation` and state reads stay pure.
- `route` state is read from the conversation record on every load and after every send.
  `CONVERSATION_DEFAULT_ROUTE` supplies the caption before a thread exists. The AWS
  availability view (`GET /ai/model-api/aws-bedrock`, `awsPickerState`) feeds only what the
  Route control may offer; it is refreshed on each load and a failed read keeps the last answer.
- `pickRoute` writes the person's choice through the existing thread PUT
  (`/projects/:id/threads/:threadId`), which stamps `engineChoice: 'person'` server-side, and
  repaints from the saved record. A refused write restores the record's route and says why.
- `ActiveDelivery` per delivery: `{ controller, cancelled, issued }`. `deliver` checks
  `cancelled` after `where()` resolves and before `transport`, so a Stop during the provision
  or the lock wait never dispatches. `stopDelivery` aborts the delivery's own controller,
  releases its slot so a second press names nothing, and POSTs `interruptMessage` only when an
  identity was actually issued. `requested`/`settled` are left silent (the record supplies the
  durable answer); `idle`, `superseded`, 404 or a failed call show
  `Stop was not confirmed. Sending the message again checks what happened.` All interrupt
  outcomes are fenced on the visit number, so a late answer cannot publish into a newer visit.
- The Route control is offered only on the home scope and only once the thread exists:
  `routeChoices = scopeId === null && binding !== null ? routeOptions(...) : null`.

### `client/console/diomedes.css`

- `.dio-route` on the instrumentation line reads in `--t2`, the line's stronger colour.
- `.dio-field select:disabled` keeps the quiet colour while a delivery runs. The Route control
  inherits the existing `.dio-field` select styling; no new box was drawn.

## Guards and their tests

Unit (`tests/conversation-send.test.ts`, appended describe "the dispatch identity a Stop may
act on"):

- Issued identity names the saved command; `interruptMessage` posts to that command's path with
  a `{}` body (`the issued identity names the saved command...`).
- An interrupt acknowledgement clears nothing: the claim and the window reference stay pending
  and `lastCommand` is untouched (`an interrupt acknowledgement is not the outcome...`).
- A 404 interrupt surfaces as refused, not stopped.
- A pre-aborted send and a Stop that lands inside the lock before the save each write nothing
  and send nothing (`a send asked to stop before it began...`, `a Stop that lands inside the
  lock...`).
- A same-window join is issued the in-flight send's identity once (`a same-window join...`).
- A pending claim for different words refuses with no identity (`a pending claim for different
  words...`).
- Cross-window adoption of a pending claim issues that claim's command (`a send that adopts
  another window's pending claim...`).
- `resendPending` issues the claim's command when it dispatches, and none when it only reads a
  settled record (`a resend that still owes the message...`, `a resend that finds the message
  settled...`).
- A resend stopped while waiting for the lock touches nothing (`a resend stopped while it
  waited...`).

Unit (`tests/diomedes-page.test.ts`, new): `routeName` and `routeOptions` cover the Luna
caption, Claude Code named as itself, AWS offered/unavailable, and an off-list current route
kept visible.

Browser (`tests/diomedes-home.spec.ts`): the provider is now the scripted AWS boundary
(`secretBox: testOnlySecretBox()`, `modelApiTransport: awsTransport`, AWS connected and
spend-approved in `beforeAll`). The scripted Claude service stays installed and selected so the
second conversation route exists and remains choosable. Two assertions changed where the
contract superseded them: the provisioned thread now reads `aws-bedrock`, and the refusal test
flips `aws-bedrock` off and expects `Turn AWS Bedrock (GPT-5.6 Luna) on in Settings before
sending.` The R10c re-route case is restaged as what it now is: an unmarked pin written
straight into the store is re-pinned by the next send's provisioner call, while a marked choice
would be kept. Every other recovery case, the frozen R4 reproducer and the R13 closure are
unchanged.

Browser (`tests/home-luna.spec.ts`, new; `tests/fixtures/scripted-home-luna.ts`, new): the
fixture speaks the same `scripted()` answers at the real provider boundary (the HTTPS call the
model-API runtime makes), records every call in `seen`, and hangs on `SLOW` messages until the
abort signal rejects. The engine service discovers nothing, so no Claude login exists to fall
back to. Cases: Home opens on the Luna caption with no control until a thread exists, a first
send provisions `aws-bedrock` and the provider call shows the attached credential, endpoint,
model, tools and `store: false`; a project scope provisions the same route with no Route
control; AWS on but unconfigured refuses by name with no fallback; an unmarked pre-upgrade pin
migrates on the next send; a marked `claude-code` choice is kept and its refusal names Claude
Code; the Route control PUTs the choice and `engineChoice` reads `person`; the Stop arc sends
`SLOW`, waits for the provider call on the wire, asserts the interrupt POST names exactly the
claimed command with an empty body, then reads the recorded outcome as `interrupted` and
settles the pending claim through Send again.

The follow-up acceptance cases, same spec, all through the real delivery path:

- `a Stop while Home is still being provisioned sends nothing at all`: the provisioner's real
  answer is held at the response edge (it ran; only its arrival is held), Stop lands while the
  delivery still has nowhere to send, and after the response is let through there is no message
  POST, no interrupt POST, no provider call, no saved claim, and the words are back in the box.
- `a Stop while the send waits on the conversation lock sends nothing`: a second window holds
  the conversation's real Web Lock name, the send is observed queued on it via
  `navigator.locks.query()`, Stop is pressed, the hold is released, and nothing was saved, sent
  or interrupted. This is the delivery/UI half of the lock-wait case the unit suite covers at
  the module level.
- `a late interrupt answer cannot paint the scope the person moved to`: the interrupt reaches
  the real endpoint, its `idle` acknowledgement (a success that cannot confirm a stop) is held
  until the person is on a project scope that is visibly active, and the notice it would have
  raised stays out of that scope.
- `a late failed interrupt cannot paint a newer visit to the same scope`: same hold, a dropped
  answer, and home revisited through another scope, so the visit fence has moved within the
  same conversation. The unconfirmed strip the record still owes is not the interrupt's notice.
- `a Stop already answered names nothing again`: two presses on the same delivery faster than
  the abort settles produce exactly one interrupt request, and once the delivery is over its
  control is gone so a later press cannot exist.

## Review corrections

Independent review of candidate `b387059367cca89dfa32268793ac2132b748aeb3`
(`2026-09-21-core-agent-home-initial-review.md`) ran `tsc --noEmit` red with one error, TS2345
at `tests/home-luna.spec.ts:86`: the `painted` helper passed the `Promise<void>` resolver
straight to the inner `requestAnimationFrame`, whose callback is invoked with a timestamp
number. Corrected to `requestAnimationFrame(() => resolve())`, keeping the two-frame schedule
and every assertion. No rerun of tsc or of the suite has been executed by this lane; the
review's HSR-1 finding belongs to another author's fixture and is untouched here.

Browser review R1 of candidate `edbe2b041ddc3b005c2f6e840f94d915cf2ae2b4`
(`2026-09-21-core-agent-home-browser-review-r1.md`) ran three reproducers red; repaired as
follows. No rerun is claimed by this lane - the parent re-executes the unchanged reproducers
and removes each guard to verify red/restoration/green.

- HLR-01 (older route response repaints a newer choice): `pickRoute` fenced on the visit
  alone, so two choices in one visit shared a fence and an older answer could paint last.
  `DiomedesHome` now numbers each choice with a `routePick` ref; a response or refusal repaints
  or restores only while it is still the latest press in the same visit. The visit fence is
  unchanged. The frozen committed-choice reproducer covers the success branch; the added spec
  case `a superseded route choice that fails cannot restore what it replaced` covers the
  refusal branch (the older write's failure neither repaints nor notices once superseded).
- HLR-02 (migrated pending message shows the previous route): `deliver` refreshed `route`
  only after the answer arrived, so a provisioner migration was invisible while pending.
  `deliver` now reads the concrete thread the provisioner returned, after the cancellation
  check and before dispatch, and updates the caption from `conversation.engine` under the
  visit fence. `engineChoice: 'person'` is untouched - the thread stays the authority - and a
  failed read blocks nothing. A Stop landing during the read still prevents dispatch through
  the in-lock abort check.
- HCR-2 (Stop arc inspected the claim before the replay response arrived): test-only. The
  `Send again` click now registers a response wait naming that exact command's replay POST,
  asserts the replayed result is the command's durable record (`commandId` matches,
  `interrupted: true`), asserts the provider call count did not grow, waits for the delivery
  to finish, and only then keeps the original claim-cleared assertion. Every prior interrupt
  and identity assertion is unchanged.

Client re-review R2 of candidate `457419f236ccc7efd1f026e27b874f443c719a1b`
(`2026-09-21-core-agent-home-client-review-r2.md`) passed TypeScript, build, both unchanged
HLR counterexamples and all Home cases, but rejected one preflight read: the HLR-02 refresh
called `thread(found)`, the full project-state GET, before dispatch. Frozen CD05-R-05 injects
a single failed state GET after its warm-up; the new read consumed and suppressed that failure
(`home-client-r2-page.log` trace: route-refresh GET 503, message POST 200, post-confirmation
state GET 200), so the required `Transcript read failed` notice never appeared.

Corrected as directed: `deliver` now reads the bound thread through the existing narrow list
endpoint `GET /api/projects/:id/threads` (response `{ threads }`), selecting the concrete
`found.threadId`, via a new `listedThread` helper. The post-confirmation `show`/`load` state
read is untouched, so the frozen confirmed-POST/failed-state-GET split stays meaningful.
Marked choices, the `routePick` fences, visit ownership and the in-lock early-Stop check are
unchanged; no new endpoint, field, notice or test edit. No rerun is claimed by this lane.

Guard review R1 of candidate `f37f29a4068f6b9b6e3b6cce80eb46f685a938ae`
(`2026-09-21-core-agent-home-client-guards-review-r1.md`) executed surviving guard removals and
required four test-only closures, added without touching any source or frozen payload. No rerun
is claimed by this lane - the reviewer reapplies the unchanged mutation patches red, restores,
and runs green.

- HCG-1 / C4 (identity handed to a join after issuance): the existing join test queues behind
  issuance. Added `a same-window join after the identity was issued is handed it, not asked to
  wait` in `conversation-send.test.ts`: the second `sendMessage` joins only once the first POST
  is demonstrably on the wire, so `flight.claim` is already set. Both callers receive `uuid-1`
  once, share the one result, one POST runs.
- HCG-2 / C13 (Stop releases the active identity synchronously): the earlier duplicate case
  used two protocol-level dispatches. Added `two Stop presses in one JavaScript turn name the
  command once` in `home-luna.spec.ts`: both click events run inside a single `page.evaluate`
  before any continuation can settle the first press. One interrupt for the exact command, the
  pending strip keeps the message recoverable, the record shows `interrupted: true`, and the
  global pageerror check still applies. The later-Stop case is retained.
- HCG-3 / C22 (old delivery clears only its own active reference): added `a delivery left
  behind in an old visit cannot take the new Stop with it` in `home-luna.spec.ts`. Home's
  provision response is held after the real provisioner answered; the person moves to a project
  scope, whose delivery provisions, dispatches a held SLOW message and is issued its command;
  the old provision response is then released and its continuation allowed to finish. Stop
  still interrupts the newer command exactly once, one message POST ran (to the project
  thread), and the stopped message stays pending.
- HCG-4 / C2 (abort check at the resend's lock-callback entry): the queued-wait case is ended
  by the lock itself. Added `a resend stopped as the lock is granted reads and sends nothing`
  in `conversation-send.test.ts` with a labelled modeled boundary: a fixture lock manager that
  grants the request and aborts the signal in the same instant it invokes the callback, so only
  the callback-entry check can end the resend. No read, no POST, no issued identity; claim and
  reference unchanged.

Guard closure review R2 of candidate `ec25e4d58017c5cedc01f794c7c2cb4ca8663c05`
(`2026-09-21-core-agent-home-client-guards-review-r2.md`) recorded clean red/restoration/green
for unchanged C2/C4/C13 removals, and a masked failure path for C22/C26: the response waiter
outlived the test, the runner closed the page, and `unroute` errored at line 803. Three
test-only corrections; no rerun is claimed by this lane.

- HCG-5 / C22-C26 (missing interrupt must be an assertion, not a teardown error): the HCG-3
  case keeps its exact schedule, command identity, scope, one-POST and retained-pending
  assertions. The `waitForResponse` is replaced by a `response` listener collecting this
  command's interrupt acks plus a bounded `expect.poll(...).toBe(1)`: under the removal the
  missing interrupt fails as an ordinary assertion while the page is still open, so the
  finally's release/unroute still owns real cleanup.
- HCG-1 follow-through: the late-join test now counts each identity callback's invocations and
  asserts `[['uuid-1'], ['uuid-1']]` - each told exactly once - and releases the held mock
  request and drains both sends in `finally` whatever the assertions said.
- HCG-4 follow-through: the lock-entry test snapshots both stored records' raw bytes before the
  resend and compares the actual `localStorage` claim and `sessionStorage` reference against
  them after it, instead of reading the claim twice.

## Decisions kept

- Pending-claim, retry, discard, `inFlight` join, cross-window adoption and visit-fence
  semantics are unchanged; the new tests exist beside them, not over them.
- The interrupt acknowledgement never clears a claim and never reports a stop; the recorded
  outcome read remains the only confirmation.
- Stop is offered only while a delivery is pending, and names only that delivery's issued
  command. A Stop after resolution is a no-op.
- No timers, retries, cancellation store, provider setup, Workbook surface or `/ask` change.

## Outside-scope dependencies (owned by other lanes, not edited here)

- `playwright.config.ts` `testMatch` is an explicit list. The dependency is resolved: the
  config owner registered `home-luna.spec.ts` separately (discovery went from zero to the
  seven, now twelve, cases). This file was never in the client lane's write set.
- `tests/conversation-interrupt.test.ts` and the held-preparation abort case are the server
  lane's per the contract file plan.
- `shared/conversation.ts` (`InterruptResponse`, `InterruptState`), `shared/engines.ts`
  (`CONVERSATION_DEFAULT_ROUTE`, `isConversationRoute`) and `Conversation.engineChoice` landed
  from the server lane while this lane was in flight and are consumed here, not authored.
