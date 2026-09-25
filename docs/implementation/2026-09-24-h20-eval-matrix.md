# H20: a headless evaluation of the production Core, and the all-route acceptance matrix

Linear DIO-25. Lane `h20-eval-matrix`, branch `feature/h20-evaluation-matrix`, from
`origin/integration/overnight-batch-5` (`bc7833f`: main with batch 4, H03 and H05). Dates 2026-09-24
to 2026-09-25 (UTC; the committed run is dated by the clock it ran under).

- **Canonical documents read:** Core Pillars 2026-09-22.1, Live Roadmap 2026-09-24.1, Project
  Memory 2026-09-24.1. They name H20 only as an owner of "comparative evidence" (roadmap §4, memory
  §H-lanes) and do not define its acceptance, so the sprint work order is the scope used here.
- **Not to be confused with** `server/harness/evaluation*.ts` and `docs/product/evaluation/`, which
  are the Jev evaluation (a model ranking candidates before a turn). This lane evaluates Diomedes
  itself.

## What existed before

- Route contracts: `server/harness/route-contract.ts` (15 routes) and the four model-API contracts
  beside their adapters (`modelApiContract` in `server/harness/model-api-adapter.ts`), merged only
  in `server/durable-controls.ts`. `contractChecks` and `streamChecks`
  (`server/harness/conformance.ts`) check a descriptor's shape and a run's event stream; they never
  check that a route does what it declares.
- H08's `workControlProfile` reads a contract into the controls a Work run offers.
- Every harness feature that landed on 2026-09-24 (H02–H05, H08, H12, H13, H15, H17, H18, H21) has
  its own vitest suite through `createApp`, one feature at a time. Nothing ran them as one scenario
  set against one Core, and nothing tied a scenario to a contract cell.
- H21's completion journey (`tests/completion-journey.spec.ts`) drives one sample journey through the
  built Console in a browser.

## What shipped

### 1. The derivation (`server/evaluation/route-matrix.ts`, `server/evaluation/route-inventory.ts`)

`advertisedContracts()` lists every advertised contract: the registry plus the four model-API
contracts, 19 rows. It refuses to run if a Work route a person can pick (`ROUTES`) has no contract.
The H08 control fixture is left out; it is test-only and no one can pick it.

Twelve columns. Seven read a lifecycle command straight from the contract. Five read the descriptor
field that decides them:

| Column | Read from | Rule |
|---|---|---|
| turn | `commands.start` | as declared |
| stream | `streaming.transientPreview` | `text-delta` is `native`; `none` is unsupported |
| tool-proposal | `mode`, `routeId` | `harness-agent` → native (registered tool steps); a kept conversation (`*-session`) → unsupported; other Work routes → host (the recorded writer) |
| approval | `mode`, `routeId`, `engine.protocolVersion` | `harness-agent` → native; `*-session` → native for `acp/1` (the ACP permission/plan ask), else unsupported; other Work routes → host (a Need) |
| steer | `commands.steer` | as declared |
| queue | `commands.follow-up` | `COMMAND_FAMILY` binds follow-up to `follow-up.queue` |
| stop | `commands.interrupt` | the column asks about stopping a running turn; the task-level Stop is the host's on every route |
| resume, retry, fork | same commands | as declared |
| verification | `routeId` | H17 is `host` on every Work route; unsupported on a kept conversation |
| context-accounting | `mode` | H18 is `host` where Diomedes assembles context (`harness-agent`); unsupported elsewhere |

`deriveCell` gives each cell one of four states from the declaration and the scenarios' checks.
A check names one route, one capability, and whether the route `performs` it or `refuses` it:

- **proven**: declared, and at least one `performs` check passed, with no failing check.
- **declared, not proven**: declared, and no check ran here. The reason comes from the contract's
  authentication: a signed-in binary, a live credential, or "no scenario in this run exercises it".
