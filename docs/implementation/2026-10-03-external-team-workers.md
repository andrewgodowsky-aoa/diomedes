# External team workers (subscription-aware orchestration S2), 2026-10-03

| Field | Value |
| --- | --- |
| Feature | Subscription-aware orchestration, slice S2: external workers |
| Tracking | DIO-175 (parent). Plan: `F:\Diomedes\deliverables\subscription-aware-orchestration-20261003\IMPLEMENTATION.md` |
| Branch | `feature/subscription-aware-orchestration` |
| Worktree | `F:/Diomedes/diomedes-wt/subscription-aware-orchestration` |
| Owner | Andrew |
| Builder | Claude (Opus 5.5) |
| Base | `feature/agent-team-automatic-work` at 74d2a8c (DIO-177), which isn't on main yet |

Owner decision, 2026-10-03: Claude Code (`claude -p`), Codex and OpenCode may each be a worker, through
their programming interfaces only, never a consumer chat surface. "Implement regardless."

## What it does

A lead Diomedes loop can hand a bounded task to a worker that runs on the person's own installed
coding tool:

| Engine | How a turn goes out | Sign-in check kept from v1 |
| --- | --- | --- |
| Claude Code | `EngineService.workerTurn`, the adapter's non-interactive `claude -p` turn with tools off | The adapter's own account route check |
| Codex | `askCodex` on a fresh `codex app-server` thread, guarded so it's sent only while the ChatGPT account is the one admitted | `requireChatGpt`, then the account digest at dispatch |
| OpenCode | `EngineService.workerTurn`, the adapter's `opencode serve` turn with tools off | The adapter's own account route check |

Each engine is signed in through its provider's own flow on this computer. Diomedes never holds the
credential, never opens a chat session on the person's behalf, and never debits Nectovia credits for
the turn. The Agent SDK isn't used: it needs the person's API key or cloud credentials, and a
person's own key already runs as a model-API worker.

## How it works

- The worker is an ordinary H14 child run under `TEAM_EXTERNAL_WORKER` (version `external-v1`):
  no tools, no sandbox, one turn. The lead's other limits and its handoff ledger are unchanged.
- The child's one model step is the durable record of the engine turn. A throw inside it parks the
  child as `reconcile_required`, which reads as `died`, and the lead stops. An H08 Retry of that
  lead refuses the worker by name instead of sending it again: "Its earlier turn on Claude Code may
  have run, so it wasn't sent again. Start a new task to ask again." The rule is any recorded model
  step, so an answer refused for its length (it ran) is refused on retry too, and so is a worker
  stopped during its turn, by the person or by its wall time. A worker refused before its turn
  (sign-in, files, size) sent nothing and runs again on retry. A restart in between changes nothing:
  the guard reads the record cold.
- Every check that can refuse without sending runs in `validatePrepared`, before the step: the
  engine's admission (re-read when older than 30 seconds), no tools offered, the worker's files read
  whole with cloud sharing checked for every route the text can reach, and the 160 KB context limit
  a conversation turn has. A file that can't be given refuses the turn. Nothing is cut or skipped.
- Codex's signed-in account is pinned when the worker is admitted, as the hash of nonsecret account
  metadata a Codex Need already records. A different account at any later check, or at dispatch,
  refuses the turn before it goes out (plan case A28).
- An answer longer than 48,000 characters is kept as evidence and refused, not cut.
- One external turn per engine account at a time, across every project in this process
  (`ExternalWorkerGate`). A turn stopped while it waits leaves the queue without letting the next
  one run beside the turn in flight.
- Limits: one turn and one worker at a time. An external engine is never a lead, an advisor or a
  delegate, never joins an Agent Team root, and a Nectovia lead still takes no team.
- Funding: the handoff envelope's payer is `person` with the account route, and the `opened` ledger
  event records `execution: external-proposal` and `payer: person-subscription`
  (`shared/funding-source.ts`). Usage reads `not reported`, never zero: none of the three paths
  returns token counts today.

### Admission at start, in order

