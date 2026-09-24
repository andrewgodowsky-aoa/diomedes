# H08 — Steer, Queue, Stop, Resume, Retry and Fork as distinct durable controls

Linear: DIO-13. Branch `feature/h08-durable-controls`, from `origin/integration/overnight-batch-1`
(since merged to `main` as PR #86; `origin/main` merged back before the final push). Date 2026-09-24.

## What was missing

The 2026-09-23 audit found stop scopes, a durable follow-up queue and command-bound Stop in place
(`server/work-control.ts`, `shared/work-control.ts`, `StopMenu.tsx`, `FollowUpQueue.tsx`). Missing
for DONE: Steer, Resume, Retry and Fork as distinct commands with command identity and receipts,
availability read from each route's declared capabilities, and one place in the Console.

## What shipped

### 1. One control contract (additive revision `2026-09-24.1`)

`shared/work-control.ts` gains a revision section. `WORK_CONTROL_CONTRACT_VERSION` stays 1; every
record written under the revision names `contractRevision: "2026-09-24.1"`, which
`receiptRevision()` in `shared/contract-revision.ts` already reads (tested). Nothing in the frozen
`CONTRACT_REVISION` is changed.

| Control | Meaning | Command family | Applies to a run that is |
|---|---|---|---|
| `steer` | Text into the turn that is running now | `steer` | live |
| `queue` | Text held and sent after this turn or the task (the existing follow-up queue) | `follow-up.queue` | any (task-level) |
| `stop` | The existing three scopes: `generation`, `task`, `queued` | `stop` | any |
| `resume` | Continue a stopped run from its durable record | `resume` | stopped |
| `retry` | New attempt of a failed or stopped run, same recorded inputs, linked to it | `retry` | failed or stopped |
| `fork` | New task and thread that refer to a chosen settled run | `fork` | settled |

Each family is the one `shared/adapter-contract.ts` already binds its adapter command to
(`COMMAND_FAMILY`; tested).

**Request** — `POST /api/projects/:id/controls`, body validated by `controlRequestSchema`
(discriminated on `control`): `protocolVersion: 1`, `commandId` (≤ 120 chars so the Work command it
derives stays a valid id), `taskId`, plus `sessionId` (steer, resume, retry, fork; optional for
stop), `text` (steer, queue), `waitsFor`/`route`/`model`/`agentId`/`sources` (queue), `scope` (stop).

**Identity** — the digest is taken over `controlPayload(request)`: fixed keys, explicit defaults, the
id left out. Replaying the same `commandId` with the same payload returns the stored receipt
unchanged and performs nothing (also after a restart); the same id with another payload is `409
control_command_conflict`. Control ids share the one project command namespace with task, Work,
approval and scope commands (`findCommand` in `server/command-admission.ts`), so a Work start can
never reuse a control id and vice versa. A control that starts or queues work derives the Work
command identity `<commandId>:work`; a restart between the start and the receipt replays the same
start through admission instead of making a second one.

**Receipt** — `ControlReceipt`, appended to `ProjectState.controlReceipts`, never rewritten or
pruned (decision 10). Every well-formed control aimed at an existing task leaves one, a refusal
included. It records:

- who asked — `requestedBy: { actor: "you", via: "local-client" }` — and `requestedAt`;
- what it targeted — `target: { taskId, sessionId, threadId }`;
- the route answer it was judged by — `route: { workRoute, contractRouteId, support }`;
- what happened — `outcome`: `applied` | `queued` | `refused` | `uncertain`, a one-sentence
  `detail`, and `refusal: { code, reason }` for a refusal (codes: `unsupported`, `not-applicable`,
  `uncertain-effects`, `permission-widened`, `inputs-changed`, `inputs-unrecorded`,
  `model-changed`, `consent-required`, `admission-refused`, `route-refused`, `nothing-to-stop`);
- who performed it — `performedBy`: `{ kind: "diomedes" }` for a host composition,
  `{ kind: "engine", engine, version }` (the contract's engine identity) for a native one, null
  for a refusal. Never a model, never "Diomedes reasoning" (decision 8);
- `result` (`sessionId`, `followUpId`, the embedded `StopReceipt`, fork `taskId`/`threadId`),
  `lineage` (`resume` | `retry` with `attempt` | `fork`, origin task and run),
  `uncertainEffects`, and `revalidated` (the checks re-run, in plain words).

`GET /api/projects/:id/controls[?taskId=]` lists receipts and, with a task, each run's route
profile; `GET /api/projects/:id/controls/:commandId` reads one receipt.

### 2. Capability-driven availability

`workControlProfile(contract, workRoute, wired)` in `shared/session-controls.ts` — beside H04's
`sessionControls`, reading the same `AdapterRouteContract` — is the one answer both the server
(enforcement) and the Console (what it offers) read. Rules:

- **Steer** only where the contract says `native` *and* a Work-level driver is wired. A `host`
  steer (H04's OpenCode kept session: held until the turn ends) is a queue, so Steer is not offered
  and the note says what the route does; the Console offers Queue, labelled as a queue.
- **Queue** is Diomedes' follow-up queue: `host` on every route.
- **Stop** `task` and `queued` everywhere; `generation` only where the contract answers `interrupt`.
- **Resume** needs a wired driver (a Work run keeps no continuable state of its own).
- **Retry / Fork**: composed by Diomedes where the contract says `host`; need a wired driver where
  it says `native`.
- A contract that declares a command nobody wired is not offered it: "This route declares resume,
  but this build has not wired it to Work runs, so it is not offered."

The server refuses anything the profile does not offer with the contract's own note as the reason.

**Plug-in seam for H03 / H05 and later routes** — `DurableControls.registerDriver(contractRouteId,
driver)` (`server/durable-controls.ts`). A `WorkControlDriver` may implement `steer`, `resume`,
`retry`, `fork` and `uncertainEffects`; each present method is what makes a `native` declaration
offerable. `resume`/`retry` receive a `ContinueContext` whose `start()` admits the run through the
Work start route's own path with the recorded inputs and the derived identity, so a native
continuation still carries a Work receipt and passes every check a person's Start does. A lane
whose Work runs should answer by another contract (e.g. Claude Code Work runs by
`claude-code-session`) changes `contractFor` in `server/app.ts`. No second capability pattern.

### Per-route support (generated from the code; pinned by `tests/h08-control-profile.test.ts`)

| Work route | contract | Steer | Queue | Stop | Resume | Retry | Fork | Stop scopes |
|---|---|---|---|---|---|---|---|---|
| sample | sample | — | host | host | — | — | — | task, queued |
| codex | codex | — | host | host | — | host | — | generation, task, queued |
| claude-code | claude-code | — | host | host | — | host | — | generation, task, queued |
| opencode | opencode | — | host | host | — | host | — | generation, task, queued |
| oh-my-pi | oh-my-pi | — | host | host | — | host | — | generation, task, queued |
| cursor | cursor | — | host | host | — | host | — | generation, task, queued |
| devin | devin | — | host | host | — | host | — | generation, task, queued |
| aws-bedrock, azure-openai, openrouter, google-vertex | model-API | — | host | host | — | host | — | generation, task, queued |
| harness runs (native-fixture, codex-report) | same | — | host | host | — (declared native, not wired) | — (same) | — (same) | task, queued |
| control-fixture (test mode only) | control-fixture | native | host | host | native | host | host | task, queued |

So today, for a real route: Queue and Stop everywhere; Retry on every non-sample route; Steer,
Resume and Fork nowhere until a route declares and wires them (H03/H05 are adding the mechanisms).

### 3. Semantics that never lie

- **Retry never re-performs an effect that may already have happened.** `uncertainEffects(session)`
  collects an approved write whose outcome was never recorded (`execution: pending` on a settled
  run), one that met outside edits (`conflicted` — "some approved changes may have applied"), any
  unconfirmed effect a Stop recorded, and whatever the route's driver reports. Any of them refuses
  Retry (and Resume) with code `uncertain-effects`, lists them on the receipt, and asks the person
  to check History and start new work. There is no override. Provider work that may still be
  charged is not treated as such an effect: it changes nothing in the world a retry would change
  again, and Retry's confirmation says it sends the request again.
- **Resume revalidates** before anything is sent: route still available; sending consent recorded
  for this task and route; the thread's permission is the same or narrower than the stopped run's
  (wider → `permission-widened`: a run is never resumed with more authority than it had); the
  recorded model is still what the thread resolves to; every recorded source still exists and is the
  version the run saved (changed → `inputs-changed`, pointing to Retry). Then ordinary admission
  checks again (service on, cloud sharing, work in progress, task present). `revalidated` lists
  what passed.
- **Retry** runs the same checks except permission (it is a new attempt under the thread's current
  setting, like a Start) and changed sources (it reads the current version and says which changed).
- **Inputs are recorded** at admission: `Session.inputs` (`instruction` as sent, `sources`,
  `agentId`, `mode`) in `server/native-work.ts` and `server/work.ts`. A run admitted before this
  has none and is refused Resume/Retry with `inputs-unrecorded` rather than guessed at.
- **Fork** (host) creates a task (`Fork of <name>`, the recorded instruction as its description, its
  first recorded source as the default document) and a thread attached to it that copies the
  origin thread's engine, model/Agent choice and mode, starts at *Show me first* (authority is never
  carried into a new lineage), and starts no run. The lineage lives on the receipt; the origin's
  task, runs, turns, Needs and History are read, never written (asserted deep-equal before/after in
  unit and browser tests).
- **A stopped run's evidence stays** — no control edits or removes a session, log, Need or History
  entry; Resume and Retry add new runs; the original stays `stopped` / `failed`.

### 4. Console

- `client/console/StopMenu.tsx` — `RunControls`: in each run's own record, the Stop cluster while it
  runs (Stop options now lists only the scopes the route can honour), and Resume, Retry and Fork once
  it has settled (`role="toolbar"`, "Run controls"). Resume and Retry apply to the task's latest
  run and ask once ("Continues this run on Sample from where it stopped." / "Sends the same request
  to ChatGPT again, as a new attempt.") with the confirm button focused; Fork acts on the press and
  is offered on any settled run. The Stop options menu is keyboard operable (arrows, Escape returns
  focus). A folded latest run keeps its controls in view.
- `client/console/FollowUpQueue.tsx` — Steer lives with Queue because both carry a message: a
  third choice "now, into this turn" appears only when the live run's route offers native Steer;
  otherwise the box says "<Route> can’t steer a running turn, so a message waits for the turn to
  end." Queue and Steer both go through the control route, so each press leaves a receipt.
- `ControlReceiptLine` — every receipt is woven into the thread's timeline by time: control, outcome
  (done / queued / not done / not confirmed), who performed it, the route's sentence, any uncertain
  effects, and for a fork a link to the other side of the lineage. The old Stop receipt line under a
  run shows only when no control receipt already says it (decision 4).
- `client/workbench/RunInspector.tsx` — its hard-coded "Controls" sentence (which said a next-turn
  queue was unavailable, no longer true) is replaced by the six controls with how each is performed
  on this route and the route's note, plus a Lineage row (retry attempt / continues / forked from).
- Styling follows the run record (thin left rule, mono head, `--t2/--t3`), every line that can carry
  a run id or route name wraps where it is written, and the controls reset `white-space` at their
  own edge inside the pre-wrapped record (decisions 2, 5). No `.col` rule touched (decision 6).
- Hot-file edits are appends: `shared/types.ts` (two optional fields), `server/app.ts` (the
  `DurableControls` block and four routes), `client/api.ts` (two functions), `Shell.tsx` (two props).

## Proof

- `tests/h08-durable-controls.test.ts` (12, real HTTP through `createApp`): per-route profiles;
  Steer applied / replay / 409 / not-applicable; Steer refused on a route without it, with the
  contract's words and a pointer to Queue, and recorded; Queue under the derived identity with
  replay and 409; Stop scopes, embedded StopReceipt, refused `generation` on a route without
  interrupt, `nothing-to-stop`; Retry with the same inputs (same documents and prompt reach the
  engine), attempt 2, replay without a second dispatch, original untouched; Retry blocked by a
  `conflicted` approved write with nothing sent; Resume refused on widened permission, then applied
  with its revalidation list; Resume refused on a changed source and on a withdrawn route (a
  `DurableControls` with a resume-declaring contract over the real store); Fork lineage with the
  origin's records deep-equal before and after, replay making no second fork, refusal by contract
  words; namespace conflicts both ways, 400 and 404; receipts identical after a restart, replay after
  restart performing nothing, 409 after restart.
- `tests/h08-control-profile.test.ts` (7): revision is additive and readable; control families equal
  the adapter command families; the per-route table above; host steer is not Steer; the fixture is a
  valid contract declaring all six; state applicability; digest independence from key order.
- `tests/h08-durable-controls.spec.ts` (2, Playwright, built Console, own host): on the fixture
  route, Steer → Queue → Stop (cancelling the queue) → Resume by keyboard → Stop → Retry (attempt 2)
  → Stop → inspector lists the six → Fork, origin runs unchanged, open the fork and back link; on
  the plain sample route only Stop and Queue are offered, the queue is labelled, Stop options holds
  only "Cancel queued follow-ups", keyboard Escape returns focus, and no Run controls toolbar appears
  after Stop.

## Proposed defaults (conservative, Andrew's to confirm)

1. **Resume and Retry ask once before sending; Stop and Fork act on the press.** "Whether a click
   runs an action or selects it" is Andrew's decision; the two that send work to an engine confirm,
   matching the existing send confirmation.
2. **No override for uncertain effects.** Retry and Resume stay blocked; the person checks History
   and starts new work. (A future "I checked, retry anyway" acknowledgment is a question below.)
3. **Resume refuses a widened thread permission**; Retry runs under the thread's current permission
   as a new Start would.
4. **A fork starts at *Show me first*, starts no run**, and copies the origin thread's route, model
   and Agent choice and mode (choices, not authority).
5. **A host steer is not Steer.** Where a route only holds a message until the turn ends, the
   Console offers Queue and says so.
6. **Refusals are durable receipts.** Receipts are never evicted; a project at 2048 receipts refuses
   new controls (`control_receipt_capacity`) rather than forgetting old ones, as Work receipts do.
7. **The Console's plain Stop now goes through the control route** (same server effect as the old
   `/work/:sessionId/stop`, plus a receipt). The old routes stay for other callers.
8. **Provider charging is not an uncertain effect** for Retry's block; it is named in Retry's
   confirmation instead.
9. **The control fixture is test-mode only** (`DIOMEDES_TEST_MODE=1`, per project via `PUT
   /api/projects/:id/controls/fixture`) and is not in `ROUTE_CONTRACTS`, so readiness and
   conformance never count it.

## Known gaps / follow-ups

- **No provider route offers Steer, Resume or Fork on Work runs yet.** The contract, receipts,
  refusals and Console are route-agnostic and proven on the fixture; H03 (Claude Code live
  controls) and H05 (Cursor ACP session load) plug in with `registerDriver` (and `contractFor` if
  their Work runs answer by a session contract). Nothing claims those are shipped.
- H04's kept-session routes (`/claude-sessions`, `/opencode-sessions`) keep their own steer/resume/
  fork endpoints; they are not Console conversation routes (CD-01 Decision 5), so their controls are
  not yet folded into these receipts. Folding them in is a driver registration once a Work run can be
  backed by a kept session.
- Diomedes conversation turns (Home / project conversation) are out of scope: the controls here are
  for task Work runs.
- Harness-backed runs (`native-fixture`, `codex-report`) declare native resume/retry/fork through
  RunService but are not wired to Work runs, so they are refused with that said.
- Control receipts are not validated fail-closed on load the way Work receipts are; a replay still
  compares digests, and nothing trusts a receipt's fields for authority.
- Runs admitted before this change have no recorded inputs and cannot be resumed or retried.

## Proposed canonical-doc patch

Not applied here: the integrator reconciles the canonical documents.

**`docs/DIOMEDES_LIVE_ROADMAP.md`** — §5, after the paragraph beginning "Diomedes contract first;
ACP is the preferred supported external transport.", add:

> H08 durable controls (DIO-13, 2026-09-24, `docs/implementation/2026-09-24-h08-durable-controls.md`):
> Steer, Queue, Stop, Resume, Retry and Fork are six distinct Work commands under work-control
> revision 2026-09-24.1, each with a command identity (replay returns the same receipt; a changed
> payload is refused) and an append-only receipt recording who asked, what it targeted, the route
> answer and what the route did (applied, queued, refused with a reason, or uncertain). Availability
> is read from each route's adapter contract plus the drivers wired to Work runs; the Console offers
> exactly that. Retry is blocked while an effect may already have happened; Resume re-checks
> permission, inputs, route and model and never runs with wider authority; Fork makes a new task and
> thread that refer to the origin without changing it. Today: Queue and Stop on every route, Retry on
> every non-sample route; Steer, Resume and Fork are proven on the test-mode control fixture only and
> reach provider routes as H03/H05 wire them.

and in §9 "Existing open decisions remain:", append: "whether Resume and Retry keep a confirmation
step; whether a person may acknowledge an uncertain effect and retry anyway."

**`docs/DIOMEDES_PROJECT_MEMORY.md`** — under "Files, packs, permission and evidence", add:

> **Steer, Queue, Stop, Resume, Retry, Fork.** Six distinct controls on a Work run. *Steer* reaches
> the running turn and exists only where the route can do that; *Queue* holds a message for after
> the turn or task (a route that only holds a message is offered Queue, named as a queue); *Stop*
> has three scopes; *Resume* continues a stopped run from its record after re-checking what it would
> run with; *Retry* is a new attempt with the same recorded inputs, linked to the original, and is
> blocked while an effect may already have happened; *Fork* starts a new task and thread that refer
> to a chosen run. Each leaves a *control receipt*: who asked, what it targeted, what the route did,
> and who did it — Diomedes for what it composed, the engine for what the route did itself.

**`QUESTIONS.md`** — add two open questions, with the defaults above until answered:
*Durable controls — confirmation*: should Resume and Retry keep asking once before they send?
*Durable controls — uncertain effects*: may a person acknowledge an uncertain effect and retry
anyway, and what must the acknowledgment record?

**`docs/harness/RUNTIME_VERIFICATION.md`** — add: "H08 durable controls: contract, receipts,
refusals, revalidation and Console proven deterministically and in the browser on the test-mode
control fixture and the sample route; Retry (host) exercised on the Codex Work route with a fixture
generator. No live provider steer, resume or fork is claimed."

## PILLAR / ROADMAP / BUILD

- **PILLAR IMPACT:** truthful capability (a control is offered only where the route declares and
  wires it; refusals carry the contract's own words), scoped authority (Resume never widens; Retry
  and Resume start work only through ordinary admission; a fork starts at the narrowest permission),
  truthful attribution (asker is the person; performer is Diomedes or the route's engine, never a
  model), durable evidence (append-only receipts, origin runs untouched). No conflict found; no new
  runtime, permission model or surface.
- **ROADMAP IMPACT:** H08 moves from "stop scopes and follow-up queue" to "six distinct durable
  controls with receipts, capability-driven availability and Console, proven on fixture and Codex
  Retry". DIO-13 is closable for the contract, receipts, semantics and Console; provider-level
  Steer/Resume/Fork arrive with H03/H05 through the seam here.
- **BUILD STATUS:** see the final report for this branch's gate counts.
