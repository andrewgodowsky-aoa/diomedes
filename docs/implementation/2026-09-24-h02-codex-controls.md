# H02 — Codex native steering, interruption, resume and fork

Linear: DIO-7. Branch `feature/h02-codex-native-controls`, from `origin/feature/h08-durable-controls`
(H08's control contract and `DurableControls.registerDriver` seam), with `origin/main` merged in
before the final push. Date 2026-09-24.

## What was missing

The 2026-09-23 audit found the Codex (ChatGPT) route with streaming, a warm app-server and
command-bound Stop (PR #36, reviewed and fixed in `2026-09-24-independent-reviews.md`). Missing for
DONE: Steer, Resume and Fork, and a live leg. Every Codex Work run was one turn on an **ephemeral**
app-server thread whose id was never kept, so nothing could be continued, steered or branched.

## What shipped

Nothing here is a second control path. Every control still arrives through H08's
`DurableControls.perform`, is judged by the run's route profile and leaves an H08 receipt. H02 adds
the Codex side of it, plugged in through the seam H08 left for it.

1. **Native thread identity** — `Session.nativeThread` (`shared/codex-thread.ts`, one optional field
   appended to `Session`). Written through `store.locked` after Codex opens the thread and **before
   any turn is sent** (the adapter awaits it), so a Stop, a failure or a restart still leaves the id
   with the run's evidence. It records the thread id, whether Codex was asked to keep it, how it came
   about (`started`, `resumed`, `restarted-fresh`, `forked`), what it continued or failed to
   continue, the capabilities Codex advertised, the protocol version and the model Codex reported
   when it opened the thread. A sentence goes into the run's log (plain for resumed / fresh / forked,
   technical for a new thread).
2. **Capability discovery, not assumption** — `probeCodexCapabilities` (`server/integrations.ts`)
   asks the app-server process itself, once per process: `thread/resume`, `thread/fork` and
   `turn/steer` are each called with empty parameters, which no handler can act on. An app-server
   that has the method refuses the parameters; one that does not refuses the method (JSON-RPC
   `-32601`, or the app-server's own `Invalid request: unknown variant …` deserialization answer).
   Any other failure is not an answer and fails the request. Only a Work run asking for continuity
   probes; the plain Ask/Plan path, team runs and the guarded `codex-report` dispatch are byte-for-byte
   unchanged (the existing Codex tests, including the PR #36 regression tests, pass unmodified).
3. **Thread kept only when there is a reason** — a Work run's thread is started with
   `ephemeral: false` only when the installed Codex answers `thread/resume` or `thread/fork`;
   otherwise it stays ephemeral as before. (Proposed default 1 below.)
4. **Resume** — the Codex driver's `resume` names the stopped run's thread for the new run H08 admits
   (`ContinueContext.start()`, ordinary Work admission with the recorded inputs). The adapter then
   calls `thread/resume` under the same read-only policy as a new thread and checks the response the
   same way (read-only sandbox, no network, `approvalPolicy: never`, `openai` provider, and the same
   thread id back). Where it cannot, it starts a new thread and says so, in the run's log, on
   `nativeThread.detail` and in the receipt:
   `Couldn't resume Codex thread <id>: <reason>. Started a new Codex thread; earlier messages were not carried.`
   Reasons: the earlier run could not keep its thread (its Codex offered no resume); this Codex build
   does not offer thread resume; Codex no longer has that thread (Codex answered and refused). A lost
   connection or timeout during `thread/resume` is **not** treated as "gone": it fails the run, never
   a silent fresh start. Works after Stop (a new process finds the kept thread) and after a Diomedes
   restart (the restart marks the run stopped; its recorded thread id is what Resume continues).
5. **Steer** — while a Codex Work run's turn runs, the adapter keeps its turn id by run
   (`liveTurns`). `steerCodex` sends `turn/steer` with `expectedTurnId`, so a message can never land
   in a later turn. It is offered only where the Codex that served the run answered `turn/steer` and
   the run is working; otherwise Steer is refused with the route's note and the Console offers Queue,
   labelled as a queue ("ChatGPT can't steer a running turn, so a message waits for the turn to
   end."). Never pretended: no live-steer claim without `turn/steer`.
6. **Fork** — from a settled run whose thread was kept, the driver opens a short-lived app-server
   process (same sandbox proof, sign-in check and capability probe as a request), calls `thread/fork`
   under the read-only policy, checks the response, and closes the process. No turn is sent. H08 then
   makes the new task and thread exactly as its host fork does (`forkTask`, factored out of the host
   path) and records `result.nativeThreadId` on the receipt. The fork task's **first** Codex run
   continues that branch (`origin: forked`, `from` the origin thread); later Starts are new threads.
   Where Codex does not offer `thread/fork`, the thread was not kept, or Codex refuses the fork, the
   control is refused with the reason and nothing is made. The origin's task, runs, Needs, threads
   and History are read, never written (asserted deep-equal before/after in unit and browser tests).
7. **Wired through `registerDriver`** — `server/app.ts` registers `codexControls.driver()` under the
   `codex` contract and answers `contractFor('codex', session)` with `codexWorkContract(session)`:
   the static `ROUTE_CONTRACTS.codex` declaration, amended only by what the Codex that served that
   run advertised. A run with no recorded thread (every run before this change, and any run on the
   other Codex paths) answers by the static contract word for word, so H08's per-route table and its
   tests are unchanged. The Console reads the same profile, so it offers exactly what the installed
   Codex supports.
8. **Truthful attribution (decision 8)** — `ControlPerformer` for an engine gains an optional
   `model` (the model the engine reported for that action). Steer, a native Resume and a Fork are
   performed by `{ kind: engine, engine: codex, version: 0.153.4, model: <reported> }`. A Resume
   that could not continue the thread is performed by Diomedes (support `host`), because Diomedes
   composed a fresh start: `StartAnswer` may now correct the profile's performer and support, so a
   receipt never says Codex resumed what it did not. The receipt line shows "by ChatGPT ·
   <model>". The asker stays the person.
9. **Console** (small appends) — `ThreadView` refetches a run's profile when its thread record lands;
   `StopMenu`'s Resume confirmation says "Sends the same request to ChatGPT in a new thread; ChatGPT
   cannot continue this one." where Resume is a host fresh start; `RunInspector` shows a "Codex
   thread" row (id · kept for resume / resumed / a fork / new, resume not possible / not kept);
   `ControlReceiptLine` shows the engine's reported model. Machine strings sit inside the receipt's
   and inspector's existing wrapping policy (decision 5); no `.col` rule touched (decision 6).

### Per-capability support (Codex route, Work runs)

| Control | Installed Codex answers the method | Installed Codex does not | Run has no recorded thread |
|---|---|---|---|
| Steer | `native`: `turn/steer` into the running turn, bound to its turn id; offered while the run is working | refused, route note; Queue offered and labelled | refused (static note); Queue offered |
| Queue | host (H08 follow-up queue), unchanged | same | same |
| Stop | host task / queued; `generation` = abort + process end (PR #36), unchanged | same | same |
| Resume | `native`: `thread/resume` of the kept thread; Codex refused → new thread, said so, by Diomedes | `host`: new Codex thread with the same request, said so, by Diomedes | not offered (static contract) |
| Retry | host, unchanged (a new attempt is a new thread) | same | same |
| Fork | `native`: `thread/fork` into a new task; first run continues the branch | refused: "This Codex build does not offer thread fork, so a Codex run cannot be forked." | not offered (static contract) |

"Answers" means the app-server process answered the probe for that method when the run's thread was
opened (recorded on `nativeThread.capabilities`), and is asked again by the process that performs
the resume or fork.

## Proof

- `tests/h02-codex-controls.test.ts` (9, real HTTP through `createApp`, the real `createIntegrations`
  adapter, and a real child process — `tests/fixtures/codex-app-server.mjs` — speaking newline-
  delimited JSON-RPC over stdio, keeping non-ephemeral threads on disk and refusing absent methods
  the way the app-server does): thread recorded before `turn/start` with probed capabilities and
  `ephemeral: false`; the probe calls asked with `{}`; the profile offers exactly the advertised
  set; Steer applied with the engine+model performer, `turn/steer` carrying `expectedTurnId` on the
  same process, and the running turn's own answer containing the message; Steer refused with the
  Queue pointer where Codex lacks it and Queue receipt queued; Resume after Stop continues the same
  thread from a **new process** (the answer is the thread's second user turn), receipt native,
  replay returns the same receipt, stopped run deep-equal; Resume after an app restart continues the
  recorded thread; Resume on a build with no continuity starts fresh with the exact sentence,
  receipt by Diomedes, support host, and never calls `thread/resume`; a forgotten thread and a build
  that dropped resume each start fresh with their reason; Fork success (branch saved with
  `forkedFrom`, no turn sent, new task at *Show me first* with no run, origin deep-equal, first run
  continues the branch with the history carried, a later Start is new); Fork refusal by capability
  and by Codex, nothing made, origin deep-equal.
- `tests/h02-codex-controls.spec.ts` (2, Playwright, built Console, own host with the fixture
  app-server): full-capability build — Steer "now, into this turn" applied "by ChatGPT ·
  fixture-codex-model", Stop, Resume confirmed and applied by ChatGPT naming the thread, inspector
  lists Steer not offered (turn ended) / Resume and Fork by the route and the "· resumed" thread row,
  Fork applied by ChatGPT, origin runs unchanged, receipts' performers `engine, diomedes, engine,
  engine`; no-capability build — only the two queue timings, the queue note, Resume and Retry only
  (no Fork), the fresh-start confirmation copy, Resume "by Nectovia" with "Couldn't resume Codex
  thread …" and "Started a new Codex thread".
- Unchanged and passing: `tests/integrations.test.ts` (76, including R36-1/R36-2 regressions),
  `tests/backend.test.ts` (R36-3), `tests/read-scope-codex.test.ts`, `tests/native-work.test.ts`,
  `tests/h08-durable-controls.test.ts`, `tests/h08-control-profile.test.ts`,
  `tests/h08-durable-controls.spec.ts`, `tests/h01-conformance.test.ts`.

## Not proven, and not claimed — the live-proof gap

**There is no live Codex leg.** No Codex binary, Windows sandbox or ChatGPT account exists in this
environment, and the native adapter refuses to start off Windows. Everything above is proven against
a fixture app-server whose method names and shapes follow the published Codex app-server v2
protocol (`thread/resume`, `thread/fork`, `turn/steer` with `expectedTurnId`,
`ThreadStart/Resume/ForkResponse` carrying `thread`, `model`, `modelProvider`, `sandbox`,
`approvalPolicy`) and the existing pinned 0.153.4 shapes this adapter already reads. Specifically
unverified against the pinned 0.153.4 build:

- whether 0.153.4 has `thread/resume`, `thread/fork` and `turn/steer` at all (the probe decides at
  run time; if it lacks them, the Console offers Queue, a labelled fresh-start Resume and no Fork);
- that an absent method is answered `-32601` or with the "unknown variant" deserialization message
  the probe reads, and a present one with a parameter error;
- that `thread/resume` and `thread/fork` accept and echo the same read-only policy fields as
  `thread/start`, and that a forked thread keeps the disabled MCP configuration;
- that a non-ephemeral thread killed mid-turn by Stop (process-tree kill) leaves a rollout
  `thread/resume` can load, and that `thread/fork` sends nothing to the model;
- that the isolation proof pinned for 0.153.4 still holds for a kept (non-ephemeral) thread — the
  proof was recorded for `ephemeral: true`, and `CODEX_PROTOCOL_VERSION`'s own comment says an
  upgrade needs a new isolation proof. A live acceptance run should re-run it with a kept thread.

DIO-7 is therefore **not closable as DONE** until a live acceptance on Windows with the pinned
build: steer into a running turn, stop then resume, restart then resume, fork then run the fork.

## Proposed defaults (conservative; Andrew's to confirm)

1. **Codex Work threads are kept (`ephemeral: false`) when, and only when, the installed Codex
   answers `thread/resume` or `thread/fork`.** Keeping a thread writes its transcript, including the
   selected documents' text, into the person's own Codex history (`CODEX_HOME`), as H04's kept
   OpenCode session does. That is inherent to resuming it; without it nothing can be resumed after a
   Stop. The alternative (never keep, so Resume always starts fresh) is available by withholding the
   capability.
2. **A native Fork makes the Codex branch and the new task, and starts no run.** The fork task's first
   Start (with its own consent and at *Show me first*) continues the branch. This keeps H08 default 1
   (Fork acts on the press because it sends nothing) and default 4 (a fork starts no run).
3. **Resume where Codex cannot continue is offered as a labelled fresh start** (support `host`,
   performed by Diomedes, confirmation says "in a new thread"), because the brief asks for Resume to
   start fresh and say so rather than be withheld.
4. **Steer is offered only while the run is `working`** and its Codex answered `turn/steer`; a run
   waiting for approval has no running turn to reach.
5. **A Resume waits up to 45 s, under the store lock, to learn whether Codex continued the thread**
   before writing its receipt, so the receipt can say which happened. On timeout the receipt says
   Codex had not yet answered and names Diomedes; the run's own record says what Codex did.

## Known gaps / follow-ups

- Live acceptance (above). Also: `CODEX_PROTOCOL_VERSION` pins 0.153.4, so the probe only ever
  meets that build today; the probe is what lets a future pin change without code assuming support.
- Queue on the Codex route is H08's follow-up queue: a queued message starts a new Work run on a new
  Codex thread. Delivering it as the next turn *of the same Codex thread* (a true next-turn queue)
  is not done here.
- Steer text is not stored on the receipt (H08's receipt carries no message text); the running
  turn's answer and the run log show its effect.
- H08's restart-between-start-and-receipt replay (`already`) writes the profile's performer; for a
  Codex resume it cannot know whether the thread was continued. The run's `nativeThread` is the
  authority in that edge.
- Conversation (Ask/Plan) turns on ChatGPT are unchanged: still one ephemeral thread per request.

## Proposed canonical-doc patch

Not applied here: the integrator reconciles the canonical documents.

**`docs/DIOMEDES_LIVE_ROADMAP.md`** — in §5 after the H08 durable-controls paragraph, add:

> H02 Codex native controls (DIO-7, 2026-09-24, `docs/implementation/2026-09-24-h02-codex-controls.md`):
> a ChatGPT (Codex) Work run records its app-server thread before its turn is sent and asks the
> installed app-server whether it answers thread/resume, thread/fork and turn/steer. Where it does,
> the Console offers Steer into the running turn, Resume that continues the same thread after a Stop
> or a restart, and Fork that branches a settled thread into a new task, each through the H08
> controls with a receipt performed by Codex and its reported model. Where it does not, Steer falls
> back to the labelled Queue, Resume starts a new Codex thread and says so, and Fork is refused with
> the reason. Proven on a fixture app-server process only; live acceptance on Windows with the pinned
> build (including the isolation proof for a kept thread) remains before H02 is DONE.

**`docs/DIOMEDES_PROJECT_MEMORY.md`** — under the Steer/Queue/Stop/Resume/Retry/Fork entry, add:

> *Codex thread* — the app-server thread a ChatGPT Work run used, recorded with the run before its
> turn is sent. It is kept for a later Resume or Fork only when the installed Codex offers them. A
> resume Codex cannot honour starts a new thread and the run says "Couldn't resume … Started a new
> Codex thread; earlier messages were not carried."

**`QUESTIONS.md`** — add: *Codex kept threads*: may Diomedes keep a Codex Work run's thread
(`ephemeral: false`, stored in the person's own Codex history) whenever the installed Codex offers
resume or fork? (Default above: yes, only then.)

**`docs/harness/RUNTIME_VERIFICATION.md`** — add: "H02 Codex Work-run thread continuity (record,
capability probe, turn/steer, thread/resume with truthful fresh start, thread/fork) proven against
a fixture app-server process and in the browser; no live Codex steer, resume or fork is claimed,
and the 0.153.4 isolation proof has not been re-run for a kept thread."

## PILLAR / ROADMAP / BUILD

- **PILLAR IMPACT:** truthful capability (a control appears only where the Codex that served the run
  answered for it; a fallback is labelled — Queue as a queue, a fresh start as a fresh start), truthful
  attribution (engine plus its reported model for what Codex did, Diomedes for what it composed;
  never a model's reasoning), durable evidence (the thread id is written before the turn; origin runs
  are never written), scoped authority (resume and fork threads are held to and checked against the
  same read-only policy as a new thread; a fork starts at *Show me first* and runs nothing). Risk
  named: keeping Codex threads stores transcripts in the person's own Codex history (default 1).
  No new runtime, permission model or surface.
- **ROADMAP IMPACT:** H02 moves from "streaming, warm process, command-bound Stop" to "plus Steer,
  Resume and Fork on Work runs, capability-discovered, through the H08 controls; fixture and browser
  proof". Not DONE: the live leg.
- **BUILD STATUS:** see the final report for this branch's gate counts.
