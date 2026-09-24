# H04 — OpenCode kept sessions: persistence, queued steering, stop, resume and fork

Linear: DIO-9. Branch `feature/h04-opencode-persistent-sessions`. Date 2026-09-24.

## What was missing

The OpenCode route (`server/engines/opencode.ts`) started a fresh `opencode serve` and a fresh
OpenCode session for every request, and deleted both when the request ended. It had abort and
deadlines, but no follow-up, no steering, no resume after restart and no fork. The 2026-09-23 audit
named the next bounded step: a `PersistentTextAdapter` for OpenCode.

## What shipped

All of it is behind the existing contracts; nothing here is a second runtime or a parallel
session model.

1. **Kept session transport** — `server/engines/opencode-session.ts`, reached through
   `OpenCodeAdapter.openSession` / `.sessionContract`. One server process and one OpenCode session
   per conversation. The single-turn `generate()` path is unchanged: its SSE turn reader, model
   admission and session/prompt bodies were lifted out verbatim and are shared, so a kept session
   holds exactly the same read boundary, retry refusal, permission refusal and model check.
2. **Durable native session id** — every turn saves a checkpoint (`openCodeCheckpointSchema`,
   `providerId: "opencode"`) through the host's `saveNativeCheckpoint`: `busy` before the prompt is
   sent, `idle` after, with the runtime-reported `providerID/modelID`, the last assistant message id
   and how the session came to be (`started`, `resumed`, `restarted-fresh`, `forked`).
3. **Steering, truthfully a queue** — OpenCode 1.18.4 has no proven mid-turn channel, so the route
   contract declares `steer: host`. A message sent while a turn runs is acknowledged `pending`
   (the revision's `SteeringAck`), sent as the next durable turn of the same session once that turn
   finishes (`delivered`, naming the native session), and `cancelled` or `rejected` with the reason
   when the turn it waited for stops or fails. At most 8 wait behind one turn. The queue lives in
   the process: a restart cancels what was waiting; every sent message is its own durable turn.
4. **Stop that leaves the session resumable** — `POST /session/:id/abort`, then idle is confirmed
   from `GET /session/status`. Only a confirmed idle session stays resumable; otherwise the
   checkpoint is `uncertain` and resume is refused (`RECONCILE_REQUIRED`), never replayed.
5. **Resume after restart** — the isolated server keeps the person's own `XDG_DATA_HOME`, where
   OpenCode keeps sessions, so a new server finds the saved id with `GET /session/:id`. A clear
   404 starts a fresh session and says so: the turn result carries
   `continuity: { origin: "restarted-fresh", detail }` and the checkpoint records the lost id. Any
   other failure to look the session up is a failure, never a silent fresh start. Resume is refused
   across an OpenCode version change, another scope (project, thread, model, account route,
   instructions, read scope), or an uncertain saved turn.
6. **Fork** — `POST /session/:id/fork` (no message id: the child keeps every message) from a saved
   idle session, as a child run (`RunService.fork`, pinned `fork:source`). A build without the route
   is refused with "This OpenCode build did not accept a fork of that session, so no fork was
   started."; a source OpenCode no longer has is refused as `SESSION_INVALID`.
7. **One driver, two profiles** — `ClaudeSessionRuns` (claude-session-run.ts) now takes a
   `NativeSessionProfile` (engine, capability, checkpoint parser, steering policy). The Claude
   profile is the default and its runs, step names and checkpoints are byte-for-byte as before;
   `OPENCODE_SESSION_PROFILE` (opencode-session-run.ts) runs under capability
   `opencode-native-session`. The host validates each provider's checkpoint with its own schema,
   authorises the route through the same text-dispatch authoriser, and recovers and closes it with
   the others.
8. **Routes and capability-driven controls** — `/api/projects/:id/opencode-sessions` mounts the
   same start / turn / resume / fork / interrupt / close / status routes as `claude-sessions`, plus
   `POST …/:runId/steer`, mounted only because the contract answers `steer`. Its status carries
   `controls` from `shared/session-controls.ts`, derived from the route contract alone
   (`steer: "queued"`, never `"live"`), with the engine and tested build as the attribution anchor.
   Claude's session declares no steering, so it has no steer route. Answers project into the thread
   attributed to OpenCode with the runtime-reported model (decision 8).
9. **Conformance** — the `opencode-session` descriptor passes `contractChecks` and a new
   `native-session-run-backing` profile check that refuses drift (route, engine, version, protocol,
   mode, a claimed native steer, resume, stream, auth, model source). Driver runs pass
   `streamChecks` after turns and after restart recovery.

## Proof

Fixture: `tests/fixtures/opencode-session-server.mjs`, a real child process speaking the documented
opencode server routes and keeping sessions in its data folder, so a second process finds them.

- `tests/opencode-session.test.ts` (13): persistence on one server/session; scope and busy
  refusals; stop confirms idle and resumes; unconfirmed stop is uncertain and never resumed;
  restart-resume from OpenCode's store; resume-started-fresh with its sentence; non-404 lookup
  failure is a failure; version/scope/no-session refusals; fork success keeping messages; fork
  refusals; wrong-model refusal; whole-project read refused before launch; contract controls.
- `tests/opencode-session-runtime.test.ts` (8): the same through RunService and the shared driver,
  including the steering queue (pending → delivered, idempotent by command id, rejected when idle,
  several in order, held again behind a later turn, cancelled on stop), attribution on the turn
  step's origin, restart recovery then explicit resume, the fresh-start notice saved with its turn,
  fork as a child run, and fork refusal starting nothing.
- `tests/h04-opencode-session-routes.test.ts` (4): real HTTP through `createApp`, the engine service
  and the real adapter: thread projection and attribution, status controls, steer route present
  here and absent on `claude-sessions`, restart then explicit resume then fork, fork refusal body.
- `tests/h01-conformance.test.ts` (+11): the descriptor and its drift checks.

These tests fail on `main` (modules and routes absent; checked against an `origin/main` worktree).

## Not proven, and not claimed

- **No live OpenCode.** No binary or OpenCode Go account exists in this environment or CI. The
  endpoints and event shapes come from the pinned adapter's existing live captures (2026-09-23) and
  OpenCode's published server documentation (`GET /session/:id`, `POST /session/:id/fork`,
  `POST /session/:id/abort`, `GET /session/status`). Whether opencode 1.18.4 answers a missing
  session with 404, lists only non-idle sessions in `/session/status`, and keeps the deny-all
  configuration on a forked session is designed for, not verified. The contract's `testedWith`
  1.18.4 describes the build the route targets; live acceptance is separate, as for the Claude
  session.
