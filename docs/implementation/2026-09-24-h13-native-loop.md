# H13: the Diomedes-owned plan, act, observe and finish loop

Lane `h13-native-loop`, branch `feature/h13-native-loop`, Linear DIO-18. Base
`origin/integration/overnight-batch-3` (`ccd93e3`), which carries H07, H08, H11, H17 and H18.
Date 2026-09-24.

- **Canonical documents read:** Core Pillars 2026-09-22.1, Live Roadmap 2026-09-23.1, Project
  Memory 2026-09-23.1. None of them defines H13's acceptance; the work order in the sprint brief
  and Linear DIO-18 are the scope used here.
- **Numbering note:** `docs/harness/HARNESS_INTEGRATION_MAP.md` still titles H13 "Queues and
  budgets". The unified package, the roadmap (§4, "H13/H14 own orchestration/delegation") and
  Linear DIO-18 use H13 for this loop. The patch below proposes aligning the map.

**What this is.** A real loop that Diomedes owns, as a harness capability (`diomedes-loop`):
it plans, acts through the registered tools under Trust, observes what came back, may hand one
bounded sub-task to another route, and finishes with a claim that only H17's projection of the
task's declared checks can turn into *Verified*. Every phase is an ordinary step in the run's
durable record, so it replays after an approval or a restart without calling anything twice.

**What this is not.** It is not H16, not a second runtime, permission model or surface, and not a
self-grading worker. It does not run project commands, does not delegate to Codex, has no
Console start control, and nothing here is live-proven against a provider (see §9).

## 1. The loop, step by step

`server/harness/native-loop.ts` (`NativeLoop`), with the records typed and projected in
`shared/native-loop.ts`:

| Step id | Kind | What it records | Attributed to (decision 8) |
|---|---|---|---|
| `loop:context` | transform | The goal, the instructions' sha and bytes, the tools offered, and H18's section account of the first call | Diomedes application |
| `context:plan`, `model:plan` | transform, model | One planning call with **no tools offered** | the model the runtime reported |
| `plan` | transform | At most 8 items of at most 240 characters (`parsePlan`), `truncated` when cut | Diomedes native supervisor |
| `context:<n>`, `model:<n>` | transform, model | The next action | the model the runtime reported |
| `tool:<n>` | tool | One registry tool, dispatched by `RunService.step` with the registry's effect, permission, approval, destination and cost | application (the tool) |
| `handoff:<n>` | transform | The handoff envelope (`shared/handoff.ts`), or why none was opened | Diomedes native supervisor |
| `delegate:<n>` | tool | Starting or resuming the child run and waiting for it | Diomedes native supervisor |
| `observe:<n>` | transform | What came back: tool, ok, sha-256 of the full output, bytes, a 600-character excerpt, or the refusal | Diomedes application |
| `finish:<n>` | transform | The model's summary as a **claim**, and H18's account reconciled | Diomedes native supervisor |
| `stop:turns` / `stop:budget` | transform | Which limit, turns used of the limit, the run's usage and budget | Diomedes native supervisor |

- **Act through Trust, never around it.** The model supplies only a tool's content
  (`LoopToolBinding.schema`); the host binds scope (project, run, the bytes a write expects).
  The bound input is then validated against the registry tool's strict schema, and authority comes
  from the registry entry. On replay, the recorded intent is the authority: host-bound fields are
  never re-derived, so a replay after the write cannot change the intent hash.
- **Tools** (`server/harness/capabilities/native-loop.ts`): `list_project_files`,
  `read_project_file` (read only, through the path guard; on a cloud route only files the project's
  sharing grant lists for that route, refused as data otherwise), and the existing `propose_write`
  (its Need, exact approval, remembered-approval path and recorded writer are unchanged). Each read
  tool checks at dispatch that it is the running step of a loop run in that project.
- **A refusal is an observation.** A tool the model was not offered, or an input that fails its
  schema, is recorded as `observe:<n>` with `action: 'refused'` and sent back to the model; nothing
  runs. The turn still counts.
- **Bounded.** `maxTurns` (default 8, at most 16) and the run budget `RunService` enforces
  (`loopBudget`: `modelCalls = turns + 1`, `toolCalls = turns`, `units = 2·turns + 4`). Reaching
  either records a stop step and **cancels** the run with `turn limit reached (8 of 8 turns)` or
  `budget reached (model calls 2 of 2)`. A job spend cap refusal from a model-API route
  (`*_job_cap_reached`, before sending) stops it the same way. The run is never completed, and the
  outcome reads *Stopped: turn limit reached* / *Stopped: budget reached* with "The goal was not
  finished, so nothing was checked."

## 2. The second route (and the first)

The loop takes any `ModelAdapter`. On the host:

| Route | How it is driven | Proof in this lane |
|---|---|---|
| `native-fixture` | A fixed local script (`loopFixtureAdapter`, `delegateFixtureAdapter`), attributed as an application action and never named as a model | host tests, Playwright |
| `google-vertex` (**the second route**) | `EngineService.loopAdapter`: the route's own admission read fresh, the credential opened inside the call, the job ledger bound; the real `@ai-sdk/google-vertex` request | adapter-level conformance and wire tests; **end to end through `createApp`** with the network below the SDK replaced |
| `aws-bedrock` | the same path | adapter-level conformance and wire tests |
| `azure-openai`, `openrouter` | the same `loopAdapter` path (one shared `modelApiRoute`) | **not driven by any test here**; reachable, not claimed |

Google Vertex AI was chosen because the owner's tier map (2026-09-23) names it the Focused tier
(`shared/tier-map.ts`), its adapter already rides the shared model-API adapter, and the host
already has a mocked-network test harness for it (`tests/google-vertex-conversation.test.ts`).
Both routes pass the conformance suite (`contractChecks`) with the same contract shape, and every
loop run's event stream passes `streamChecks`.

External engines (Codex, Claude Code, OpenCode, ACP routes) keep their own loop and are refused
at the loop's admission (`loop_route_unsupported`).

## 3. Context (H18) and instructions (H11)

- **H11:** at admission, `assembleInstructions` resolves the project's instruction files through
  the rule path for the loop's route and its selected files (`workPaths`), bounded by
  `instructionSectionBudget`, restricted to shared documents on a cloud route. The section is pinned
  in the run input; the delivery record is written on the Session, so the existing
  "Project instructions loaded" inspector shows what the loop used.
- **H18:** `loop:context` records `accountContext` for the first call (instructions, tool
  definitions, the message), and the finish or stop record carries `reconcileContext` over the
  run's own model steps (reported usage summed, cache reads kept apart, the first call reconciled,
  tool results counted). The adapter is built with a stable prefix (the loop's instructions, then
  the H11 section), so a provider's automatic prefix cache can reuse it.

## 4. Finish only through verification (H17)

- The finish step records a claim, and the run completes with
  `{ loop: { finish, claim, verification: 'decided-by-declared-checks' } }`. No success flag is
  stored anywhere.
- When a loop run completes, the procedure's `settled` hook runs the task's **declared** checks
  (`Task.acceptance`, declared by the person) through `VerificationService.verify(…,
  { requestedBy: 'diomedes-loop' })`. The model never declares its own checks.
- `VerificationRecord.requestedBy` widens additively to `'you' | 'diomedes-loop'`; the History
  entry is `actor: 'diomedes'` with "Nectovia ran your checks on <task> when its loop finished: n
  of m passed", and the Console evidence says "your checks, run when its loop finished" instead of
  "at your request".
- The outcome (`loopOutcome`) is the projection: *Verified*, *Not verified*, *Failed
  verification* or *Verification uncertain*, with the projection's own sentence and evidence.
- **Task state.** A completed loop run leaves the task `waiting · changes-ready` (Review), not
  done. Only when the projection is *Verified* does the host move it to done (`moveTask(…,
  'diomedes')`) and log "Verified: every declared check passed on the bytes this run wrote, so the
  task is done." Idempotent across restarts: recovery re-runs the hook for settled runs, and a run
  that already has a verification on record is not verified again.

## 5. Delegation (one level)

- Offered only when the person names a delegate route at admission; the model decides whether to
  hand off and what the sub-task says, never where it goes or who pays.