1. The engine is turned on in Settings.
2. Consent names the engine: "This worker's task and files go to Claude Code, signed in with your
   own account. Confirm before sending."
3. Cloud sharing covers the worker's files for that engine.
4. Model and account route: the request's, else the saved ones. Codex falls back to
   `codex:chatgpt`, and its egress check uses the same fallback.
5. The engine's own fresh admission: install, sign-in, model and account route.

### Launch gate

`DIOMEDES_EXTERNAL_WORKERS=1` attaches the engines to the loop. Without it, a start that names an
external worker is refused: 409 `external_worker_unavailable`, "Claude Code can't work for a team on
this computer." Tests pass the engine port directly through `createApp({ externalWorkers })`.

## Files

| File | Change |
| --- | --- |
| `shared/funding-source.ts` | New. One funding vocabulary, with mappings from the envelope and gateway payers |
| `shared/team-delegation.ts` | External worker routes and limits, execution style, payer and usage on the team view |
| `server/harness/external-worker.ts` | New. The worker's `ModelAdapter`, the per-account gate and the engine port interface |
| `server/external-worker-port.ts` | New. The host's engines as that port: Claude Code and OpenCode through `EngineService`, Codex through `askCodex` |
| `server/engines/service.ts` | Admission extracted into `admitText`; `admitWorkerTurn`, `workerContract` and `workerTurn` added |
| `server/integrations.ts` | `readCodexWorkerAdmission` |
| `server/harness/capabilities/native-loop.ts` | External adapter for worker children, `workerDocuments`, the Codex egress fallback, `setExternalWorkers` |
| `server/harness/capabilities/team-loop.ts` | External child capability and instructions, envelope payer, ledger fields, the Retry guard |
| `server/native-loop-routes.ts` | External admission at start and on retry; refused as advisor or delegate; one turn, one worker |
| `server/app.ts` | Attaches the engine port behind the launch gate |
| `tests/h14-external-worker.test.ts` | New |

## Tests

`tests/h14-external-worker.test.ts` drives the adapter against a scripted engine port, then the real
app, Store, RunService, team port and handoff ledger with a stub model-API lead and a scripted port
standing in for the installed program. Nothing reaches a provider.

Gates, run in this worktree under the heavy slot on 2026-10-03:

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | No errors, on the committed bytes |
| `tests/h14-external-worker.test.ts` | 24 passed (25 after the follow-up below) |
| 16 related files: H14, team, loop routes and hosts, handoff, engine service, integrations, Vertex funding | 334 passed, on the committed bytes |
| Full `npx vitest run` | 561 files: 9,505 passed, 5 skipped, 0 failed |
| `npx vite build` | Built |
| Playwright `ui`, `native-ui` and `field` | 36 passed |

The full run predates the last cleanup: comment wording in `shared/team-delegation.ts`, `execution`
saved only on an external role in `native-loop-routes.ts`, and in `server/engines/service.ts` a doc
comment moved back to `generate` and an unused method removed. The typecheck and the 16 related files
ran again on those bytes.

A follow-up commit holds a stopped external worker to the Retry rule (a Stop can land after the
engine was called) and adds a test for it. After it, the typecheck is clean and the 16 related files
pass: 335 tests, 25 of them in the new file.

Not covered: a live engine. Every engine turn here was scripted; no real Claude Code, Codex or
OpenCode turn ran.

## Not in S2

- Token attribution for Codex (N14) and the other engines stays unknown.
- Every throw inside the worker's step reads as uncertain, because the run service's only known
  outcome for a model step is an out-of-credits refusal. So a worker stopped while it waited for its
  account's earlier turn, or refused by its engine mid-turn (a usage limit, a sign-in that expired),
  isn't resent by Retry either. Telling those apart needs each engine's error codes (A17).
- An answer that arrives after Stop is dropped, not kept as late evidence (N33).
- S3: a Personal Nectovia lead with a subscription worker. It's off by default and waits for the
  D1 wording to be approved.
- The worker row and the receipt's payer split in the UI.