- **Mid-turn steering.** OpenCode's current source appears to accept a prompt into a running loop,
  but that is unverified for 1.18.4, so it is not used; steering is the host queue only.
- **Console.** The kept session is an explicit native route, as the Claude session route was when
  H03 landed. It is **not** a Console conversation route: CD-01 Decision 5 names Claude Code and the
  model-API routes as the only conversation drivers, and adding OpenCode there is Andrew's decision
  (recorded below, conservative option taken). So no Console screen offers these controls yet; the
  API exposes them from the contract so a surface can offer exactly those when that decision is made.
- The steering queue is process-local by design; it is not a durable outbox.
- A kept session keeps its OpenCode session in the person's own OpenCode history (the single-turn
  route deletes its session). That is inherent to resuming it.

## Decision recorded (conservative option)

Whether OpenCode becomes a Console conversation route (joins `isConversationRoute`) changes CD-01
Decision 5. Not done here. Proposed for Andrew: allow it, driven by this kept session, with the
Console offering exactly `sessionControls(contract)`.

## Proposed canonical-doc patch

Not applied (this lane does not edit the canonical documents or `QUESTIONS.md`).

- **Roadmap, H04 row / harness section:** "OpenCode kept session implemented behind the
  PersistentTextAdapter contract (route `opencode-session`): durable native session id, follow-up,
  host-queued steering (never mid-turn), stop with confirmed idle, resume after restart with a stated
  fresh-start path, and fork, all through the shared native conversation driver and RunService;
  fixture and conformance proof only. Remaining for DONE: live acceptance against opencode 1.18.4,
  and the Console surface once OpenCode is admitted as a conversation route (CD-01 Decision 5)."
- **Project memory, terminology:** "*Queued steering* — a message sent while a native turn runs,
  held by Diomedes and sent as the next turn of the same native session; acknowledged `pending`,
  then `delivered`, `cancelled` or `rejected`. Distinct from live steering, which reaches the
  running turn and is declared `steer: native`." and "*Restarted fresh* — a resume the engine could
  not honour because it no longer had the saved session; a new native session is started and the
  turn says that earlier messages were not carried."
- **QUESTIONS.md (new):** "Should OpenCode's kept session become a Console conversation route
  (amending CD-01 Decision 5)?"
- **docs/harness/RUNTIME_VERIFICATION.md:** add the `opencode-session` route as
  fixture-and-conformance verified, live unverified.

## PILLAR / ROADMAP / BUILD

- PILLAR IMPACT: harness honesty advanced — capabilities are declared per route and the one
  queued-steering behaviour is named as a queue; attribution stays with the runtime-reported OpenCode
  model; no new runtime, permission model or surface. No conflict found.
- ROADMAP IMPACT: H04 moves from "adapter with abort and deadlines" to "kept session implemented
  with fixture/conformance proof"; not DONE until live acceptance and the Console decision.
- BUILD STATUS: see the pull request for the gate counts from this branch's final run.