- **unsupported**: declared unsupported, with no contradicting check. An observed refusal is named.
- **mismatch**: a check contradicts the declaration. That is a failed `performs` on a declared
  capability, a `refuses` on a declared one, a `performs` that passed on an unsupported one, or a
  `refuses` that failed on an unsupported one.

`deriveMatrix` refuses an invalid descriptor or a duplicate route. Checks that name a route no
contract advertises are listed as orphans. Scenarios that threw or failed an assertion are listed.
`renderMatrixMarkdown` writes the summary.

### 2. The headless runner (`scripts/eval-matrix/`)

- **`core.ts`**: one real Core. `createApp` listens on a free loopback port and is reached only
  over HTTP, with the Console's `X-Diomedes-Client` header. There is no browser. The SSE reader
  consumes `GET /api/events` the way the Console does. `close()` then `open()` on the same folder
  is a restart. The runner never writes Core's records.
- **Transport seams only.** Providers are replaced through the options Core already exposes for
  this:
  - `nativeGenerator` for the Codex Work call;
  - `modelApiTransport` for the network below the AI SDK;
  - `engineService` for which installations exist, and so which process a route launches.

  Nothing inside Core is mocked.
- **`scenarios.ts`**: twelve scenarios. Each uses its own Core and folder:

  | Scenario | Route(s) | Fixture (all pre-existing unless noted) |
  |---|---|---|
  | `aws-ask-answer-stream` | aws-bedrock | Responses stream, `tests/fixtures/model-api-streams.ts` |
  | `sample-proposal-approve-decline` | sample | the staged worker |
  | `sample-controls-refused` | sample | the staged worker |
  | `codex-stop-mid-turn` | codex | scripted `nativeGenerator` |
  | `codex-retry-after-failure` | codex | scripted `nativeGenerator` |
  | `h13-loop-restart-verified` | native-fixture | `loopFixtureAdapter` / `delegateFixtureAdapter` |
  | `h12-uncertain-effect-blocks-retry` | codex | `tests/approval-crash-child.ts`, a real Core process exiting at a durable boundary |
  | `h15-drift-escalation` | sample | the staged worker |
  | `h17-verification-evidence` | sample | the staged worker |
  | `cursor-acp-session` | cursor-session, cursor | `tests/fixtures/acp-agent.mjs` |
  | `opencode-kept-session` | opencode-session | `tests/fixtures/opencode-session-server.mjs` |
  | `claude-code-native-session` | claude-code-session | `tests/fixtures/claude-stream-json.mjs`: the H03 route tests' inline script, lifted into a shared file (new file, same script) |

  The required journeys:
  - ask/answer: `aws-ask-answer-stream`;
  - approve and decline: `sample-proposal-approve-decline`, plus the Cursor plan ask;
  - Stop mid-turn: Codex, AWS, Cursor, OpenCode and Claude;
  - resume after restart: `h13-loop-restart-verified`, AWS, Cursor, OpenCode and Claude;
  - retry after failure: `codex-retry-after-failure`;
  - H13 to a verified finish: `h13-loop-restart-verified`;
  - H12 uncertain effect blocking Retry: `h12-uncertain-effect-blocks-retry`;
  - H15 drift escalation: `h15-drift-escalation`;
  - H17 with evidence: `h17-verification-evidence`, plus the loop, Codex and AWS verifications.
- **`runner.ts`**: runs the scenarios, catches a throw as a failed scenario, and derives the matrix
  from the live contracts.
- **`npm run eval:matrix`** (`scripts/eval-matrix.ts`) writes
  `docs/verification/<date>-route-matrix.md` and `.json`.
  - `--out`, `--only` and `--keep` are accepted.
  - It **exits 1 when any cell is a mismatch or any scenario failed**, so a mismatch is never just a
    quiet line in a file.
  - A full run takes about 50 s here.

### 3. Tests