- `handoff:<n>` opens the envelope with `openHandoff` (versioned parties, `plan.markdown`
  artifact, depth 0, sibling count, the payer inherited from the parent's connection) and checks
  `acceptHandoff` against the child's own authority. At most 2 handoffs per run; a third is
  refused as an observation. A delegate is never offered `delegate` (depth 1).
- The child is its own harness run (`diomedes-loop-delegate`, id `<parent>-d<n>`, no Session),
  read-only (`list_project_files`, `read_project_file` bound to the child's project and route),
  with a fixed budget (4 model calls, 4 tool calls, 8 units) and `NativeAgent` as its loop. Its
  route is admitted fresh before it starts; a refusal comes back as an observation.
- **Cancellation propagates.** A person's Stop (the ordinary Stop control, which goes through
  H08's `WorkControl.stop` → `bridge.stop`) cancels the parent, aborts the in-flight delegate step,
  which cancels the child with "the loop that handed it this sub-task was stopped". The
  procedure's `stopped` hook also cancels every live child from the durable record, for the case no
  process is holding the handler. An external model call in flight at that moment is parked as
  `reconcile_required`, never relabelled cancelled.
- **Restart.** At startup a live child's dead lease is invalidated first (`recoverChild`); the
  parent's replay then re-enters `delegate:<n>` (attempt 2), which resumes the child or, when the
  child's in-flight call was external and is parked, observes that outcome and continues. The
  unknown call is never resent.

## 6. Console

`client/console/LoopInspector.tsx` (+ `loop-inspector.css`), inside the existing run inspector
(`client/workbench/RunInspector.tsx`) when the run is a loop, in the Settings > Engines language:
the outcome word with H17's state dot and its one sentence; *Supervised by* the agent name; the
runtime-reported models with their route and call counts ("None: a fixed local script" on the
fixture route); turns and budget used; H18's estimate and reported tokens; the plan; each action
with its state and what came back (excerpt, bytes, sha); each handoff with its envelope id, child
run, budget, state, answer and models; and the finish claim, labelled as a claim. Machine strings
wrap where they are written (decision 5); no `.col` rule is touched (decision 6). A loop run's
Session carries a supervisor origin, so its actor line reads, for example, "Nectovia
gemini-3.8-flash-001 via Google Vertex AI" (the agent name, then the model the runtime reported),
and "Nectovia native supervisor" on the fixture route.

## 7. Hot-file edits (all appends or one-line allowlist additions)

- `server/app.ts`: imports; an `AppOptions.loopModelRoutes` test seam; the model-route attachment
  before `harness.init()` with a startup gate (`hold`/`open`) so a resumed loop waits for every
  route and the verifier; the loop engine in `serviceFor`; the verifier attached and the routes
  mounted after H17's.
- `server/harness/bridge.ts`: optional `HarnessProcedure` hooks (`budgetFor`, `routeFor`,
  `sessionOrigin`, `present`, `stopped`, `settled`), each used only by a procedure that defines it.
- `server/harness/host.ts`: register the tools and the procedure, a loop egress branch, child
  recovery before the bridge's, `loop` on the host object.
- `server/store.ts`, `server/approval-admission.ts`, `server/durable-controls.ts`: the loop engine
  beside the fixture and Codex harness engines in their allowlists.
- `server/engines/service.ts`: `loopAdapter`. `server/harness/native-agent.ts`: three helpers
  exported. `shared/verification.ts`, `server/verification/service.ts`,
  `client/console/Verification.tsx`: `requestedBy` widening and its wording.
  `client/workbench/RunInspector.tsx`: render the loop section. `playwright.config.ts`: the spec.

## 8. Tests

| File | Count | Proves |
|---|---|---|
| `tests/native-loop.test.ts` | 9 | Every phase recorded in order with its attribution; stream conformance; refusals observed and nothing run; plan bounds; turn limit and budget stop the run truthfully (cancelled, which limit, no completion); approval suspends and replay calls nothing twice; restart mid-model-call on a new service resumes and repeats only the interrupted call; delegation with envelopes, fixed child budget, a third handoff refused; Stop on the parent cancels the child it waits for |
| `tests/native-loop-routes.test.ts` | 8 | For AWS and Vertex: conformance of the route contract; plan call offers no tools; the provider's call id answers each tool; host-bound write; approval then a fresh adapter continues from the private transcript; every model step attributed to the reported model, the loop's steps to Diomedes; H18 reconciliation; spend holds settled; a route switched off sends nothing; restart mid-loop never resends a settled call |
| `tests/native-loop-vertex-host.test.ts` | 1 | Vertex end to end through `createApp`: setup over HTTP, the loop's admission, `EngineService.loopAdapter`, an unshared file refused before it leaves (its bytes never in any request), an approved write, the person's check run at the finish, *Verified*, task done, attribution and spend |
| `tests/native-loop-host.test.ts` | 8 | Fixture route with a delegate: plan, read, delegate, approved write, finish *Not verified* with no checks and the task not done; declared checks → *Verified*, task done, History says who asked; failing check → *Failed verification*; command replay and conflict; refusals (external engine, route off, no consent, unshared); Stop through the ordinary Stop control stops the delegate (its external call parked); restart while waiting for approval; an abrupt process exit mid-delegate call (child process) recovers the parent and never resends the child's call |
| `tests/native-loop-ui.spec.ts` | 2 | The inspector: outcome *Verified* with its sentence, supervisor and models, plan, four turns with observations, the handoff with its budget and answer, the finish claim, no horizontal overflow at 900 px; a loop stopped at its turn limit says which limit and shows no finish |

These were written alongside the implementation, not test-first.

## 9. Live-proof gaps (stated plainly)

- **No live provider call.** Every AWS and Vertex exchange above is a mocked transport under the
  real SDK. Nothing was sent to AWS or Google, and nothing was spent. Azure and OpenRouter are not
  exercised at all.
- No packaged, installer or device proof; no hosted proof.
- Delegation targets a model-API route or the fixture, not Codex: a Codex Work run needs its own
  Session and approval flow inside the parent's, which the single-active-run guard does not allow
  today. Recorded as follow-up.
- No Console control starts a loop; it starts through `POST /api/projects/:id/loop/start`, as the
  native capabilities do today. Where a start lives (the Diomedes page's escalation, CD-04, or a
  thread action) is a product decision.
- A failed or uncertain verification does not trigger a bounded correction pass.
- `command` acceptance checks still never run (H17's boundary), so a task declaring one can never
  read *Verified*.
- The wall-clock budget is recorded, not enforced (unchanged harness behaviour).
- Quitting while a loop's provider call is in flight waits for that call (bounded by the
  provider's own timeout); it is not aborted, so the record stays resumable.
- A Stop while the loop waits on a delegate logs "The harness run stopped: stale attempt" once:
  the delegate step's late commit is refused, which is the intended outcome.

## 10. Proposed defaults (Andrew's to confirm)

1. **A finish that is not Verified leaves the task in Review** (`waiting · changes-ready`), also
   when no checks are declared. The person can still move it to done on the Board.
2. **The person chooses the delegate route at start**; the model only decides whether and what to
   hand off. A delegate is read-only, one level deep, at most 2 per run, 4 model and 4 tool calls.
3. **The loop's own steps are attributed to Diomedes as native supervisor** (decision 8), model
   steps to the runtime-reported model, and a fixture route names no model.

## PILLAR IMPACT

- Advances the Core agent pillar (Diomedes plans, delegates bounded work, verifies, and keeps a
  durable record) with observable proof in the tests above. Trust is unchanged in meaning: every
  effect still goes through the registry, `RunService`, the Need and the recorded writer; reads to
  a cloud route go through the project's sharing grant; activating nothing grants anything.
- Attribution (decision 8) is made more precise, not wider: *supervisor* origin appears only on
  steps the loop decides and on a loop run's Session.
- History is evidence (decision 10): verification and handoffs are appended; nothing is pruned.

## ROADMAP IMPACT

- H13 (DIO-18): **first slice implemented** — Diomedes-owned plan/act/observe/finish loop with
  bounded turns and budget, verified finish through H17, one-level delegation with cancellation and
  restart recovery, two model-API routes proven with mocked providers, and the run inspector.
  Full acceptance still needs the independent review (H13.R) and the live gaps in §9.
- H17: automatic verification at completion now exists **for loop runs only**.

## BUILD STATUS

Branch `feature/h13-native-loop`, pushed by this lane; not merged, not released, not deployed.
Gate results are in the lane's final report.

## Proposed canonical-doc patch

Not applied: this lane does not edit the canonical documents.

**`docs/DIOMEDES_LIVE_ROADMAP.md`, §4 (H-lanes), after the sentence ending "delegation is not
automatically more efficient.":**

> H13 slice 1 (2026-09-24, DIO-18) is implemented: a Diomedes-owned plan → act → observe →
> finish loop (`diomedes-loop`) whose every phase is a durable run step, bounded by turns and run
> budget with a truthful stopped outcome, acting only through registered tools under Trust, with
> H11 instructions and H18 accounting, one-level bounded delegation under a handoff envelope with
> Stop propagation and restart recovery, and a finish that reads done only when H17 verifies the
> person's declared checks. Proven on the fixture route and, with mocked providers only, on AWS
> Bedrock and Google Vertex AI (Vertex end to end through the host). Not live-proven; Codex
> delegation, a Console start control and correction after failed verification remain open
> (`docs/implementation/2026-09-24-h13-native-loop.md`).

**`docs/DIOMEDES_PROJECT_MEMORY.md`, beside the H17 verification definition:**

> **Diomedes work loop (H13).** Work Diomedes itself supervises: a bounded plan, one action per
> turn through the registered tools and Trust, a recorded observation of each result, optional
> one-level delegation, and a finish. The finish is the model's claim; the task is done only when
> the person's declared checks verify it. Diomedes is named as the supervising actor of the loop's
> own steps; every model step names the model the runtime reported.

**`docs/harness/HARNESS_INTEGRATION_MAP.md`:** retitle "H13 Queues and budgets" to "H13 Native
loop, queues and budgets", and add under it: "Plan/act/observe/finish loop over `RunService`
(`server/harness/native-loop.ts`), host procedure `diomedes-loop`
(`server/harness/capabilities/native-loop.ts`), start and read routes
(`server/native-loop-routes.ts`). Budget enforcement remains units/model/tool calls; wall-clock
recorded only."

**`docs/harness/RUNTIME_VERIFICATION.md`:** add "H13 loop: fixture and mocked-provider
evidence only (AWS Responses, Vertex Gemini wire formats under the real SDKs); no live route."
