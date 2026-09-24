# H03 — Claude Code persistent input, queued steering, Stop, restart and Console controls

Linear: DIO-8. Branch `feature/h03-claude-live-controls`. Date 2026-09-24.
Builds on H04 (PR #82, now on `main`): its `NativeSessionProfile`, steering queue and
`sessionControls(contract)` are reused, not duplicated.

## What was missing

`main` had the opt-in Claude stream-json session (`server/engines/claude-session.ts`,
`server/harness/claude-session-run.ts`): a process kept across turns with `--input-format
stream-json`, explicit `--resume` by native session id, fork, and a native interrupt. The
2026-09-23 audit named what H03 still lacked: Console controls, live steer / stop / restart, and
packaged qualification. Concretely:

- A second message while Claude Code answered was refused as busy; the route contract declared
  steering unsupported.
- Stop from the Console aborted the turn's signal, which killed the process. The session was left
  `uncertain` and could never be resumed, and nothing recorded that it had been killed. Because the
  Console's Stop ends its own request first, the graceful native interrupt could never run from
  the page.
- After a Diomedes restart nothing told a person whether a thread would resume, had to start
  again, or why. A refused `--resume` surfaced as a generic process exit.
- The Console offered nothing for a native session beyond the composer's Stop.

## What shipped

1. **Persistent input, said truthfully.** Unchanged mechanism (one live stdin across turns;
   `--resume <native id>` when the process is gone), now read back: `status().continuity` says
   `live` (this process is running the session), `resumable` (the next message resumes the saved
   session), `new`, or `start-again` with the reason, at the run's event cursor (`run.lastSeq`).
   Follow-up is still never a silent resume: without a live process it is refused and the host
   resolves an explicit `resume`.
2. **Steer, as a queue.** The Claude profile's steering is now `queue` and the route contract says
   `steer: host` ("queued by Diomedes … never injected mid-turn"); conformance requires exactly
   that. A turn sent with `queued: true` while another runs is held in H04's queue as a whole turn
   and sent next, as admitted, on the same process; its caller gets that turn's own result. On the
   Console path the message is resolved, recorded and projected into the thread like any other.
   A message without the flag is still refused as busy. At most 8 wait. If the turn ahead is
   stopped or fails, every waiting message is refused with that reason and nothing is sent. The
   queue is in memory: a restart empties it (each sent message is its own durable turn).
3. **Stop with escalation, recorded.** `ClaudeNativeSession.stop(graceMs)` sends the native
   `interrupt` control request and waits at most the grace (5 s in the app) for the turn's own
   result boundary. Then the session is idle, the process stays live, the turn is saved with
   `interrupted: true, stop: "interrupted"`, and the next message goes to the same process. If the
   boundary does not come (or the interrupt cannot be sent) the process tree is ended
   (`killOwnedProcess`: `taskkill /T /F` on Windows, process-group SIGKILL elsewhere) and the turn
   fails as `STOP_FORCED` with the sentence "Claude Code did not stop when asked, so its process was
   ended. What the turn did before that is unknown, and this session is not resumed." The run is
   then `reconcile_required` and is never resumed. Any result frame after an acknowledged
   interrupt closes the turn, whatever its subtype. A caller that goes away (the Console ends its
   own request on Stop) now goes through the same graceful stop, shared once per turn with the Stop
   route; only shutdown still aborts outright. Stop on a message still waiting in the queue
   withdraws it (`stop: "withdrawn"`); any other command with no recorded turn is still not found.
   The message Stop answer carries `stop: interrupted | killed | withdrawn` where the driver can say.
4. **Restart.** Startup recovery is unchanged (RunService parks a turn that was running as
   `reconcile_required`). The continuity read turns that into "Couldn't resume. Diomedes stopped
   while Claude Code was answering, so that answer's outcome is unknown. The next message starts a
   new session." — never a ghost Running (`busy` is false; nothing is in flight in the new
   process). The next message retires the lineage (`terminated`) and starts again, as before. An
   idle saved session reads `resumable`, and the next message resumes it by native id. A `--resume`
   Claude Code refuses (the process exits before the handshake) fails as `RESUME_FAILED`
   ("Claude Code could not resume the saved session; it exited instead of opening it.") and reads
   as start-again; it is not resent.