- **`tests/h20-route-matrix.test.ts`** (11 tests):
  - A contract that declares steer (the H08 control fixture's native steer) with no passing
    scenario reads *declared, not proven*, even beside passing checks for another capability or
    route.
  - A failing check reads *mismatch*.
  - A declared capability that was refused reads *mismatch*.
  - An unsupported one reads *unsupported*; performing it, or not refusing it, reads *mismatch*.
  - Not-proven reasons come from the contract.
  - Changing a contract changes its cells.
  - An invalid descriptor or a duplicate route is refused.
  - Counts add up.
- **`tests/h20-headless-runner.test.ts`** (3 tests):
  - The runner itself runs in vitest on the scripted routes: sample, Codex, and the loop with a real
    restart. Codex stop, retry and verification read proven, as do the loop's resume and
    verification, and a sample refusal reads unsupported.
  - A **deliberately broken Codex fixture**, one that answers with prose instead of a proposal, turns
    `codex` turn and tool-proposal into **mismatch** and fails the scenario.

These were written alongside the derivation, not red-first. The derivation is new code with no
earlier behaviour to show failing. The broken-fixture test is the "red" the work order asks for:
it shows the matrix going red on a real failure.

## The committed run: `docs/verification/2026-09-25-route-matrix.{md,json}`

linux-x64, Node 22.22.2, generated at commit `f5259bbed967`. 19 routes × 12 capabilities = 228
cells:

| State | Cells |
|---|---|
| proven here | 43 |
| declared, not proven here | 96 |
| unsupported (declared) | 74 |
| mismatch | 3 |

Ten of the twelve scenarios pass. `cursor-acp-session` and `opencode-kept-session` fail on exactly
the mismatches below; every other check in them passes.

**What the unproven cells need** (listed per cell in the summary):
- **Real signed-in binaries:**
  - the single-turn text routes' Work proposals (claude-code, opencode, oh-my-pi, cursor, devin);
  - all of `devin-session` and `devin`;
  - `codex-report`;
  - Claude session streaming (the fixture emits no stream events).
- **A live credential or a transport fixture that exercises the capability:** Azure OpenAI,
  OpenRouter and Google Vertex, plus retry on AWS.
- **No HTTP path exists:** the `harness-runtime` route; and the `native-fixture` route's queue,
  retry and fork (H08 has no Work driver wired for them, so it refuses them before any check could
  run).

**No cell needs Windows** by its contract. The runner's vitest file runs in the Windows and macOS CI
jobs on the scripted routes.

## Mismatches found (bugs)

Each one reproduces on every run: three consecutive runs each, with identical outcomes.

1. **`cursor-session` · stop: an early Stop is acknowledged and dropped.**
   - **What happens:** a Stop sent as soon as a kept Cursor conversation reads `busy` (about 40 ms
     after the turn was sent) returns `200 {acknowledged: true, turnCompleted: false}`. The turn
     then runs to the request time limit and ends `409 TIMEOUT` ("Cursor exceeded the request time
     limit. No retry was sent.") after 10.3 s, the fixture's `requestTimeoutMs`.
   - **The same Stop at 300 ms works:** it ends the turn in about 15 ms with
     `interrupted: true`.
   - **Likely cause:** the driver marks the turn active (`server/harness/claude-session-run.ts`
     `control`, the `this.active.has(runId)` check) before the ACP conversation has registered its
     controller. `AcpConversation.interrupt()` (`server/engines/acp-session.ts`, "Stops the running
     turn, if any") then returns at once because `this.active` is unset. The acknowledgement
     therefore describes a Stop that nothing received.
   - **Contract:** `interrupt: native — session/cancel, a bounded wait for the agent to end the
     prompt, then the owned process tree is ended`.
2. **`opencode-session` · stop: an early Stop is refused with an untrue reason.**
   - **What happens:** while a kept OpenCode session reads `busy: true, connected: false` (its
     `opencode serve` still starting, about the first 0.3–0.45 s), Stop answers
     `409 SESSION_CLOSED` "The native process is already closed." The turn runs to its time limit
     (`409 TIMEOUT` after 5.4 s).
   - **Once `connected: true`, Stop works:** `interrupted: true` in about 13 ms.
   - **Cause:** `control` refuses when `this.connections.get(runId)` is unset
     (`claude-session-run.ts`, "The native process is already closed."). A turn that is still
     opening its connection has none yet.
   - **Contract:** `interrupt: native — POST /session/:id/abort, then idle is confirmed`.
3. **`cursor-session` · resume: a restart during a live turn makes a loadable session unresumable.**
   - **What happens:** Core is stopped the ordinary way (`app.locals.close()`, the same path as
     quitting) while a Cursor turn runs. After it restarts:
     - the conversation reads `start-again`: "Couldn't resume. The last Cursor turn did not finish,
       so its outcome is unknown. The next message starts a new session.";
     - an explicit `/resume` answers `409 RECONCILE_REQUIRED` "The native turn outcome is
       uncertain.".
   - **The fixture agent advertises `loadSession`.** A restart while idle resumes correctly.
   - **Contract:** `reconcile: host — A turn a restart interrupted is recorded as not completed and
     never resent; a loadable session stays resumable`. The driver-level test
     (`tests/acp-session-runtime.test.ts`, "a restart mid-turn is reconciled … and resumed with
     session/load") covers a hard crash with a second driver recovering. The graceful shutdown path
     through the real Core is what differs: `continuityOf` treats the unfinished model step as
     unknown.

The scenario detail and the per-cell reason in the committed summary carry the exact observation
of each one. Fixing them belongs to the H04 and H05 lanes; this lane reports them and changes no
engine code.

## Observations that are not mismatches

- **Codex generation Stop.** A generation Stop on a Codex Work run ends the request, but the run
  stays `working` until a task Stop ends it. This is deliberate: `server/native-work.ts`
  `interrupt` says so. The scenario asserts it, then ends the run with a task Stop. A person who
  presses only "stop the request" is left with a run that reads as working; that is a UX question,
  not a contract breach.
- **Cursor fork refusal wording.** A fork of a kept Cursor conversation is refused, as its contract
  declares, but with the wording "The native session contract does not match this route and
  build." rather than the contract's note ("ACP v1 has no fork of a saved session.").
- **Claude fork of an Auto lineage.** A Claude thread's `auto` lineage (the Console's `/messages`)
  cannot be forked through `/claude-sessions/:runId/fork`, which takes only ask and plan and
  requires the same instructions (`409 SESSION_MISMATCH`). A lineage the session route started
  forks correctly: `--resume` plus `--fork-session`, proven here.
- **Codex's per-run contract (H02).** Codex amends its contract per run from what the serving
  app-server advertised (`codexWorkContract`). The matrix reads the static `codex` declaration,
  where steer, resume and fork are unsupported, and proves the static behaviour (steer refused).
  The per-run amendment is not represented.
- **Two queues.** The `queue` column is the route's own follow-up. Diomedes' follow-up queue is the
  host's on every route, including one that declares no follow-up. The sample scenario asserts
  that separately, so it never counts as a route proving follow-up.
- **The H12 path.** The H12 scenario produces its uncertain effect the way production does: a real
  Core process exits after the first file of an approved write, a person edits the next file, and
  recovery records the write `conflicted` and the run `failed`. This is the recorded-writer effect
  that `DurableControls.uncertainEffects` checks, alongside harness `EffectRecord`s. A harness
  `EffectRecord` cannot reach Retry over HTTP today, because the `native-fixture` Work route has
  no retry driver wired, so H08 refuses Retry as unsupported first.

## Known gaps

- Not driven:
  - `devin-session` and `devin`. They share the ACP layer; `DevinAdapter`'s browser sign-in would
    need its own fixture wiring.
  - The single-turn text routes' Work proposals, except Cursor's direct Ask turn and stream.
  - Azure OpenAI, OpenRouter and Google Vertex. Vertex has a mocked-network harness in
    `tests/google-vertex-conversation.test.ts` that a later scenario could reuse.
- `eval:matrix` is not in CI. The runner's vitest file is, through the ordinary vitest job.
- The matrix reads declarations. It cannot see a capability that works but is declared
  unsupported unless a scenario tries it (the `refuses` checks do this for sample, Codex steer,
  Cursor steer and Cursor fork).
- The five non-command columns are derived from `mode`, `routeId` and protocol rather than from a
  field of their own. See the proposed default below.

## Decisions taken conservatively (Andrew's to confirm)

1. **Proposed default: derive the five non-command columns from existing descriptor fields.** The
   alternative, adding fields to `AdapterRouteContract`, changes a shared harness contract, and
   that belongs to its owner.
2. **The committed run records its three mismatches as they are.** It does not fix them, and it
   does not hide them by leaving the scenarios out. `npm run eval:matrix` exits 1 because of them.
3. **Queue maps to follow-up, and stop maps to interrupt.** This follows the contract's own
   `COMMAND_FAMILY` binding and the plain meaning of "stop a running turn".

## Tests and gates (this lane's run)

See the PR description for the exact gate counts on the final commit. The two new test files add
14 vitest tests.

## Proposed canonical-doc patch

**Live Roadmap** (`docs/DIOMEDES_LIVE_ROADMAP.md`), in the harness section beside H01, add:

> **H20 (DIO-25): headless Core evaluation and the all-route acceptance matrix.** `npm run
> eval:matrix` starts the production Core with no browser, drives twelve scenarios through the
> Console's HTTP API with providers replaced only at their transport seams, and writes
> `docs/verification/<date>-route-matrix.{md,json}`. Every cell is derived from the route contracts
> and the run's checks: proven here, declared but not proven here, unsupported, or mismatch. The
> first committed run (2026-09-25, linux) proves 43 of 228 cells, leaves 96 declared but unproven
> (real binaries, live credentials, or no HTTP path), reads 74 unsupported, and found 3 mismatches
> (an early Stop dropped on Cursor and refused on OpenCode, and a Cursor session made unresumable
> by a restart mid-turn), which are open against H05/H04. Not yet in CI.

Also record the open follow-ups: the three mismatches; Devin, Azure, OpenRouter and Vertex
scenarios; text-route Work proposals; a CI job for `eval:matrix`.

**Project Memory** (`docs/DIOMEDES_PROJECT_MEMORY.md`), in the H-lanes paragraph, after
"H09/H18/H19/H20 own profiles/context/views/comparative evidence", add:

> H20's route matrix is the evidence of what each route does. A cell is *proven* only when a
> scenario run against the real Core passed a check for it; a declaration alone is *declared, not
> proven*, and a declaration a check contradicts is a *mismatch* (a bug), never a footnote.

**Core Pillars:** no change.

**QUESTIONS.md:** none answered. The proposed default above could become a question if Andrew
wants the five non-command capabilities declared in the contract itself.

## PILLAR IMPACT

Truthful capability claims are advanced. A route's declared capabilities are now checked against
what the production Core actually does, cell by cell, and the check found three places where a
declaration was not true: two Stops that did not stop, and a resume that did not resume. No
conflicts: nothing here grants, widens or records authority, and attribution is unchanged.

## ROADMAP IMPACT

H20 (DIO-25): the headless runner, the derived all-route matrix, the scenario set, `npm run
eval:matrix` and its tests are implemented on this branch, and one run is committed. H20 is ready
for review. Its open follow-ups (above) do not block it; the three mismatches it found are bugs in
H04 and H05 routes, not in H20.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

There is a draft PR against `main`, which is not merged. There is no version bump, no change to the
native-runtime hashes and no packaging. Nothing was released.
