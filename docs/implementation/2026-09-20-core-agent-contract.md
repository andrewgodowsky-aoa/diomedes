# CD-01: frozen technical contract for Diomedes as the primary agent

Work order CD-01 of package CD-1, round 3. Lead: Opus. Independent review: Astra.

Base `dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19`. Every source claim below was
read in `F:/Diomedes/diomedes-wt/core-agent-contract` at that base. The
requirement-to-source map is
[`2026-09-20-core-agent-source-map.md`](2026-09-20-core-agent-source-map.md).
The reviews answered are
[round 1](2026-09-20-core-agent-contract-review.md) and
[round 2](2026-09-20-core-agent-contract-review-r2.md).

Nothing here is implemented. This freezes shapes and boundaries so CD-02 and
CD-05 can be written against one contract.

## Round 8: accepted, and the one obligation that came with it (2026-09-21)

Astra's round-7 review (`2026-09-21-core-agent-contract-review-r7.md`) is **accepted with
integrator obligations**. R-16, R-13 and her retained obligation O4 are closed, refusing Ask and
Plan on the direct route in home was ruled within bounds, and CD-02 and CD-05 may build against
the conversation seam as frozen. It is acceptance of a development seam, in her words, and not a
release or production certification. She also set a limit on I-18 that this document adopts: the
proved invariant is that a task-free home stays task-free under every current creation path. It
is not a sanitizer. A state file or journal written by an older development build, or edited by
hand, can still carry a home task, and nothing here rejects it.

One obligation came with the acceptance, O5, which closes her new finding CD01-R-17 (P3). It was
the residual round 7 had disclosed. Her reproducer was pasted into
`tests/home-conversation.test.ts` unchanged and run before anything was edited, and it failed
exactly as traced: `{ updateStatus: 200, messageStatus: 409, engine: 'sample' }`.

### I-19. The home thread's engine is not a thread setting

`PUT /api/projects/:id/threads/:threadId` refuses, for the home Project, any engine other than
`claude-code`, with 409 and before any field of the thread is touched. The check uses the reserved
Project identity (`isHomeProject`), never `settings.home`. Nothing is rewritten silently, and the
home read and provisioning are unchanged. The home thread's name, permission and Mode stay its own
to change: Answer only and Plan only are the conversation's own restrictions, and narrowing to
them has to stay possible. Naming `claude-code` is accepted and changes nothing.

Proved by three cases beside her reproducer's: a single request that renames, narrows the Mode
and re-routes is refused whole, an engine nobody offers is refused the same way, and the
conversation answers after a restart; home keeps every other control and still answers; an
ordinary project renames and re-routes a thread exactly as before. One guard removal (P1) is
killed by two of them. The message, selection and outcome shapes are untouched by this diff.

One thing the first of those cases surfaced, recorded so nobody chases it: loading a project fills
an absent `requested` with `null` on any thread (`migrateConversation`), and a reload between two
reads shows up as that one field changing. It is not a partial write, and the case reads the two
spellings as one.

This supersedes the first bullet under "What round 7 does not contain" below. The round-7 wording
"before it reads or changes anything" was also too strong, as the reviewer noted: the direct
route's guard follows the body parse and an in-memory read that picks the engine. What it
precedes is every change, every source-file read and everything sent.

## Round 7: the one defect review r6 found (2026-09-21)

Astra's round-6 review (`2026-09-21-core-agent-contract-review-r6.md`) closed all five round-5
findings and rejected the candidate on one new one. R-13 and her obligation O4 are narrowed to
that same defect. Her sandbox could not run Vitest, so the reproducer was a source trace. It was
pasted into `tests/interaction-seam.test.ts` unchanged and run before anything was edited, and it
failed exactly as traced: `{ status: 200, tasks: 1, sessions: 1, mode: 'build' }`. As in rounds 5
and 6, **where this section and the code disagree, the code and its tests are the candidate.**

| Finding | Closed by | Proved by |
|---|---|---|
| R-16 P2, the direct route starts Work in the home Project | I-18 | seam: her R-16 case; home: four R-16 cases |
| R-13 P2 and O4, home is never a Work target | I-18 | the same cases beside the 14 existing home cases |

### I-18. No task is made in the home Project, and the direct route is refused there

The home lane guarded the two admission paths, `createTaskFrom` and `admitWork`. The older direct
route, `POST /api/projects/:id/ask`, reaches Work through neither: its sample branch makes a task
and calls `WorkService.start`, and its native branch goes through `startCodexWork`. Guarding those
two call sites would have repeated the mistake, a list of entrances with the next one missing. So
the closure has two parts, and the first is the one that holds for every route.

1. **`Store.createTask` makes no task in the home Project.** It is the single place a task is
   made: every other caller in the server reaches it (the task route, plan tasks, both branches
   of the direct route, `bridge.start` with no task, the connections service, the team service).
   All three places a Work session is made, `WorkService.start`, `NativeWorkService.start` and
   `bridge.start`, require a task in the same project and refuse without one. A project that can
   hold no task can hold no Work session. The Store asks its own `isHomeProject`, which knows home
   by its reserved folder and not by `settings.home`, as r6 required. This is one invariant at one
   boundary. It is not a permission system and it consults nothing the Store did not already own.
2. **The direct route refuses the home Project for every mode, before it changes anything,
   reads a source file or sends anything** (wording corrected in Round 8)**.** Refusing only Build and Fix would satisfy the reproducer and leave two defects of
   the same kind, both run and confirmed before this change. Under Plan the route writes a plan
   file into the home folder and adds a plans entry. Under Ask, given the home thread, it sets
   `conversation.engine` to the requested route and `conversation.mode` to `ask`; the messages
   route then refuses every later message with "Select Claude Code for this conversation before
   sending", and home is hidden from every screen that could change it back. The route already
   refuses Automatic as "a conversation mode", so it was never the home conversation's entrance.
   Reads of the home Project, its threads, `/messages`, `/select` and the outcome read are
   untouched, and the first R-16 home case ends by sending the home conversation a message.

The two existing `refuseHomeWork` calls stay. They refuse before a command is parsed, with the
same sentence the Store now uses (`HOME_REFUSES_WORK`, exported once).

Six guard-removal mutations cover this. Removing the Store guard, the direct-route guard or the
Work route's guard is killed. Removing the task route's own guard **survives alone**: the Store
now refuses the same request with the same words one call later, the same shape as M4 beside N7
in round 6, which r6 read as sound. Removing it together with the Store guard is killed. Removing
both the Store guard and the direct-route guard is killed by four cases, including the native
Build case, which counts calls to an injected native generator and requires zero.

### What round 7 does not contain

- **Superseded by I-19 in Round 8.** A guard on `PUT /api/projects/:id/threads/:threadId`. A raw client can still change the home
  thread's engine or Mode through the ordinary thread update. That starts no Work and writes no
  file, so it is outside R-16 and H2; it is recorded here because it has the same effect on the
  conversation as the Ask case above. No screen can reach it, because home is never listed.
- Any change to an ordinary project. The fourth R-16 home case sends the same direct Build to an
  ordinary project and requires the task, the session and the thread exactly as before.
- Any change to `server/work.ts`, `server/native-work.ts` or `server/harness/bridge.ts`.

## Round 6: the five code defects review r5 found (2026-09-21)

Astra rejected the round-5 code (`2026-09-21-core-agent-contract-review-r5.md`) on five concrete
defects, each with a reproducer, and accepted the body binding, the terminal-write guard, the
selection mechanism, I-11 and I-12. Her sandbox cannot run Vitest, so every reproducer was a source
trace. Each one was pasted into `tests/interaction-seam.test.ts` and run before anything was
changed. Four failed as traced. The fifth failed for a different reason than traced, which is
recorded under I-17. As in round 5, **where this section and the code disagree, the code and its
tests are the candidate.**

| Finding | Closed by | Proved by |
|---|---|---|
| R-05 P2, a retry ignores the Mode control as it stands | I-13 | seam: three R-05 cases (crash after selection under Ask and Plan, crash after task admission) |
| R-15 P2, cancellation between a recorded input and its admission | I-14 | seam: two R-15 cases; driver: the claim race, the opt-in claim, `assertLive` |
| R-14 P2, a missing decision reads as answered | I-15 | seam: the R-14 missing-decision case over GET and POST, live and settled; pure: `outcomeOf` |
| R-03 P2, a repaired projection loses its evidence | I-16 | seam: the failed-projection case with a source file, a changed file and a changed account |
| R-10 P2, budget exhaustion never replaces the lineage | I-17 | seam: the R-10 case at the real Runtime refusal, with restart and replay |
| R-13 P3, the home validator (O4) | the merged home lane | `tests/home-conversation.test.ts`, 14 cases |

Nine guard-removal mutations cover these repairs. Each removes one guard, runs the suites named
above and restores the file byte for byte. All nine are killed.

### I-13. A command read back is held to the Mode control as it stands now

Supersedes nothing in I-10; it completes it. A command keeps the restriction it was bound to,
which is part of its body and is compared on every retry (I-8). What it may still *start* is a
separate question, answered by the narrower of that restriction and the thread's Mode at the
moment of the retry. `ResolvedMessage.control` carries it: for a new message it is the Mode the
message was sent with, and for a command read back it is the thread's current Mode. `message`
hands `control` to `settle`, exactly as `select` already handed `located.restriction`, so the two
routes can no longer disagree. Existing receipts stay readable; narrowing stops only an admission
that has not happened. A projection repair never writes `thread.mode`.

### I-14. Cancellation is effective at the admission boundary, in the Runtime's existing order

The run-cancel route cancels inside the Store lock (`server/harness/routes.ts`,
`store.locked(() => host.runs.cancel(...))`), so the order that already exists is Store lock
first, run queue second. Putting an admission inside the run queue would invert that order and
could deadlock against a cancel. The admission is therefore checked where it already runs:

- `InteractionHost.createTask` and `startWork` take the conversation run they come from
  (`AdmissionSource`), and the host calls `assertLive` on it inside the Store lock, before it
  admits anything. A cancellation through the route is either seen there or comes after the
  admission it would have stopped. Nothing new keeps state and no second permission check exists.
- `RunService.claim` takes `{ refuseSettled: true }` and refuses a settled run inside the run's
  own queue, where `cancel` is decided. The conversation driver's `append` always asks. A
  cancellation between the driver's inspection and its claim can no longer take the lease or move
  the fence. The option is opt-in; every other caller behaves exactly as before, and a test pins
  that.