5. **Console controls, capability-driven.** `GET /api/projects/:id/threads/:threadId/native-session`
   (`ThreadSessionView`, `shared/session-controls.ts`) returns, for the thread's open native
   lineage: `sessionControls(routeContract)` (H04's function), `busy`, `continuity`, the requested
   and the runtime-reported model, and the queue with what became of each message. A thread whose
   open lineage is not a native session gets `controls: null`. The Diomedes page
   (`NativeSessionControls.tsx`, above the composer) shows nothing when `controls` is null; else the
   state ("Live session", "Resumes on your next message", "Couldn't resume" with the recorded
   reason), attribution as `Claude Code · <runtime-reported model>` (decision 8; the requested
   alias is never shown as attribution), and — only while an answer runs and only where
   `controls.steer === "queued"` — a "Queue a message" field, the queued list and Withdraw. Stop
   stays the composer's own command-bound Stop; a forced stop is said as such. The explicit
   `claude-sessions` routes now also carry `controls` on status and the H04 `steer` route.

## Proof

Fixture: a scripted stream-json child (inline in each test) run through the real
`ClaudeAdapter.openSession` transport. The person's words decide the turn: `[slow]`, `[hang]`
(answers an interrupt with an `error_during_execution` result), `[stuck]` (acknowledges an
interrupt and never ends the turn). A `--resume` of a session the script never created exits before
the handshake.

- `tests/claude-session.test.ts` (+4): graceful stop keeps the process; an error-shaped result
  after an interrupt is the stopped turn; no result within the grace ends the process as
  `STOP_FORCED` with the checkpoint `uncertain`; stop with nothing running is refused. Red before
  the change (4 failed), green after.
- `tests/h03-claude-live-controls.test.ts` (9): through RunService and the driver — persistent
  input on one process with runtime-reported model; queueing (busy refusal without the flag,
  pending → delivered, same process, order, idempotent retry); withdraw and cascade on Stop;
  graceful Stop keeps the session live; a dropped caller stops gracefully; a forced Stop records
  why and refuses resume; resume after restart by native id (follow-up refused until explicit);
  restart mid-turn reads start-again, never busy; a refused `--resume` is `RESUME_FAILED` and not
  resent. The first 8 were red against the pre-driver commit (8/8 failed in a throwaway worktree)
  and green after.
- `tests/h03-thread-session-routes.test.ts` (6): the real app over HTTP — no controls before a
  conversation, then contract controls and reported model; a queued message answered next and
  projected in order; graceful Stop ack; Stop withdraws a queued message (409 `STEER_CANCELLED`
  for its sender) and an unknown command is still 404; a page that already let go of its request
  still gets `stop: "killed"` and a start-again read; restart then resume by id.
- `tests/native-session-view.test.ts` (5): the page's words, attribution and when the queue shows.
- `tests/h01-conformance.test.ts` (+1, 1 changed): the Claude session contract now requires
  `steer: host`; declaring it unsupported fails native-session backing. Red before, green after.
- `tests/h03-claude-controls.spec.ts` (Playwright, 5): the Diomedes page on a Claude Code
  conversation (real Store, Runtime, driver and session transport): no controls before a
  conversation; live session and `Claude Code · claude-sonnet-4-6`; queue while answering, both
  answers in order on one process; Withdraw, graceful Stop and the session still live; after a
  Diomedes restart "Resumes on your next message" and a `--resume` launch; a Stop Claude Code does
  not honour ends the process and the page says "Couldn't resume" with the reason.

## Not proven, and not claimed

- **No live Claude Code.** No binary or signed-in account exists here or in CI. Whether Claude Code
  2.1.252 closes an interrupted turn with a result frame, and with which subtype, is designed for
  (any result after an acknowledged interrupt is accepted) and unverified. So is how it refuses a
  `--resume` of a session it no longer holds: an exit before the handshake is mapped to
  `RESUME_FAILED`; a refusal reported later, as a turn error, reads as start-again through the
  generic failure path.
- **Mid-turn steering.** Claude Code may accept a user frame on stdin while a turn runs; that is
  not verified for this build, so it is never used. Steering is the host queue only.
- **Packaged qualification** is out of this lane's scope and not done.
- A Stop pressed before the turn is durable (the first instant after Send) is still answered "not
  confirmed" by the page, as before; the dropped request does stop that turn gracefully. The page
  still leaves its own stopped message as "could not confirm" until Send again reads the record
  (existing Home behaviour, unchanged).
- The queue and its acknowledgements are process-local, as in H04.
- Only the Diomedes page offers the controls. Project threads on Claude Code still use the
  single-turn direct path (`thread-send.ts`); moving them to the native session is a product
  decision (see below).
- `tests/h04-opencode-session-routes.test.ts` asserts a steer to `claude-sessions` with an OpenCode
  run id is 404; it still passes (unknown run), but its comment's premise ("Claude has no steer
  route") is no longer true after this change.

## Decision recorded (conservative option)

Whether project threads on Claude Code (Ask/Plan/Automatic) should move from the single-turn
direct path to the native conversation, and so get these controls, changes how a thread's route is
chosen (`planThreadSend`). Not done here; H03's controls ship on the one Console surface that
already drives Claude native sessions (the Diomedes page). Proposed for Andrew.

## Proposed canonical-doc patch

Not applied (this lane does not edit the canonical documents or `QUESTIONS.md`).

- **Roadmap, H03 row / harness section:** "Claude Code native session: persistent input with a
  truthful continuity read (live / resumable / start-again with its reason), host-queued steering
  (never mid-turn), Stop with graceful interrupt, bounded grace and process-tree kill recorded as
  `stop: interrupted` or `STOP_FORCED`, restart reconciliation that never shows a ghost Running,
  and capability-driven Console controls on the Diomedes page (`/native-session`,
  `sessionControls`). Fixture, route and browser proof only. Remaining for DONE: live acceptance
  against Claude Code 2.1.252 (interrupt result shape, refused resume), packaged qualification, and
  the decision on project threads."
- **Project memory, terminology:** "*Forced stop* — a Stop the engine did not honour within its
  grace, so Diomedes ended the process tree; the turn's outcome is unknown and the session is not
  resumed." and "*Couldn't resume* — what a thread says when its saved native session cannot take
  the next message (a restart mid-turn, a forced stop, a resume the engine refused); the next
  message starts a new session." (*Queued steering* is H04's entry and applies to Claude Code now.)
- **QUESTIONS.md (new):** "Should project threads on Claude Code (Ask, Plan, Automatic) run on the
  native session and so offer the H03 controls, instead of the single-turn direct path?"
- **docs/harness/RUNTIME_VERIFICATION.md:** `claude-code-session` steer is `host`; stop escalation,
  continuity and resume failure are fixture-verified, live unverified.

## PILLAR / ROADMAP / BUILD

- PILLAR IMPACT: harness honesty advanced — the route declares a queue as a queue, Stop says whether
  it was graceful or forced, and a thread never reads as running when the record says otherwise.
  Attribution stays with the runtime-reported model (decision 8). One surface (decision 1): the
  controls are in the Console only. Decision 4: the state line says each thing once. Decision 5:
  the model and engine line and queued text truncate with `min-width: 0`. No new runtime,
  permission model or surface. No conflict found.
- ROADMAP IMPACT: H03 moves from "native session without Console controls, live steer/stop/restart"
  to "controls, queued steering, stop escalation and restart reconciliation implemented with
  fixture/route/browser proof"; not DONE until live acceptance and packaged qualification.
- BUILD STATUS: see the pull request for the gate counts from this branch's final run.
