# H05 — Kept ACP conversations: session load, restart resume, Stop and questions as Needs

Linear: DIO-10. Branch `feature/h05-cursor-acp-sessions`. Date 2026-09-24. Builds on H04's shared
native conversation driver (#82, now on `main`).

## What was missing

Cursor and Devin run on one shared ACP client (`server/engines/acp-client.ts`), but every request
was a fresh process and a fresh `session/new`, deleted afterwards. Both agents advertise
`loadSession: true` in their captured `initialize` replies, and the client never used it. The
2026-09-23 audit named three gaps: native session load, restart resume, and plan approval as a Need.
Stop on those routes sent `session/cancel` and killed the process in the same breath, and nothing
recorded which of those had ended the turn.

## What shipped

All of it is on the shared ACP client and one kept-session layer, so it applies to every ACP route.
There is no per-engine copy.

1. **Session load (shared client).** `initialize` is read for `agentCapabilities.loadSession`. In a
   kept conversation, the next turn continues the saved session with `session/load` rather than
   `session/new`. The replayed history (`user_message_chunk`, `agent_message_chunk`, earlier tool and
   plan frames) is dropped as history, never read as this turn's answer. The fallbacks are:
   - The agent doesn't advertise `loadSession`: a fresh session every turn, and every one of those
     turns says so (`load-unsupported`).
   - The agent answers ACP `resource_not_found` (-32002): a fresh session, and the lost id is recorded
     (`restarted-fresh`).
   - Any other load refusal is a failure. It is never a silent fresh start.
2. **Kept conversation layer.** `server/engines/acp-session.ts` does the following:
   - It keeps the durable checkpoint (`acpCheckpointSchema`). The checkpoint holds the ACP session
     id, lineage, scope digests, `loadSession` as advertised, `origin`, `lostSessionId`,
     `interruptedRequestId`, `lastStop` and the turn count.
   - The checkpoint is saved **busy, with the session id, before the prompt is sent**, and idle
     after the answer.
   - Each turn is still one owned process. It runs in a private root that belongs to the conversation
     (`<engine cwd>/.diomedes-<engine>-sessions/<lineage>`) and survives the turn, so the agent's own
     session store is there for the next load. Configuration and deny rules are still written fresh
     every turn.
   - Both adapters expose `openSession` under new `cursor-session` and `devin-session` route
     contracts. Their single-turn `generate()` path is unchanged: it now calls the same private
     `turn()` without a kept session.
3. **Restart resume (H01 durable record).** Cursor and Devin are two more profiles on the shared
   driver (`server/harness/acp-session-run.ts`). The driver has a new `recoverInterrupted` profile
   hook. At startup, a run that `RunService.recover` parked because its turn was running is
   reconciled from the durable record alone: the saved checkpoint plus the event cursor. The engine
   is not asked anything and nothing is resent.
   - **Loadable** (a busy checkpoint with a session id, and `loadSession: true`):
     - `RunService.reconcileInterrupted` records the interrupted turn step as `cancelled`, with a
       `step.cancelled` event carrying `afterSeq` and `resent: false`.
     - It is only allowed when every parked step is an external model `read` step.
     - A `recover:<seq>` step saves the checkpoint as idle, `origin: recovered`.
     - An explicit resume then continues with `session/load`, and that turn says the earlier message
       was not completed or resent.
   - **Anything else:** the run is cancelled with "…couldn't resume. Start again.", so no ghost
     Running is left.
4. **Stop.** On a kept turn, the Stop sequence is:
   1. `session/cancel` is sent.
   2. There is a bounded 3 s wait (`ACP_CANCEL_WAIT_MS`) for the agent to end the prompt with
      `stopReason: cancelled`.
   3. The owned process tree is ended.
   4. The checkpoint's `lastStop` records `acknowledged` or `killed`, the error carries
      `stopOutcome`, and the driver records the turn as interrupted.

   After a Stop the session stays resumable. A stopped turn is never resent.
5. **Questions as Needs.** A kept turn may carry host-set `approvals` (`TextRequest.approvals`).
   - **What reaches a person:**
     - Cursor's plan approval (`cursor/create_plan`, through the profile's `planMethod`).
     - On a read turn only, a permission ask for a `fetch` or `think` call that the read scope does not
       already cover. A go-ahead allows exactly that tool call id once.
   - **What never reaches a person:** edits, commands, deletions, moves, mode switches and other kinds
     stay declined. Allowing them would reach past the recorded writer.
   - **How it becomes a Need:** the host broker (`server/engines/engine-asks.ts`) writes an ordinary
     Need bound to the run (`Need.engineAsk`), and the person answers it through the existing
     `/needs/:id/resolve` route. The answer goes back to the agent, which continues the same turn. A
     declined answer is a "no" the agent hears, not a stopped turn.
   - **While the question is open:** the turn deadline is paused.
   - **What expires it:** nobody answering within 10 minutes, a Stop, the turn ending, or a restart.
     The agent is told `cancelled` and the turn stops safely.
   - **What never decides it:** `allowForTask` is refused (400), and no scope grant or model reviewer
     decides these questions. Nothing is approved automatically.