A refusal here reaches the person as 409 `RUN_SETTLED`, and the message then reads as
`unresolved`. A task admitted before the cancellation stays, as the review requires: previously
admitted work is not undone.

### I-15. An outcome is read from what was recorded, on every route

Supersedes the sentence in I-9 that lets a settled run's unsaved decision be shown from memory.
The in-memory decision is deleted. `outcomeOf` returns `unresolved` whenever no decision phase is
recorded, settled or live, before it looks at any verdict; receipts and refusals are still read
first because they are authoritative with or without their phase. GET and POST now give the same
answer for the same record. On a live run a POST repairs the first phase before it reads, so this
changes nothing a person sees in the ordinary case.

### I-16. A projection repaired later is rebuilt from the turn itself

`ClaudeSessionRuns.evidence` returns the source files an answered turn carried (from its immutable
step input) and the origin the Runtime recorded on that step. On a replay `project` uses them for
both Turns' `sources` and for the answer's `origin`. It reads no file again and takes no model or
account from current settings. When the Runtime recorded no origin, the repaired Turn claims only
the model the runtime reported, and no requested model or account.

### I-17. A turn a budget refused was never sent, and the refusal is recognised

`RunService.step` writes the pending turn before it checks the budget, so a refused message leaves
a turn with no attempt. `locate` now reports `dispatched`. A turn that was never dispatched is not
an unfinished message on any lineage and does not stand in the way of the next generation. The
lineages are searched newest first, so once the replacement holds the command it is what a retry
or a restart finds; the refused turn stays on the old run as evidence.

The review traced `retirement` as catching the refusal. It never had. `EngineService` hands a
Runtime refusal it does not name to its callers as `RUNTIME_UNAVAILABLE` carrying the Runtime's
words, and the matcher only looked for the Runtime's own error type. Budget replacement had never
fired for any reason. Running the reproducer found this; reading the source had not. The matcher
now accepts both shapes and requires the Runtime's `budget exceeded` wording.

The reproducer lowers the admitted budget through the Runtime's own store to what the run has
used, instead of sending 128 messages (144 seconds). The refusal that follows is the real one:
`RunService` writes the pending turn, refuses it unsent and commits it, and the test asserts that
turn's state and attempt.

### What round 6 does not contain

Everything I-11 lists except the home Project, which is now merged (O4). The plan-lineage hop, a
portable handoff, conversational `control`, external sends and capability building remain
unclaimed. No client code is part of this candidate; CD-05b is on the integration branch.

---

## Round 5: the code that answers round 4 (2026-09-21)

Astra rejected round 4 (`2026-09-20-core-agent-contract-review-r4.md`, blob `206a652b`) on three
seams and asked for code and a fake-provider test, not a fifth round of prose. This section is
short on purpose: **where it and the code disagree, the code and its tests are the candidate.**
It supersedes the round-4 passages it names, which carry markers pointing here.

| Finding | Closed by | Proved by |
|---|---|---|
| R-03 P1, replay skipped the body check | I-8 | `tests/interaction-driver.test.ts`, `tests/interaction-seam.test.ts` (R-03 case) |
| R-14 P2, terminal replay could not write the phases it needed | I-9 | the same two files (settled-run and R-14 cases) |
| R-05 P2, explicit limits were redefined as advice | I-10 | `tests/interaction-admission.test.ts`, `tests/interaction-seam.test.ts` (C06 cases) |
| R-13 P3, home validator | not in this candidate; obligation O4 stands | none claimed |

I-12 is not an answer to a finding. It records a split the full test suite forced after the
Mode lane was merged, so that the contract and the code say the same thing.

### I-8. A reused command is compared before any answer comes back

Supersedes I-1 item 4, which relied on a guard the read path never reached.