6. **Routes and controls.** `/api/projects/:id/cursor-sessions` and `/devin-sessions` mount the same
   start, turn, resume, interrupt, close and status routes as H04. Status carries `controls` from the
   contract: steer `null`, fork `false`. There is no steer route, and a fork is refused by the
   contract gate.
7. **Conformance.** Both descriptors pass `contractChecks`. They pass the
   `native-session-run-backing` profile check, which refuses drift on route, engine, version,
   protocol, mode, a claimed steer, a claimed fork, resume, reconcile, stream, auth and model source.
   Driver runs pass `streamChecks`, including after restart reconciliation.

## Proof

The fixture is `tests/fixtures/acp-agent.mjs`: a real child process speaking ACP v1 JSON-RPC over
stdio. It keeps sessions on disk in its workspace, so a second process can load them.

- `tests/acp-session.test.ts` (19): the following, for both Cursor and Devin:
  - load and continue
  - no-load start-fresh with its sentence
  - restart from the checkpoint alone, and the lost-session fresh start
  - Stop acknowledged
  - Stop ignored, so the process is ended after the bounded wait
  - the restart decision

  Cursor only:
  - fetch permission → go-ahead, decline and expiry
  - an edit is never asked
  - plan go-ahead and decline
  - no asker, so the plan is declined as on the text route
  - Stop while a question is open
- `tests/acp-session-runtime.test.ts` (5): the following, through RunService and the shared driver:
  - durable turns carrying the session id, with runtime attribution
  - a fresh-start notice on every turn without `loadSession`
  - Stop recorded as an interruption, with `lastStop`
  - **restart mid-turn → reconciled → explicit resume via `session/load`, with the interrupted command
    never resent**
  - restart mid-turn without `loadSession` → run `cancelled` with "couldn't resume", resume refused
- `tests/h05-acp-session-routes.test.ts` (4): real HTTP through `createApp`, the engine service and
  the real Cursor adapter:
  - continuation and contract controls
  - plan → Need in the project → go-ahead via `/needs/:id/resolve` → the agent continues. A task-wide
    allowance and a second decision are refused.
  - decline
  - Stop while the Need is open expires it, and a late answer is refused
- `tests/engine-asks.test.ts` (4): the broker's open, answer, expiry, Stop and after-restart
  behaviour.
- `tests/h01-conformance.test.ts` (+26): both descriptors and their drift checks.

Red evidence:
- On the pre-H05 base, the new files fail (30 failures: the modules, routes and descriptors are
  absent).
- With only the `recoverInterrupted` hook removed, the two restart tests fail and the other three
  still pass.

## Not proven, and not claimed