The host reduces what the person sent to one **binding**: a digest of the parsed command alone
(`commandBinding`, `server/interaction-turn.ts`): text, mode, each source with its version and
order. It needs no setting, file or model, so it is computed first and still compares after any
of those change. It rides on `TextRequest.binding`, and the driver saves it in the turn step's
input. `ClaudeSessionRuns.replay` compares it before returning anything, and refuses a mismatch
with `intent_mismatch`, the code the `RunService` guard it stands in for already gave. A turn
saved before bindings existed compares the fields it did save (prompt, documents, transport
mode, source run, and the run's pinned instructions). The model and the account route are left
out on purpose: a read reaches no provider, and a person who changed model must still be able to
read what was said. A request that would generate anything still meets the scope check.

A refused retry produces no generation, no projection change and no admission. The seam test
asserts the project state and the run record are deep-equal before and after.

### I-9. An answered command is read first; a settled run is read and never touched

> **Superseded in part by Round 6, I-15.** No decision is shown from memory. A missing decision
> reads as `unresolved` on every route.

Supersedes I-2 item 2's "then I-3 step 4 runs against that run's phases" for settled runs, and
I-3's claim that one tail serves both paths on any run.

`drive` looks for the command's succeeded turn **before** the settled-run refusal, the scope
check and the claim, and hands it to `replay`. `replay` never calls `step` and never calls
`claim` (which would move a settled run's fence).

- **Live run:** the first phase a crash left unwritten is appended under a reacquired lease
  (startup recovery released the old one), with no model call, and the run is parked again.
  Admission may resume from the highest phase present.
- **Settled run** (cancelled, completed, failed, reconcile required): read only. Nothing is
  claimed, written, charged or admitted. `record` refuses it with `RUN_SETTLED`. Because
  `InteractionTurns.settle` saves each input phase **before** its admission, that refusal comes
  first and the admission is never reached: a cancelled conversation cannot start work. A
  missing first phase is never claimed to exist. The decision is recomputed in memory from the
  recorded answer only to say what was proposed, and the outcome is `unresolved`. Receipts
  found under the derived command ids are still authoritative and still read as started.

A replay returns exactly what the first request returned; nothing marks it as a replay, because
an existing test pins that equality and the settled-run refusal makes a marker unnecessary.

Phases are `transform` steps: pure, local, zero cost, charging neither budget counter. `record`
follows `control`'s idiom (resolve waits, write, park) and does nothing when nothing is missing.
`action-selected` is added to the phase names.

**No change to `server/engines/service.ts`.** It is held by another live session's claim. The
identity rides on the request as `TextRequest.interaction` (the issued id and a pure splitter),
the way `onPreview` already does, and the driver removes it before an adapter sees it. This
replaces the `decision?` callback I-3 put on `ClaudeSessionTurn`.

### I-10. Under Automatic, proposed work is shown; the person's selection starts it

> **Completed by Round 6, I-13 and I-14.** A retry is held to the Mode control as it stands now,
> and both admissions refuse when the conversation run has been cancelled.

**I-4 item 4 is withdrawn.** Astra's ruling stands: package 01 names natural-language limits
and selected modes separately, and a reviewer may not narrow that. Of the two exits Astra
named, this takes the deterministic one and leaves the guarantee whole. The other, model-only
enforcement, would need an owner decision and is not taken.

`admitInteraction` (`server/interaction-admission.ts`) never returns `escalate` on a model's
word. Work that passes every other rule is `proposed`: shown with its words and its target, and
not started. `POST …/messages/:commandId/select` carries the person's choice, bound to the
message (`sourceMessageId`), to `proposalDigest` (message, disposition, operation class, target,
summary and refs) and to the target project. A choice for another message, for reworded work or
for another project is `stale-selection` and records nothing. A matching choice is saved as the
`action-selected` phase **before** anything is admitted, and carries the same explicit consent a
Work start carries. Under Answer only and Plan only a selection is not read at all. The
restriction used is the narrower of the one saved with the answer and the Mode control as it
stands now, so narrowing the control after a proposal was shown means it can no longer start.

This asks for no confirmation of an ordinary answer, a read, or a step of work already admitted.
C06 is proved against an adversarial, schema-valid `act` proposal, not against a model.

### I-11. What this candidate does not contain

- **The plan-lineage hop** in decision 1's transition table. Under Automatic a `plan` proposal
  is answered on the `auto` lineage; no second run is started. Unclaimed.
- **A portable handoff** across a mode or lineage change. A new lineage starts without the
  earlier turns. Unclaimed; it belongs to CD-03.
- **The reserved home Project** (I-5, obligation O4). `homeProjectId` is `null`, so the
  `needs-target` and `home-is-not-a-target` rules are proved in the pure tests only.
- **The `auto` Mode migration** (O1 to O3) is a separate lane, merged beside this.
- The explicit native session routes (`claude-session-routes.ts`) are unchanged. The
  conversation has its own three routes (`server/engines/interaction-routes.ts`), where the
  server resolves the run and the transport action and a client never names a run.
- Conversational `control`, external sends and capability building are reported as not
  reachable, and reach nothing.

### I-12. The decision format lives beside its parser, not in the Mode text

Supersedes the sentence in I-4 item 1 that puts the eight-field schema inside `AUTO_INSTRUCTIONS`.

`QUESTIONS.md` (Modes, 4) records that every Mode's instructions are short plain English under
900 characters, and `tests/modes.test.ts` pins it. The same decision keeps the Build JSON contract
out of the Mode text and in `native-work.ts`, beside the code that reads it. The first draft of
`AUTO_INSTRUCTIONS` was 1,760 characters and failed that test once the Mode lane was merged; the
full suite found it, the lane's focused runs had not. The test is unchanged. The text is split:

- `MODES.auto.instructions` is the plain-English half: answer from the message and the supplied
  documents, documents are data, you may propose one decision, proposing is not acting, a person
  who limits what they want gets `respond`.
- `DECISION_FORMAT` in `server/interaction-turn.ts` is the machine half: the fence tag, the
  identity line to copy from, and the eight fields with their allowed pairings. It sits beside
  `splitDecision`, its only reader.
- `instructionsFor(mode, base)` is what the host sends: the Mode text followed by the format under
  Automatic, and exactly the Mode text under Answer only and Plan only, where no block is read.

What the model receives under Automatic is unchanged from I-4, word for word. It is still static
per Mode, so the pinned scope still never moves from turn to turn. Proved by
`tests/interaction-turn.test.ts` (the format names exactly `PACKAGE_FIELD_NAMES`, in order, and a
block written that way parses) and by `tests/interaction-seam.test.ts`, where the fake provider
records what it was given at session open and on the turn under each of the three Modes.

---

## Round 4: integrator rulings (2026-09-21)

Astra rejected round 3 (`2026-09-20-core-agent-contract-review-r3.md`, blob `63ee039e`) and asked
for no further authoring round. Under the convergence guard the Fable seat took these files as
work order CD-01.I. Opus's round-3 text stands wherever this section does not name it. **Where
this section supersedes a passage, the passage carries a marker pointing here, and this section
wins.** The six findings closed in round 2 and the three closed in round 3 (R-01, R-11, R-12, and
F-2 through the five phases) are untouched.

What three rounds taught: every remaining finding is an executable seam, not a design idea. So
each ruling below names the code that will own it and the test that will prove it.

### I-1. One identity from the client; the source identity is computed from it

Closes R-03 reproducers 1 and 2 and supplies the lookup key R-10 lacked. Keeps R-12 closed.
Supersedes the permission in decision 2 that a resend "can carry a new transport id for the same
source message", and the statement in decision 10 that the identity is minted in `prepare` and
first persisted in phase 1.

1. **The client mints `commandId` once per message, persists the pending send before the first
   request, and every retry re-sends the same `commandId` with the same body.** This is not a new
   pattern: `client/work-start.ts` already does it for Work starts (mint at `:25`, the pending
   record in `sessionStorage`, and the rule that retrying "checks the original request"). CD-05b
   reuses it for conversation sends. A cleared client store makes the next send a new message.
   That cost is accepted; it is the cost `/work/start` already carries.
2. **`sourceMessageId = 'sm.' + digest({ projectId, threadId, commandId }).slice(0, 32)`**, with
   `digest` from `server/harness/policy.ts:39`, which returns lowercase hex over canonical JSON.
   The result matches `ISSUED_SOURCE_ID` (`shared/interaction.ts:152`) by construction. It is
   issued by the server and never accepted from the client or recovered from the model.
3. **It is recomputable after any crash.** The turn step already persists `requestId`, which is
   the `commandId` (`server/harness/claude-session-run.ts:336-343`), and the run pins project and
   thread in its scope (`:83-90`). Reproducer 1 (crash after the model result, before phase 1) no
   longer loses the identity, because nothing had to be persisted for it to exist.
> **Superseded by Round 5, I-8.** The read path never reached that guard. A saved binding is compared before any answer is returned.

4. **A retry with the same `commandId` and a different body is refused by what already exists.**
   The turn step's intent includes the prompt, documents and mode, and `RunService` refuses a
   changed intent for an existing step id (`server/harness/run-service.ts:381-387`). No second
   digest store is added.
5. The model's echoed `sourceMessageId` must equal the computed value exactly, or the decision
   degrades to `respond` and `none` with `parsed: false`, as decision 10 already says.

### I-2. Replay is a read, and it is resolved before anything else

Closes the R-10 remainder. Supersedes the single "current non-retired generation" resolver in
decision 9 for the retry case only. New-lineage admission stays as decision 9 wrote it.

Inside `prepare`'s existing lock, before model selection, restriction and lineage resolution:

1. `findTurn(thread, commandId)`: walk `Conversation.lineages` newest first, **retired entries
   included**, read each run through the existing run read (`server/harness/host.ts:428-454`) and
   look for the step `stepKey('turn', commandId)`. A thread has few lineages; the walk is bounded.
> **Superseded in part by Round 5, I-8 and I-9.** The body is compared first, and a settled run is read and never written to.

2. **Found and succeeded: read-only replay.** Return the recorded output from the run record.
   No `RunService.step` call, because a cancelled or terminal run refuses `step` before it reaches
   cached output (`run-service.ts:592-606`); no scope comparison, no budget charge, no generation,
   and no resurrection of cancelled work. Live checks still run: the project and thread exist and
   the request is inside the single-owner local scope of H5. Then I-3 step 4 runs against that
   run's phases.
3. **Found, not succeeded, on the current lineage:** today's behaviour, unchanged (restore, resume
   or `RECONCILE_REQUIRED`).
4. **Found, not succeeded, on a retired lineage:** a visible `blocked` result saying the message
   did not finish before the conversation moved on. It is never regenerated silently.
5. **Not found:** a new message. Lineage resolution and generation proceed as decision 9.

**Generation rule.** The next generation is one more than the highest generation among all
entries, retired included. An empty `lineages` array is the only case that yields 1. Retiring a
lineage and admitting its replacement are one Store mutation under the lock, so a persisted
retirement can never be recovered without its replacement.

### I-3. The driver owns the phases; the app never touches a step

Closes R-14 and completes R-03. Supersedes the `reconcile?` and `decide?` hooks and the common
tail patch in decision 7. The five phases themselves stand, with two refusal phases added.

`ClaudeSessionRuns` holds the private owner (`claude-session-run.ts:107`, claimed at `:328`), and
`StepContext` has no sibling-append or run-read operation (`run-service.ts:77-96`). So there is no
callback into the app. The app hands the driver pure data and the driver writes the steps.

> **Superseded in part by Round 5, I-9.** The splitter rides on `TextRequest.interaction`, so
> `server/engines/service.ts` is unchanged, and `action-selected` joins the phase names.

```ts
// server/harness/claude-session-run.ts (not a hot file; applied in CD-02p)
export type InteractionPhaseName =
  | 'decision' | 'task-input' | 'task-receipt' | 'task-refused'
  | 'work-input' | 'work-receipt' | 'work-refused';
/** Pure data. The driver records each as one immutable pure, zero-cost, local step. */
export interface InteractionPhase { phase: InteractionPhaseName; sourceMessageId: string; body: Json }

// addition to ClaudeSessionTurn, beside the optional `preview?` at :68-72
/** Splits a committed answer into its text and its proposal. Pure: no I/O, no store, no model. */
decision?(answer: string): { answerText: string; body: Json };

// additions to ClaudeSessionRuns
/** Appends under the run's owner. Same phase and same body again is a no-op; a different body is refused. */
record(runId: string, phases: readonly InteractionPhase[]): Promise<void>;
/** The phases recorded for one source message, read from the run record. Never a step call. */
phases(runId: string, sourceMessageId: string): Promise<InteractionPhase[]>;
```

> **Superseded in part by Round 5, I-9.** The tail writes on a live run only. A settled run is never written to.

**Phase 1 is written by the driver inside `request()`**, in one tail that both the normal path and
the succeeded-turn early return (`:348-358`) pass through, before `park`. The step id is keyed and
immutable, so reaching the tail twice is a no-op. A crash between the turn commit and phase 1 is
repaired by the next request for that command, which replays and reaches the same tail. That is
the committed-turn-without-decision case.

**The executable sequence, with no cycle.** Route: `server/engines/claude-session-routes.ts:88-99`.

1. `prepare`, under its lock: I-2, the restriction of I-4, the lineage and the one resolved run
   id. Lock released.
2. `engines.claudeSession(...)`: the driver generates or replays and writes phase 1. No Store lock
   is held while the provider runs.
3. `recordResult`: transcript projection under its own lock, using `answerText`. Lock released.
4. `admit`, a new route dependency owned by `server/app.ts`. It reads `phases(runId, sm)` and asks
   `admitInteraction` (`server/interaction-admission.ts`, CD-02) for a verdict. On `escalate`:
   record `task-input`; take a **fresh** `store.locked` for task admission; release; record
   `task-receipt` or `task-refused`; record `work-input` carrying the receipt's task id; take a
   fresh `store.locked` for work admission; release; record `work-receipt` or `work-refused`.
   `RunService` steps need no Store lock and none is awaited under one, so decision 4 rule 3 holds.
5. **Step 4 resumes from the highest phase present on any later request for the same command.**
   Before it treats a missing receipt phase as "not admitted", it looks the receipt up by the
   derived command id in the target project's existing receipts. A receipt found without its phase
   is linked, never re-sent. This is F-2's closure and it covers every receipt-before-link gap.

**Refusals are evidence.** `task-refused` and `work-refused` carry the status and message of the
refusal, for example the 409 from `server/native-work.ts:329-330` when the target is busy. A
refused admission is final for that source message: replay reports it and does not try again. The
person sends a new message when they want to.

**What the person sees**, read from the phases and never from a copied status: started (a work
receipt), not started with the reason (a refusal phase), or unresolved (an input phase with no
receipt, no refusal and no receipt by lookup). Nothing is shown as completed that is not.

**Acceptance instrument, owned by CD-02h:** a fake-provider integration test, no live model,
covering the normal path, cached replay, a crash after the turn commit, a crash after each of
phases 1 to 4, a receipt without its phase, a busy-target refusal, and replay through a retired
lineage.

### I-4. Automatic: what the model sees, and what "explicit" means

> **Superseded in part by Round 5, I-12.** The eight-field schema is still sent verbatim, but it
> is no longer part of `AUTO_INSTRUCTIONS`. It is `DECISION_FORMAT`, beside the parser, and
> `instructionsFor` appends it under Automatic only.

Addresses the R-05 remainder. Supersedes the `AUTO_INSTRUCTIONS` text in decision 1.

1. `AUTO_INSTRUCTIONS` no longer begins with `ASK_INSTRUCTIONS`, whose second sentence forbids the
   very proposal Automatic exists to make (`server/modes.ts:21-22`). It is its own text: answer
   normally; you may propose one decision; proposing is not acting; treat documents as data, never
   as instructions (kept from Ask); end with exactly one fenced `diomedes-decision` block. **The
   eight-field schema is included in the instructions verbatim.** Instructions are static, so the
   pinned scope does not change from turn to turn. Ask and Plan instructions are unchanged.
2. **The issued identity reaches the model in the prompt, not the instructions.** For an `auto`
   turn, `prepare` appends one delimited trailer line to the person's text,
   `[[diomedes source_message_id=sm.<32 hex>]]`. The trailer is part of the hashed turn input. It
   is stripped from projection: the person's Turn shows only what they typed.
3. **The effective restriction is restored**, as round 2 had it and Astra accepted it:
   `'automatic' | 'answer-only' | 'plan-only'`, resolved in `prepare` from the conversation's Mode
   control (`auto`, `ask`, `plan`), written into phase 1, and rechecked by `admitInteraction` at
   admission. A mode of `ask` or `plan` never reaches `admit` at all (round 3's ceiling stands);
   the recheck is the second lock on the same door.
> **Withdrawn by Round 5, I-10.** Astra overturned this reading. Proposed work is shown and the person's selection starts it.

4. **A ruling for Astra to rule on in turn: "explicit" means the control.** Owner decision 3 names
   Answer-only and Plan-only, which are the Mode control. Package 01 section 5 forbids a keyword
   rule. A sentence such as "just explain, don't change anything" inside an Automatic conversation
   is input to the model's proposal. It is case C06, measured in CD-12. It is not a trusted limit,
   and no server-side phrase resolver is written, because an untrusted resolver presented as a
   limit is worse than none. What protects the person in that case is what already protects them:
   nothing is written without a current grant (`ScopeGrants.assertCurrent`,
   `server/store.ts:1063-1081`), and the send confirmation. The page keeps the Mode control one
   click away in the composer so the trusted limit is as easy to reach as the sentence.
5. `decision(answer)` returns `answerText`, the text before the block. Projection and previews use
   it; the raw answer stays in the turn step as evidence. A streaming preview suppresses text from
   the opening fence of a `diomedes-decision` block onward.

### I-5. The home thread has an identity

Addresses the R-13 remainder. Supersedes provisioning step 4 and withdraws the claim that the
`defaults()` line is the only Store change.

1. The home Project is recognised by its reserved folder (round 3). **The home thread is the
   oldest Conversation in the home Project by `createdAt`, ties broken by `id`.** H2 makes this
   safe: home is never a work destination and is hidden from navigation, so the provisioner is the
   only thing that creates a conversation there.
2. Provisioning runs inside one `store.locked`: find the project by its reserved folder, else
   create it; find that oldest conversation, else create one; write
   `settings.home = { projectId, threadId, revision: 1 }` **last**. A crash at any of those
   boundaries is repaired by running the same steps again. Nothing is duplicated, because each
   step adopts before it creates.
3. **The binding is validated, not trusted.** On load and on every use it is valid only if the
   project exists, its folder is the reserved folder and the thread exists in that project.
   Otherwise it is treated as absent and re-established by adoption.
4. **The server is the only writer.** `home` exists in `defaults()` so it is a known key, but
   `validateSettings` (`server/app.ts:214-218`) never copies it from a client body. The
   clone-and-whitelist pattern already works this way for `activeWorkspace`.
5. Returned patches, all CD-02h: `shared/types.ts` (`Settings.home`); `server/store.ts`
   (`defaults()`, validation in `migrateSettings` at `:133-168`, the provisioner);
   `server/app.ts` (`validateSettings` leaves `home` alone; the public `/projects` filter, which
   must not touch `Store.projects()` because startup recovery enumerates it at
   `server/harness/host.ts:545-554`).

### I-6. F-3 accepted as Astra's three obligations, plus the sites the compiler will not find

F3-O1, F3-O2 and F3-O3 are adopted as written in the round-3 review. The compiler enumerates the
exhaustive maps; it does not enumerate these, which are listed so they are migrated on purpose:
`server/modes.ts:97-102` (`modeOf` refuses `auto` at runtime), `server/store.ts:100-104` (the mode
recovery list), and the thread create and update ingress at `server/app.ts:2216` and `:2261`. The
four-mode picker arrays (`client/console/Composer.tsx:13`, `client/Workspace.tsx:48`) and the two
worker enums (`server/agents.ts:52`, `:263`) stay four-mode. Automatic is offered by the Diomedes
page and nowhere else.

### I-7. Corrections to the record

- The external claim `devin-acp-adapter-20260913.json` was ruled superseded by Andrew on
  2026-09-21: its work landed as `2237787`. `server/engines/service.ts` is an ordinary integrator
  patch in CD-02h. The carried-risk sentences in section 1d and section 1e are withdrawn.
- Landing pins: `tests/ui.spec.ts:105` and `:130` **change**. They assert the Projects heading
  immediately after opening and after reloading, and the launch is now the conversation.
  `tests/ui.spec.ts:1028` is **preserved**: it asserts Projects after navigating there. Filtering
  the home Project cannot preserve a launch heading, and round 3 was wrong to say it could.

---

## Round 3 changes

| Finding | Closed in |
|---|---|
| CD01-R-01 remainder P1, returning users do not launch on the conversation | Decision 3, "Launch". Normal launch opens the home conversation; the remembered project becomes navigation context. Exact `client/App.tsx` patches; pins table updated. |
| CD01-R-03 remainder P1 and integrator F-2, envelope cannot be executed in order | Decision 7, rewritten as five ordered append-only phases. No predicted task id, no field filled in later. Reconciliation entry, hook placement, retry-by-source-identity and both partial outcomes. |
| CD01-R-05 remainder P2, Automatic prompt, output and ceilings | Decision 1, rewritten. `auto` becomes a real mode with its own instructions, a frozen output wrapper, invalid-output handling, a complete transition table, and ceilings stated as actual supported actions. |
| CD01-R-10 P2, one permanent run id has no continuation path | Decision 9, new. Admitted lineage generations stored on the `Conversation` record. |
| CD01-R-11 P2, progress events name a different run | Decision 9, "One resolved run id", with the `server/app.ts` patch. |
| CD01-R-12 P2, two identity policies across the bridge | Decision 10, new. One issued trusted source identity, `sm.` plus 32 hex. |
| CD01-R-13 P2, home binding has no owner or patch seam | Decision 3, "Provisioning and its owner", with exact `shared/types.ts` and `server/store.ts` patches, a collision rule and lookup-or-adopt recovery. |

Findings closed in round 2 stay closed: R-02, R-04, R-06, R-07, R-08, R-09.
Two of them are touched only where a round-3 finding forces it, and each is
noted where it happens:

- **R-06** is untouched. The proposal parser keeps exact fixture parity and all
  11 counterexamples pass unedited. Decision 10 constrains what the *server*
  issues, never what the parser accepts.
- **R-07** keeps the link in run evidence. Decision 7 changes it from one
  envelope step to five phase steps, because a single step cannot be amended.

### Two reversals, stated plainly

Round 2 said "Automatic is not a fifth mode" and designed a lineage derivation
to avoid a `shared/types.ts` change. Both were wrong, and both were wrong for
the same reason: they contorted the design to avoid a hot file.

1. **`auto` is now a real mode.** Automatic needs its own pinned instructions,
   which makes it a distinct scope. Modelling it as a restriction riding on
   `ask` would have made Automatic and explicit Ask two lineages on one thread
   and added a third dimension to every binding and transition. It is a mode.
2. **The lineage binding is stored, not derived.** The round-2 fixed derivation
   from `(project, thread, mode)` produced R-10 and R-11.

Hot-file patches were always permitted as returned patches. Every one this
contract needs is written out in full below and marked with its owning lane.

## 0. What is settled before this document starts

Diomedes is the primary persistent conversational agent and the page the app
opens to, for first and returning users alike. It adds no second runtime,
scheduler, permissions engine, task-status store or file store. The model
proposes an interaction decision; deterministic admission decides. Greetings and
brainstorming create no visible task. Explicit Answer-only and Plan-only limits
always win. Build stays proposal-only. A retry of the same source message admits
no duplicate work.

Confirmed by Andrew on 2026-09-21: the reserved workspace home Project holds the
landing conversation under conditions H1 to H6; it is filtered from the public
Projects listing, navigation and Files, and provisioned on the first landing
message; Automatic is the default for a new conversation; the last-opened
fallback at `client/console/Home.tsx:142` is deleted and a job with no named
target gets a question; Build stays unreachable from the conversational path in
the first slice. None of these is marked pending.

`AGENTS.md` decision 14 says a capability composes and never parallels, and
never introduces a second runtime or permission model. `AGENTS.md` Trust says
configuration cannot revive spent or revoked authority.

## 1a. The minimal additive shapes

Six shapes. None is a new store.

| Shape | Rides on | Why no new store |
|---|---|---|
| Workspace agent binding | `Settings`, with `WorkspaceRef` (`shared/workspaces.ts:42`) | References and a revision. Patch in decision 3. |
| Workspace home Project | An ordinary Project and `Conversation` | It is a Project. Every Store, RunService and Files contract already accepts one. |
| Conversation scope | The run input. `scope(input)` (`server/harness/claude-session-run.ts:83-90`) is what `SESSION_MISMATCH` compares | A second copy of scope is a second authority. |
| Conversation lineages | The `Conversation` record | One optional array. Patch in decision 9. |
| Interaction decision | One `RunService` step, `kind: 'transform'`, `effect: 'pure'`, `cost: 0` | Immutable, hashed, ordered, replayable. Decision 6. |
| Admission phases | Four further steps on the same run | Receipts already exist and are authoritative. The phases hold references, never copies of their state. Decision 7. |

Nothing above copies changing run state into a separate status record, which
package 02 §3 forbids.

## 1b. The decisions

### Decision 1: modes, explicit limits and Automatic

**Decision.** Keep `instructions` inside the run scope. One durable run per
`(project, thread, mode, generation)`. `auto` is a real mode with its own
instructions. A mode change starts a new run with a portable handoff.

Taking `instructions` out of `scope` would weaken `SESSION_MISMATCH`
(`claude-session-run.ts:326-327`), the only thing stopping a conversation
admitted under Ask from continuing under wider instructions on the same provider
lineage. It is pinned by `tests/claude-session-runtime.test.ts:517`. Fork cannot
change mode either (`:298-302`).

#### `auto` as a mode, and the returned patches

> **Superseded in part by Round 4, I-4.** `AUTO_INSTRUCTIONS` is its own text and no longer begins with the Ask instructions; it carries the schema, and the issued identity travels in the prompt.

**Returned to the integrator, lane CD-02h.** `shared/types.ts:28`:

```ts
-export type Mode = 'ask' | 'plan' | 'build' | 'fix';
+export type Mode = 'ask' | 'plan' | 'auto' | 'build' | 'fix';
```

`server/modes.ts`, a new instruction constant and a new `MODES` entry. Ask and
Plan instruction text is unchanged, as the review requires:

```ts
const AUTO_INSTRUCTIONS =
  `${ASK_INSTRUCTIONS}\n\n` +
  'After your answer, and only if this message asks for something beyond an ' +
  'answer, add one fenced block tagged diomedes-decision containing a single ' +
  'JSON object and nothing else. Omit the block entirely when an answer is the ' +
  'whole response. Never describe the block in your answer.';
```

```ts
  auto: {
    id: 'auto',
    name: 'Automatic',
    workbook: { caption: 'Diomedes answers, and says when something needs doing.', placeholder: 'Ask Diomedes...' },
    console: { placeholder: 'Ask Diomedes...' },
    instructions: AUTO_INSTRUCTIONS,
    effort: 'low',
    output: 'text',
    writes: 'none',
    consent: 'sending-setting',
  },
```

`writes: 'none'` is deliberate. `auto` never writes by virtue of its mode; work
reaches the existing Build path only through admission, below.

> **Superseded by Round 5, I-11.** The explicit session route keeps `z.enum(['ask', 'plan'])`.
> Automatic runs only through the conversation's own routes (`interaction-routes.ts`), where the
> server resolves the run; a client can never name a run and ask for `auto` on it. The `auto`
> round trip O1 asks for is proved through those routes in `tests/interaction-seam.test.ts`.

**Returned to the integrator, lane CD-02h.** `server/engines/claude-session-routes.ts:16`
(CD-02 may apply this one directly, it is not a hot file):

```ts
-  mode: z.enum(['ask', 'plan']),
+  mode: z.enum(['ask', 'plan', 'auto']),
```

Because `MODES[command.mode].instructions` is what gets pinned
(`server/app.ts:2361`), `auto` is automatically a distinct scope and therefore a
distinct lineage. Switching between Automatic and Answer-only is an ordinary
mode switch, already covered by the new-run-with-handoff rule.

#### The output wrapper, and what happens when it is not honoured

The turn returns text. Parsing is deterministic and happens server-side:

1. Take the **last** fenced block tagged `diomedes-decision`. Everything before
   it is the ordinary answer and is what the person reads.
2. No block: the decision is `respond` / `none`, and the whole text is the
   answer. This is the common case and is not an error.
3. A block that is not valid JSON, or that fails
   `interactionDecisionSchema`, or whose `sourceMessageId` is not exactly the
   issued identity (decision 10): the decision is **`respond` / `none`** and the
   answer is the text before the block. The raw block is recorded verbatim in
   the decision phase with `parsed: false`.

Rule 3 degrades to the narrowest disposition and never to a wider one. There is
no second model call to repair output, no retry and no guessing. A malformed
proposal is not a proposal.

#### Ceilings are actual actions, not labels

The review's point is the operative one: `admitWork` forwards no mode
(`server/app.ts:1842-1863`) and native work defaults to Build
(`server/native-work.ts:350`), so a label cannot be a ceiling.

| Mode | What admission may do |
|---|---|
| `ask` | Nothing. `admitWork` is never called, whatever the text contains. Ask has no write path at all. |
| `plan` | Nothing. The plan text returned by the plan run is the entire result, exactly as `server/modes.ts:24-25` says. `prepare_artifact` under `plan` admits no work. |
| `auto` | May call `admitWork`. Nothing else may. |

So `act` / `prepare_artifact` does not become a business-artifact job because a
ceiling admits the same label. It becomes one only under `auto`, and then it
runs through the existing path as a **Build proposal**, because that is what
`native-work.ts:350` gives and this contract adds no mode to native work. The
person is told that is what it is.

#### Transition table

Under `auto`, **every message is evaluated on the `auto` lineage first**. That
makes "which recorded turn identifies an ordinary question after a plan"
unambiguous: the `auto` lineage turn for that message, always.

| State | Mode | Message | Runs on | Then |
|---|---|---|---|---|
| No lineage | `auto` | first message | new `auto` lineage, generation 1 | Automatic is the default for a new conversation. |
| `auto` lineage current | `auto` | no decision block | the `auto` lineage | Answer only. Nothing else happens. |
| `auto` lineage current | `auto` | decision proposes `plan` | the `auto` lineage, then the current `plan` lineage | If no `plan` lineage exists, admit generation 1. |
| `plan` lineage exists | `auto` | a second `plan` proposal | the `auto` lineage, then the **existing current** `plan` lineage | Reuse. A second plan message never opens a second plan lineage. |
| `plan` lineage exists | `auto` | an ordinary question | the `auto` lineage only | The `auto` turn is what identifies it as ordinary. The plan lineage is untouched. |
| any | `ask` | any | the `ask` lineage | Admission does nothing. |
| any | `plan` | any | the `plan` lineage | Admission does nothing. |

Every model call that interprets a message runs inside a recorded run as an
ordinary step. There is no classifier call outside a run.

### Decision 2: the cross-family binding for C21

> **Superseded in part by Round 4, I-1.** A resend never carries a new transport id. The client retries with the same `commandId`, and the source identity is computed from it.

Unchanged from round 2 except that the identity it hashes is now the issued
trusted identity of decision 10, and the payloads it identifies are now written
in phases (decision 7).

```
taskCommandId = 'conv.' + digest({ family: 'task.create', sourceMessageId }).slice(0, 40)
workCommandId = 'conv.' + digest({ family: 'work.start',  sourceMessageId }).slice(0, 40)
```

Both are 45 characters and match `commandIdSchema`
(`server/command-admission.ts:9`). `family` is inside the digest so the two ids
differ. The derivation is pure: no clock, no randomness.

An escalated act cannot go straight to `work.start`.
`NativeWorkService.start` throws 404 without a task
(`server/native-work.ts:331-332`), and `task.create` carries its own command id
(`server/task-admission.ts:14`). Deriving only the work id would let a retried
message mint a second task.

**Returned to CD-02** (`server/work-admission.ts`, not a hot file). Add to
`requestSchema` after `agentId` (`:24`):

```ts
  // Present only when this work was escalated from a conversation. Naming a
  // different source is a different request, exactly as agentId above.
  sourceCommandId: issuedSourceId.optional(),
```

and to the canonical payload after `:80`:

```ts
    ...(request.sourceCommandId ? { sourceCommandId: request.sourceCommandId } : {}),
```

`issuedSourceId` is decision 10's shared validator, which is how R-12's
length disagreement is removed rather than restated. The conditional spread is
required: an unconditional `?? null` would change the digest of every receipt
written before the field existed and break its replay, which is what the comment
at `:77-79` says about `agentId`.

The patch changes the digest input. It does not persist the source id, and this
contract no longer claims it does. `parseWorkCommand` returns only `commandId`
and `payloadDigest` (`:86-90`), `admitWork` passes only that
(`server/app.ts:1862`), and `Store.recordWorkAdmission` persists only that
(`server/store.ts:600-609`). The durable link lives in the phases.

### Decision 3: the workspace home, and launch

**Decision, confirmed by the owner.** A reserved workspace home Project holding
a real home thread is the execution home for the landing conversation, and the
home conversation is the normal launch destination.

The routes require a project and a thread
(`server/engines/claude-session-routes.ts:14`, `:47`) and generation runs under a
project principal (`server/harness/claude-session-run.ts:278`, `:287`), so an
unbound landing has nowhere to generate or record.

#### The six binding conditions

**H1. Deterministic provisioning, never the host test project.** Created and
bound through the existing Project and Settings paths, with the identity and
collision rule below. A retry finds the same home Project and thread. Never
`HOST_TEST_PROJECT`, which is deliberately unreadable to customers
(`server/harness/host.ts:424-426` refuses it by name).

**H2. Home is a conversation container, never a work destination.** Never the
fallback target for a job, never an alias for the last-used project. A message
needing a target that names none gets `clarify`.

**H3. Target resolution.** C14 resolves the explicitly named authorized target
and pins it. C15, with no target and no authorized default, asks the missing
question without admitting effectful work. The last-opened repository is never
used, which requires deleting the `?? byRecency[0]` fallback at
`client/console/Home.tsx:142`. C13 keeps each admitted job's original target
when the visible workspace changes.

**H4. Work is admitted in the target and linked back.** Task and work admission
run in the target project through the existing locked admission and Trust path
(decision 4), and target receipts are linked to the originating message through
the phases (decision 7). The home thread id is never passed into another
project: `admitWork` looks a supplied `threadId` up in the target project's own
conversations and 404s otherwise (`server/app.ts:1795-1798`). An escalation
supplies a target-project thread or none.

**H5. Single-owner local scope; business use blocked, not advertised.** The
principal is hardcoded `id: 'local-client'`, `tenantId: 'local'`
(`server/harness/bridge.ts:22-28`), and route authorization only establishes
that the project exists (`server/app.ts:2318-2319` into
`server/store.ts:494-497`). That is a local project-address check, not
organization membership. Business or shared-audience use is blocked until the
accepted identity and context path binds participant, tenant, audience, project
and current access before read and before egress. It is not described as ready,
anywhere.

**H6. The home prompt reads only home.** Before CD-03 a home turn uses its own
transcript and explicitly selected home sources and nothing else. Preparation
reads only the route project's documents (`server/app.ts:2345`). Naming another
project's id is neither read permission nor consent to send its material to a
provider. Returning a target result into home is egress and needs an eligible
audience check; work admission is not egress authority.

#### Provisioning and its owner

> **Superseded in part by Round 4, I-5.** Step 4 now has a rule for recognising the home thread, the binding is validated rather than trusted, and the Store changes are more than one line.

**Owner: CD-02h**, the server lane. Round 2 said no `shared/types.ts` or
`server/store.ts` patch was required. That was false and is deleted.

> **Superseded by Round 4, I-5, and by the merged home lane (O4).** `revision` is the number `1`,
> not a string. `shared/types.ts` and `tests/home-conversation.test.ts` are the record; a string,
> or any other number, is normalised to no binding at all.

**Returned patch, `shared/types.ts`,** into `Settings` (`:33-109`):

```ts
  /**
   * The reserved home conversation container. Missing on settings written
   * before this field existed; the server provisions it on the first landing
   * message and never at startup.
   */
  home?: { projectId: string; threadId: string; revision: string } | null;
```

**Returned patch, `server/store.ts`,** into `defaults()` (`:186-210`), which is
what `validateSettings` reads to decide whether a key is known
(`server/app.ts:216`):

```ts
  home: null,
```

Without the `defaults()` entry a client echoing the whole settings object is
rejected with "Unknown setting: home". The two patches land together.

**Reserved identity and collision rule.** The home Project is identified by its
folder, not its name: `<projectRoot>/.diomedes-home`. `Store.createProject`
already refuses a folder that is registered (`server/store.ts:728-729`), and
that refusal is the collision rule rather than a failure: a 409 on this folder
means the home already exists and must be adopted, not recreated.

**Lookup-or-adopt provisioning, retry-safe.** `Store.createProject` writes
project state, then the registry, then `openProjects`, as separate awaits
(`server/store.ts:755-769`), and creates no `Conversation`. A crash between them
leaves a registered project with no binding, and the naive retry then conflicts.
The provisioning routine is therefore idempotent in this exact order:

1. If `settings.home` is set and both records resolve, use it. Done.
2. Otherwise look for a registered project whose folder is
   `<projectRoot>/.diomedes-home`. If found, **adopt** it rather than creating.
3. Otherwise create it. A 409 on the folder means step 2 raced; re-run step 2.
4. If the adopted or created project has no home thread, create one.
5. Write `settings.home` last, so the binding is only ever written once both
   records exist.

Writing the binding last is what makes every earlier crash recoverable by
re-entry rather than by repair.

#### Visibility, and what must not be hidden

The home Project is excluded from the `/projects` listing, from `byRecency`
(`client/App.tsx:52`) and from project navigation and Files. `tests/backend.test.ts:100-105`
asserts a fresh `/projects` is empty and `tests/ui.spec.ts:105`, `:130`, `:1028`
assert exact Projects headings; provisioning on first landing message rather
than at startup keeps the first of these true on a fresh install without
filtering doing the work.

**Filtering is public-only.** Startup recovery enumerates every project through
`store.projects()` (`server/harness/host.ts:545-554`) to recover saved runs,
including `CLAUDE_SESSION_CAPABILITY` runs at `:554`. The home Project must stay
in that enumeration. A filter applied inside `Store.projects()` would silently
stop recovering home conversations. The filter belongs in the `/projects` route
response and the client, never in the store-level enumeration.

#### Launch

**Normal launch opens the home conversation.** This is the R-01 remainder and it
is settled: "the bot page should be the primary page to open up to" covers
returning users. The remembered project stays as navigation context, first on
the spine and one click away. It never overrides the launch destination.

**Normal launch is not surface recovery.** `migrateSettings(..., { atLaunch: false })`
is a mid-session recovery reload and leaves the showing surface where it is;
`tests/surface.test.ts:43-50` protects that and is unchanged. This decision
changes where a *launch* lands, not what a recovery reload does.

**Returned patches, lane CD-05b**, `client/App.tsx`. In `loadInitial`
(`:197-203`), keep the restored project as context and stop making it the
destination:

```ts
       const id = s.openProjects.at(-1);
       if (id && p.projects.some((x) => x.id === id)) {
-        setSelected(id);
-        const restored = s.lastPage[id];
-        setPage(restored && (pages as readonly Page[]).includes(restored) ? restored : 'home');
+        // Navigation context, not the launch destination. The primary
+        // conversation is where a launch lands, for a returning person too.
+        setRecentProject(id);
       }
```

and at the landing gate (`:848-862`), the home conversation renders when no
project is selected, which is now the launch state. `<Home>`'s project chooser
role is replaced by the conversation plus the spine; the exact composition is
CD-05's, within H2 and H3.

`client/App.tsx` is not a hot file, so CD-05 may apply these with a claim. They
are written out because they change a launch behaviour the pins depend on.

### Decision 4: how an admitted act enters work

Unchanged from round 2, which closed R-02.

1. Generation and phase recording happen **outside** the Store lock.
2. After the transcript projection returns and its lock is released, take a
   **fresh** `store.locked` around task and work admission and receipt checks.
3. Never nest a lock inside `recordResult`, and never await the provider result
   under a lock.

Round 1 claimed `admitWork` must run unlocked. That was wrong: `start` launches
`const job = this.prepare(run)` without awaiting it
(`server/native-work.ts:541`, comment at `:540`) and returns at `:552`; the lock
at `:613` is `prepare`'s. The existing `/work/start` route calls `admitWork`
through the default **locked** wrapper (`server/app.ts:1957-1959`, wrapper at
`:895-899`), and `Store.recordWorkAdmission` is documented "Called under
locked()" (`server/store.ts:588`). Unlocked admission would let two work
commands both pass the single-active check at `native-work.ts:329` before either
finished validation.

A busy project still yields 409 at `server/native-work.ts:329-330`, which
becomes a `blocked` outcome naming the running work. It is not queued: a
conversational queue would be a second scheduler. The existing follow-up queue
is the only one (`server/work-control.ts:345`).

A live conversation occupies no work slot: `ClaudeSessionRuns` writes no
`Session` record and `recordResult` touches `thread.turns` only. C23 keeps its
independent answer.

### Decision 5: what a non-Claude user gets

They get the existing `/ask` path and none of this. `prepare` refuses unless the
thread's engine is `claude-code` (`server/app.ts:2327-2331`) and unless the
service is on (`:2332-2333`), so such a user reaches
`client/console/Shell.tsx:1003-1017`, which posts `/ask` with no `commandId`:
no source identity, no durable run, no decision, no C21.

**UNCLAIMED.** Prerequisite: a second driver implementing `ClaudeSessionTurn`'s
`admit` and `open` (`server/harness/claude-session-run.ts:57-72`).
`ClaudeSessionRuns` is otherwise engine-agnostic apart from the `'claude-code'`
literals in `scope` (`:84`), the checkpoint validator (`:32-39`) and the
capability id. No part of the first slice describes the conversational agent as
available to a non-Claude user.

### Decision 6: a RunService step, not a Turn field

A step. `kind: 'transform'` (`shared/harness.ts:77`), `effect: 'pure'` (`:30`),
`cost: 0` (`:98`), `destination: 'local'`. Not a new pattern:
`server/harness/native-agent.ts:198-202` and `:301-304` already use exactly this,
and `'transform'` is in `KINDS` (`server/harness/run-service.ts:128`) with no
special handling.

A `Turn` field would be a `shared/types.ts` migration, and a `Turn` exists only
when there is a response (`recordResult` returns early at
`server/app.ts:2404`), so refused, blocked and clarify decisions would have
nowhere to live.

**Who records it.** Not `server/app.ts`. `RunService.step` is owner-exclusive:
`guard` throws `stale_lease` when `run.owner !== owner`
(`server/harness/run-service.ts:597`, `:307-313`), and `ClaudeSessionRuns`
claims under a private `randomUUID` owner (`claude-session-run.ts:107`, `:328`).
The hooks in decision 7 are the seam.

### Decision 7: ordered append-only phases

**Decision.** Five ordered phases, each its own immutable step on the
conversation run. No phase is ever amended, and no phase contains a value that
does not exist yet.

**Why a single envelope is impossible.** A step's intent is hashed on first
write and a later write with the same step id and a different intent throws
`intent_mismatch` (`server/harness/run-service.ts:381-387`); a succeeded step
only ever returns its cached output (`:606`). So a `receipts` field filled "once
they exist" cannot be written. Separately, a `workPayload` cannot be frozen
before `task.create`, because `work.start` requires `taskId`
(`server/work-admission.ts:16`), task admission accepts no caller-chosen id
(`server/task-admission.ts:12-20`), and `Store.createTask` computes
`T${Math.max(0, ...ids) + 1}` from current state under the lock
(`server/store.ts:1504-1505`). Predicting it is unsafe: another task admitted
first changes the answer. The authoritative id comes from the creation receipt
(`server/app.ts:1623-1631`).

#### The phases

Every step id is `stepKey(prefix, sourceMessageId)`
(`server/harness/claude-session-run.ts:81-82`), so ids satisfy
`STEP_ID_PATTERN` (`shared/contract-revision.ts:53`) through the existing helper
and no second id scheme exists. `sourceMessageId` is the issued identity of
decision 10, never the transport command id.

| Phase | Step id | Contents | Written when |
|---|---|---|---|
| 1 | `decision:<sm>` | Issued source identity, transport command id, mode, resolved target, the parsed decision or the raw unparsed block with `parsed: false` | Immediately after the model result commits |
| 2 | `task-input:<sm>` | The exact `task.create` payload and `taskCommandId`. No task id | Before calling task admission |
| 3 | `task-receipt:<sm>` | The authoritative `taskId` and the creation receipt reference, read from `server/app.ts:1623-1631` | After task admission returns |
| 4 | `work-input:<sm>` | The exact `work.start` payload, containing phase 3's `taskId`, and `workCommandId` | Before calling work admission |
| 5 | `work-receipt:<sm>` | The work receipt reference | After work admission returns |

Phases 2 to 5 exist only for an admitted `act` under `auto`. A `respond`
decision has phase 1 and stops, which is the C01 case.

#### Reconciliation

> **Superseded in part by Round 4, I-3.** The `reconcile?` and `decide?` hooks below cannot work: `StepContext` has no append or read operation. The driver writes the phases itself; read I-3 instead.

**Entry.** Reconciliation runs **before any new generation**, and also on the
cached-result path. Both are required: the succeeded-turn early return at
`claude-session-run.ts:348-358` returns directly and bypasses everything after
it, so a decision hook placed only on the normal path would never run on a
replay.

**Returned patch to `server/harness/claude-session-run.ts`** (not a hot file;
CD-02 applies it). Two parts.

Part one, two optional hooks on `ClaudeSessionTurn` beside the existing optional
`preview?` (`:68-72`), plus the trusted identity:

```ts
  /** The issued trusted source identity this turn was admitted for. */
  sourceMessageId: string;
  /** Runs before any generation. Returns true when phase 1 already exists. */
  reconcile?(context: StepContext): Promise<boolean>;
  /** Appends any missing phases. Never authorizes an effect. */
  decide?(context: StepContext, turnStepId: string): Promise<void>;
```

`sourceMessageId` goes on `ClaudeSessionTurn` and **not** on `TextRequest`,
which lives in `server/engines/contract.ts` and is shared with `/ask`. That
keeps one seam, threaded through `EngineService.claudeSession` as R-08 already
assigned.

Part two, the common tail. Today the early return is
`if (previous?.state === 'succeeded') return this.runs.step(...)` at `:348-358`,
and `let response` is declared at `:436`, after it. Hoist the declaration and
fall through:

```ts
-    const previous = run.steps.find((step) => step.intent.stepId === turnId);
-    if (previous?.state === 'succeeded')
-      return this.runs.step(
-        runId, this.owner, turnDefinition,
-        () => { throw new Error('A completed turn must replay.'); },
-        principal,
-      );
+    let response: ClaudeSessionTurnResult;
+    const previous = run.steps.find((step) => step.intent.stepId === turnId);
+    if (previous?.state === 'succeeded') {
+      response = await this.runs.step(
+        runId, this.owner, turnDefinition,
+        () => { throw new Error('A completed turn must replay.'); },
+        principal,
+      );
+      // A replay reaches the same tail: phases are appended, then the run parks.
+      await request.decide?.(/* step context for this run */, turnId);
+      await this.park(runId, input.projectId, input.requestId);
+      return response;
+    }
```

with `let response: ClaudeSessionTurnResult;` removed from `:436`, and
`await request.decide?.(...)` added immediately after the turn step commits on
the normal path, before `park` at `:554`.

**Placement, stated exactly.** `decide` runs after the model result is committed
by `runs.step` and before `park`. It appends phases inside the same run, so a
crash between the turn commit and phase 1 leaves a completed turn with no
decision, which reconciliation detects on the next entry and repairs by
replaying the recorded result. Phase 1 is never written before the result it
describes.

**Retry of the same source under a new transport id.** This is the R-03.2 case
and it is why `reconcile` exists. `prepare` sets `input.requestId` from the
transport command (`server/app.ts:2358`) and the turn cache keys on it
(`claude-session-run.ts:329`), so source S resent as command B2 misses B's
cache and would generate again. `reconcile` runs before the turn step, looks for
`decision:<sm>` by the issued identity, and when it exists **short-circuits
generation entirely**: the recorded proposal and answer are replayed and the
phases resume from the highest one present. The recorded proposal is what
replays. A new model answer is a new proposal, and treating it as a replay would
let an interruption change what was agreed.

**Live revalidation.** Authority is revalidated on every replay, never restored
from a phase. Phases hold inputs; they never hold grants. If authority has gone,
the outcome is `blocked`.

#### Partial outcomes, both visible

> **Superseded in part by Round 4, I-3.** Refusals at phases 2 and 4 are now recorded as their own phases, and a missing receipt phase is checked against the receipts before it is believed.

| Highest phase | What the person is told |
|---|---|
| 1 | Proposed, not admitted. The proposal is shown with the reason it did not proceed. |
| 3 | The task exists; the work was not admitted. Both the task and the reason are shown. |
| 5 | Admitted, with the receipt. |

Neither partial state is silently dropped and neither is shown as completed.
No scheduler and no mutable status authority: the state is read from the phases
and the receipts, which already exist.

### Decision 8: fixture parity for the decision schema

`shared/interaction.ts` matches the package fixture exactly after the documented
snake_case to camelCase renaming, and does not tighten. No trimming, code-point
lengths, and `targetRunId` free on `retrieve`, `plan`, `act` and
`build_capability` as the fixture leaves it.

Decision 10 constrains what the **server issues** and what **admission
accepts**. It does not change the parser. All 11 counterexamples pass unedited.

Any future divergence must version the fixture first and say so in the module
header.

### Decision 9: lineage generations, and one resolved run id

> **Superseded in part by Round 4, I-2.** A retry is resolved first, as a read through every lineage including retired ones. The generation rule counts retired entries.

**Decision.** The thread-to-lineage binding is **stored** on the `Conversation`
record. A new lineage is an explicitly admitted event with its own generation.

**The rejected alternative, in two lines.** Discover the lineage by listing runs
(`server/harness/routes.ts:46-61`). Rejected because the listing returns only
`{id, state, capabilityId, capabilityVersion, taskId, sessionId}` and no
`input.threadId`, so discovery costs one `host.get` per run per message; and
because matching on scope fails in exactly the case that matters, since scope
pins `model` and `accountRoute` (`claude-session-run.ts:83-90`) and a model
change is precisely when continuation is needed.

**Returned patch, `shared/types.ts`,** beside `Conversation` (`:413-431`), whose
existing comment at `:418` already establishes that later fields are optional
and filled on load:

```ts
export interface ConversationLineage {
  mode: Mode;
  /** 1 for the first lineage of this mode; incremented by an admitted replacement. */
  generation: number;
  runId: string;
  /** Absent means current. A retired lineage still resolves for replay. */
  retired?: 'scope-change' | 'terminated' | 'budget' | 'replaced';
}
```

```ts
  /** Native conversation lineages. Missing on state written before this field. */
  lineages?: ConversationLineage[];
```

**Resolution.** The current lineage for `(thread, mode)` is the one with the
highest `generation` and no `retired`. If none exists, admit generation 1. The
run id for a generation is deterministic, so re-running an admission finds the
same run:

```
runId = claudeSessionRunId(projectId, 'lineage.' + digest({ threadId, mode, generation }).slice(0, 40))
```

**Replacement is admitted, never automatic.** When the current lineage cannot
take the turn, the existing guard says so and the lineage is retired with that
reason, then a new generation is admitted:

| Guard | Reason recorded |
|---|---|
| `SESSION_MISMATCH` on a changed model or account route (`claude-session-run.ts:326-327`) | `scope-change` |
| Terminal refusal (`:320-324`) | `terminated` |
| Budget exhausted, 128 units and model calls (`:294`, `server/harness/run-service.ts:654-663`) | `budget` |

This is what closes R-10. A conversation continues past a model change, a
cancelled or failed run and budget exhaustion without weakening any guard,
because the guard is what triggers the replacement rather than being bypassed.
Retired lineages stay in the array, so original replay bindings survive and a
retry still resolves its own run. Discovery is unambiguous: one array, one
current entry per mode.

#### One resolved run id

**Returned patch, lane CD-02h, `server/app.ts`.** Today `prepare` returns the
input and the route derives the run id separately, while `server/app.ts:2366-2369`
derives a **third** one from the transport command and captures it in every
progress event (`:2370-2375`) and in the preview closure (`:2400`). With any
lineage-based derivation those disagree, which is R-11.

```ts
-      const runId =
-        req.params.runId && !req.path.endsWith('/fork')
-          ? String(req.params.runId)
-          : claudeSessionRunId(projectId, command.commandId);
+      // One resolved identity: preparation resolves the lineage, and progress,
+      // execution and projection all name the run that actually ran.
+      const runId = resolved.runId;
```

where `resolved` is the lineage resolution performed inside the same
`store.locked` block that `prepare` already holds (`:2323`). The route stops
deriving its own id and uses the resolved one for start, follow-up, resume and
fork alike. CD-02's integration tests check identity equality across all five.

### Decision 10: one trusted source identity

> **Superseded in part by Round 4, I-1.** The identity is computed from project, thread and `commandId`, so it exists before generation and survives any crash. The spelling policy here is unchanged.

**Decision.** The trusted source identity is **issued by the server**, not
echoed by the client and not derived from transport.

Round 2 said source and transport identities are equal on first send, which
created two identity policies across one bridge. Transport `commandId` is
trimmed and bounded at 200 UTF-16 units
(`server/engines/claude-session-routes.ts:11`), the decision fixture allows any
1 to 160 code points untrimmed, and the round-2 work-link field used a third
bound. A padded id, a whitespace-only id and an 81-emoji id each behaved
differently in the three places.

| Question | Answer |
|---|---|
| Who mints it | The server, in `prepare` (`server/app.ts:2321`), which already runs server-side and already holds the lock |
| When | Once per accepted source message, before generation |
| Where persisted | Phase 1, `decision:<sm>`, and returned to the client in the response |
| Exact form | `sm.` followed by 32 lowercase hex characters. 35 characters |
| Charset | ASCII only |

The form is chosen so the three length semantics cannot disagree: 35 ASCII
characters is 35 code points and 35 UTF-16 units, and it is unchanged by
trimming. That removes R-12's divergences rather than restating them.

**Binding the model's echo.** The decision's `sourceMessageId` must equal the
issued identity **exactly**. If it does not, the decision is invalid and the
turn degrades to `respond` / `none` under decision 1's rule 3. This is an
admission check. The parser still accepts any fixture-valid string, which is how
R-06 stays closed.

**One shared validator,** used by admission and by the work-link field so they
cannot drift:

```ts
/** The issued trusted source identity. Not a command id and never trimmed. */
export const ISSUED_SOURCE_ID = /^sm\.[0-9a-f]{32}$/;
```

`sourceMessageId` never enters a command-id field, so it needs no
`COMMAND_ID_PATTERN` conformance; the derived `conv.` ids in decision 2 are
separate values and do conform.

**No silent trim on the bridge.** Transport `commandId` keeps its existing
trimming, because it is a different identity in a different domain, and the
trusted identity never travels in that field.

## 1c. Case handling

### C01 to C12

| Case | Disposition | Operation | Handling | Claimable |
|---|---|---|---|---|
| C01 | `respond` | `none` | Answer on the home conversation. Phase 1 only. No task. | Yes |
| C02 | `respond` | `none` | Acknowledge. | Yes |
| C03 | `respond` | `none` | Discuss. No capability selected. | Yes |
| C04 | `respond` | `none` | Explain capability and limits. No keyword rule decides it. | Yes |
| C05 | `retrieve` | `read` | Compare the sources selected on the request (`server/app.ts:2340-2359`). | Partly. No integrated read-receipt proof. |
| C06 | `respond` or `retrieve` | `none` or `read` | Explicit Ask. Admission does nothing at all. | Partly, as C05 |
| C07 | `plan` | `prepare_artifact` | Explicit Plan. The plan text is the entire result; no work is admitted. | Partly, as C05 |
| C08 | `respond` | `none` | Discuss. No Automation configured. | Yes |
| C09 | `act` | `prepare_artifact` | Under `auto` only, escalating through phases 2 to 5 as a Build proposal. | **UNCLAIMED** for delivery |
| C10 | `act` | `prepare_artifact` | As C09. | **UNCLAIMED** for delivery |
| C11 | `build_capability` | `develop_capability` | The package expects a real bounded development task, not a refusal. | **UNCLAIMED** |
| C12 | `blocked` | `none` | Explain the access boundary. Capability and permission are separate questions. | Boundary only; unproved as model behaviour |

### C21 to C30

| Case | Enforceable boundary | Claimable |
|---|---|---|
| C21 | Derived ids for both families plus phase recovery keyed on the issued identity (decisions 2, 7, 10). | **UNCLAIMED** until those land |
| C22 | None. No source records supersession. | **UNCLAIMED.** CD-04 |
| C23 | `ClaudeSessionRuns` writes no `Session`, so `server/native-work.ts:329-330` is untouched. | Mechanism only |
| C24 | None. Hardcoded principal (`server/harness/bridge.ts:22-28`); authorization only checks existence (`server/app.ts:2318-2319`). | **UNCLAIMED.** Prerequisite: the accepted identity and context path binding participant, tenant, audience, project and current access before read and egress |
| C25 | Real for recorded writes: `ScopeGrants.assertCurrent` before preparation and each file (`server/store.ts:949`, `:1054`, `:1063-1081`), checking live grant and generation (`server/trust/scope-grants.ts:573-585`). | Recorded local file writes only. **UNCLAIMED** for supplier and connector effects and tenant membership |
| C26 | `tools: []` and `requestedPermissions: []` (`claude-session-run.ts:26-27`): no direct tool to call. | No-direct-tools fact only. Does not prove injected text cannot shape output, leak supplied material to an ineligible audience, or propose an `act`. End-to-end injection and egress **UNCLAIMED** |
| C27 | `ScopeGrants.record` (`server/trust/scope-grants.ts:501`) is the only mint and no model output reaches it. | Refusal only. Promotion candidates **UNCLAIMED**, CD-08 |
| C28 | No capability-activation path on this route. | Refusal only. **UNCLAIMED** |
| C29 | Rollback exists (`server/configuration.ts:486-561`, route `:202-209`, test `tests/configuration-service.test.ts:405`); grants and spend stay outside it. | Separation only. Conversational path **UNCLAIMED** |
| C30 | None. No audience field on a conversation. | **UNCLAIMED.** CD-03, and the reason H6 is binding |

C13 proves **target pinning only**: the target is pinned at admission
(`server/native-work.ts:298`, runs keyed by project; `applyMatchingScope`
refuses a mismatched task at `:831-833`). Workspace-scoped interface behaviour
and suppression of stale previews and notifications are unproved and are CD-05
work.

### What is unclaimed

Fully: C11, C21, C22, C24, C28, C30, and the non-Claude conversation.

Partly, with the claimable part named above: C05, C06, C07, C09, C10, C12, C13,
C23, C25, C26, C27, C29.

## 1d. Lane boundaries

Hot files, from `AGENTS.md`: `package.json` and lockfiles, `shared/types.ts`,
the shared harness, Agent and pack contracts, `server/app.ts`, `server/store.ts`,
`server/native-work.ts`, `client/api.ts`, `client/console/Shell.tsx`, `desktop/`.

### Returned hot-file patches

Every one is written out above. **CD-02h** is the server lane, **CD-05b** the
client lane. The integrator takes these.

| File | Patch | Lane |
|---|---|---|
| `shared/types.ts` | `Mode` gains `'auto'` (decision 1) | CD-02h |
| `shared/types.ts` | `Settings.home` (decision 3) | CD-02h |
| `shared/types.ts` | `ConversationLineage` and `Conversation.lineages` (decision 9) | CD-02h |
| `server/store.ts` | `defaults()` gains `home: null` (decision 3) | CD-02h |
| `server/app.ts` | Mount interaction routes; issue the source identity and resolve the lineage in `prepare`; supply `reconcile` and `decide`; one resolved run id at `:2366-2369`; fresh `store.locked` around admission | CD-02h |
| `client/api.ts` | Client functions for the conversation endpoints | CD-05b |
| `client/console/Shell.tsx` | Routing to the primary page | CD-05b |

`server/store.ts` and `server/native-work.ts` need nothing beyond the
`defaults()` line. The round-2 claim that no hot-file patch was needed at all is
deleted.

### CD-02, server

> **Superseded in part by Round 4, I-7.** The external claim on `server/engines/service.ts` is superseded by `2237787`. It is an ordinary integrator patch, not a carried risk.

New files: `server/interaction-admission.ts`,
`server/engines/interaction-routes.ts`, `tests/interaction-admission.test.ts`,
`tests/interaction-cases.test.ts`.

Existing non-hot files, with a claim: `server/work-admission.ts` (decision 2),
`server/modes.ts` (the `auto` entry), `server/engines/claude-session-routes.ts`
(the mode enum), `server/harness/claude-session-run.ts` (the hooks and common
tail, decision 7).

**The hook's transport.** The object passed to `nativeSessions.request` is built
inside `EngineService.claudeSession` (`server/engines/service.ts:1595-1659`),
which takes no decision dependency, so `sourceMessageId`, `reconcile` and
`decide` must be threaded through it. That file is listed in
`external-claims/devin-acp-adapter-20260913.json`, still marked discovered
rather than integrated. Age is not a release: this needs coordination and a
handoff. If refused, the hooks have no transport and decision recording cannot
land, which is a blocker to return rather than route around.

Named prerequisite CD-02 must not work around: C24's tenant boundary. Admission
stays inside H5's single-owner local scope, and no second permissions engine is
written.

### CD-05, client

New files: `client/console/Diomedes.tsx`, `tests/diomedes-page.test.ts`,
`tests/diomedes-page.spec.ts`.

Existing non-hot files, with a claim: `client/App.tsx` (the launch patches in
decision 3, `byRecency` at `:52`), `client/console/Home.tsx` (delete the
`?? byRecency[0]` fallback at `:142`).

Named prerequisite: the same C24 boundary. The home conversation is never
presented as workspace-wide or shared.

### Landing and launch pins

> **Superseded in part by Round 4, I-7.** `tests/ui.spec.ts:105` and `:130` change; only `:1028` is preserved.

| Pin | Intent |
|---|---|
| `tests/backend.test.ts:100-105` fresh `/projects` is empty | **Preserved.** Home is provisioned on the first landing message, not at startup. Under unreleased claim `claim_muah3ub1_5561db3d`: handoff, not edit. |
| `tests/ui.spec.ts:105`, `:130`, `:1028` exact Projects headings | **Preserved.** Home is filtered from the public listing. |
| `tests/ui.spec.ts:59-73` `openProject` branches on landing card or project nav | **Changed.** Launch now lands on the conversation, so the helper must open a project explicitly rather than inferring from what rendered. |
| `tests/ui.spec.ts:158`, `:205` "Try the sample project" | **Changed.** The landing composition changes. Relied on by `tests/change-review-ui.spec.ts:53`, which changes with it. |
| `tests/surface.test.ts:43-50` recovery reload leaves the surface where it is | **Preserved and load-bearing.** A recovery reload is not a launch; decision 3 changes only the launch destination. |
| `tests/field.spec.ts:102-134` rail entries and default visible `#scrThread` | **Preserved.** The Field surface is not the Console landing; a home entry must not displace the default thread. |
| `tests/first-task-handoff.spec.ts:229`, `:288-305`, `:343-379` route handover, composer placement, zero dispatch, cancelled project search | **Preserved.** First-run handoff keeps zero dispatch: provisioning on first landing message means arriving at the conversation sends nothing. |
| Specs that load `/` before selecting a project: `tests/a6-acceptance.spec.ts`, `tests/connections-ui.spec.ts`, `tests/design-studio-ui.spec.ts`, `tests/readability.spec.ts`, `tests/responsive.spec.ts` | **Review each.** Most only traverse the landing on the way to a project. |

CD-05 needs the shared heavy-test slot for the browser specs. CD-01 did not take
it and ran none of them.

## 1e. What I could not settle

### Owner decisions

Confirmed on 2026-09-21 and no longer open: the home Project and conditions H1
to H6; filtering and first-message provisioning; Automatic as the default;
deleting the last-opened fallback; Build unreachable from the conversational
path. The round-1 question of whether the landing is a conversation or a chooser
is deleted, and the round-2 launch question is settled by decision 3.

One proposed default remains, marked as such:

- **A plan follow-up on an ask conversation says quietly that a new lineage
  started.** Truthful over smooth. The alternative is silence, which reads
  better and hides that provider history did not carry across.

### A conflict in the records, for the integrator

`shared/contract-revision.ts:37-41` says `2026-09-13.1` is `proposed`.
`evidence/unified-20260913/C00.R-rollout-20260917.json:14-22` records a later
dated `accepted` verdict with `approved_contract_revision: '2026-09-13.1'`,
stating it is a new verdict rather than a rewrite of C00.R-3. The records
disagree. This contract reports it, does not edit the marker and does not
consume the revision as accepted.

### Source facts

- The conversational runtime exists and has no client caller.
- `instructions` is inside the run scope, so a conversation is mode-pinned, and
  fork cannot change it.
- A step's intent is frozen on first write; a changed intent throws
  `intent_mismatch`.
- `work.start` needs a `taskId` that only task creation can allocate.
- `NativeWorkService.start` does not await `prepare` and is called under the
  Store lock by the existing route.
- The Store lock is non-reentrant.
- A conversation occupies no work slot.
- `admitWork` forwards no mode, so native work defaults to Build.
- `prepare` sets `requestId` from the transport command, and the turn cache keys
  on it.
- The harness run listing returns no thread id.
- `validateSettings` rejects any key absent from `defaults()`.
- `Store.createProject` writes state, registry and `openProjects` separately and
  creates no Conversation.
- Startup recovery enumerates every project, including conversation runs.
- The principal is hardcoded to a single local identity.
- Per-file revocation rechecks exist for recorded writes; configuration rollback
  exists.
- `Home.tsx:142` falls back to the most recent project.
- The durable conversation is Claude-only.

### Proposed defaults

- Under `auto` the ordinary answer is the text before the decision block, and a
  malformed block degrades to `respond`.
- Escalation on a busy project reports `blocked` rather than queueing.
- Phase steps are `transform` / `pure` / `cost: 0` / `local`.
- The issued identity is `sm.` plus 32 hex.
- The home folder is `<projectRoot>/.diomedes-home`.
- Lineage generations start at 1 and increment on an admitted replacement.

### Unverified assumptions

- That two runs projecting into one thread reads well to a person. The mechanism
  is verified; the experience is not.
- That a portable handoff across a mode or lineage change carries enough to be
  useful. Package 02 §9 describes the shape; no source implements it.
- That a model asked for a trailing fenced block produces one reliably enough
  for `auto` to be the default. That is a CD-12 measurement, and rule 3 is the
  contract for when it does not.
- That the `EngineService` handoff will be granted. If not, the hooks have no
  transport.

## 2. What this work order did not do

No commit. No push. No hot file edited: every hot-file change is a written
patch returned to the integrator. No existing file edited outside the four
claimed deliverables. The reviewer's three files were read and not modified. The
heavy test slot was not taken, so no browser suite, no `vite build`, no
packaging and no live model call. Contract revision `2026-09-13.1` is not
consumed as accepted and its marker is not edited.

The four files written are
`docs/implementation/2026-09-20-core-agent-contract.md`,
`docs/implementation/2026-09-20-core-agent-source-map.md`,
`shared/interaction.ts` and `tests/interaction-contract.test.ts`.