- **No live Cursor or Devin.** Neither binary nor account exists here or in CI.
  - The two agents' `loadSession: true` comes from the existing 2026-09-11 captures.
  - These are designed for, not observed:
    - whether they answer a lost session with -32002
    - that `session/load` replays history before replying
    - that `session/cancel` is answered with `stopReason: cancelled`
    - that Cursor keeps its sessions under `CURSOR_DATA_DIR`
    - where Devin keeps sessions (it has no data-dir override, so its store is the person's own)
  - Cursor's plan go-ahead body (`{ outcome: { outcome: 'accepted' } }`) mirrors the observed decline
    body's shape. It was not captured.
- **Devin has nothing a person is asked about today.** Its route has no read policy and no plan
  request, so every ask stays declined. The shared layer supports it once its profile does.
- **Console.** As with H04, the kept ACP conversation is an explicit API route, not a Console
  conversation route. CD-01 Decision 5 names Claude Code and the model-API routes as the only
  conversation drivers, and adding these is Andrew's decision. I took the conservative option and
  recorded it here. An engine question does appear with the project's other Needs. Its `taskId` is
  empty, so it shows on the project thread; no thread-specific placement was added.
- **Private roots.** A kept conversation's private root is not removed on close, because it holds
  the session store an explicit resume needs. A deletion lifecycle for it is not designed
  (decision 10: deletion is designed, not a blunt switch).
- The question wait is process-local by design. The Need is durable; the waiting turn is not.

## Decisions recorded (conservative options taken)

- Only `fetch`/`think` permission asks and plan approvals reach a person. Anything that would write,
  execute or switch mode stays declined, because allowing it would bypass the recorded writer.
- A declined question lets the same turn continue. An expired or cancelled question stops it.
- Whether Cursor and Devin kept conversations become Console conversation routes (CD-01 Decision 5)
  is left to Andrew.

## Proposed canonical-doc patch

Not applied: this lane does not edit the canonical documents or `QUESTIONS.md`.

- **Roadmap, H05 row:** "Kept ACP conversation implemented once over the shared ACP client, for
  Cursor and Devin (routes `cursor-session`, `devin-session`). It covers:
  - the ACP session id saved durably before each prompt, and continued with `session/load` where
    advertised (fresh with a stated reason otherwise)
  - restart mid-turn reconciled from the durable record: resumed by load, or ended as unable to
    resume, never Running and never resent
  - Stop as `session/cancel` + bounded wait + process-tree end, recorded
  - plan approvals and out-of-scope fetch asks as Needs answered by a person

  Fixture and conformance proof only. Remaining for DONE:
  - live acceptance against Cursor 2026.08.11 and Devin 3000.10.23 (load, lost-session code, cancel
    acknowledgement, plan go-ahead body)
  - the Console surface once CD-01 Decision 5 is decided"
- **Project memory, terminology:** "*Engine question* — a permission ask or plan an engine presents
  mid-turn that only a person may answer. It is shown as a Need, answered once, sent back to the
  engine, and expired (stopping the turn) if unanswered." and "*Couldn't resume* — a conversation a
  restart interrupted whose engine cannot continue its saved session. It is ended with that
  sentence rather than left Running."
- **QUESTIONS.md (new):** "Should the kept Cursor and Devin conversations become Console conversation
  routes (amending CD-01 Decision 5)?" and "When should a kept conversation's private engine folder
  be removed?"
- **docs/harness/RUNTIME_VERIFICATION.md:** add `cursor-session` and `devin-session` as fixture and
  conformance verified, live unverified.

## PILLAR / ROADMAP / BUILD

- **PILLAR IMPACT:**
  - Trust is advanced. Mid-turn engine questions now reach a person as Needs instead of being
    silently declined.
  - Nothing is auto-approved, and no question can widen past one call or one plan in one answer.
  - Harness honesty is kept: fresh starts, lost sessions and interrupted turns are stated on the turn
    and in the record.
  - Attribution stays with the runtime-reported engine and model (decision 8).
  - No new runtime, permission model or surface is added. No conflict found.
- **ROADMAP IMPACT:** H05 moves from "text route only" to "kept conversation with load, restart
  reconciliation, recorded Stop and questions as Needs, with fixture and conformance proof". It is
  not DONE until live acceptance.
- **BUILD STATUS:** see the pull request for the gate counts from this branch's final run. The
  version, native-runtime hashes, canonical docs and `QUESTIONS.md` are untouched.
