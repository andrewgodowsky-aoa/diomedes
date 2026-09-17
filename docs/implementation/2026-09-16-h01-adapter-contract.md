# H01 — versioned adapter contract, durable event stream, shared transport seams

Date: 2026-09-16. Node `H01.I` of the unified execution package
(`Diomedes_Unified_Execution_Package_2026-09-13`, prompt `03b`). Implementation
lead: Devin (SWE-2) occupying the fable integrator seat per the recorded
precedent. Independent review: pending (`H01.R`, ASTRA prompt `04b`). This
record describes a candidate; it does not claim acceptance, live-provider
behavior or anything shipped.

Base: `e2c1e15` (main `5da4fec` merged with the C00 record through `8ff9136`),
worktree `diomedes-wt/devin-b00-h01-20260916`, branch `devin/b00-h01-20260916`.

The header above records the original implementation. The current follow-up is
the Codex-authored repair over `b115b3c`, documented in
`2026-09-17-h01-preview-repair.md`. The final independent review of the SWE
candidate requested changes; its green producer gates were not acceptance.

## 1. What was built

`shared/adapter-contract.ts` — the one versioned contract (`ADAPTER_CONTRACT_VERSION = 1`):

- `ADAPTER_COMMANDS` — the ten lifecycle commands (`start`, `follow-up`,
  `steer`, `interrupt`, `resume`, `retry`, `fork`, `status`, `reconcile`,
  `close`), each bound to a durable `COMMAND_FAMILY` so a control operation
  carries the same versioned command identity as `work.start`.
- `RUN_EVENT_TYPES` — the closed durable vocabulary: every event type
  `RunService` emits today plus the reserved control-plane types
  (`command.accepted`, `control.applied`, `control.rejected`,
  `step.waiting_event`, `step.failed`, `step.cancelled`) so later items emit
  them rather than fork the set. Unknown types are unknown — never terminal,
  never safe.
- `TERMINAL_EVENT_TYPES` — exactly `run.completed`, `run.failed`,
  `run.cancelled`. `reconcile_required` and `waiting` are parked states; no
  transport receipt is a terminal event.
- `OUTPUT_DELTA` / `transientPreviewSchema` — the preview channel: bounded,
  sequence-numbered, attributed (`projectId`/`threadId`/`requestId` and
  `runId`/`stepId`/`attempt`/`fence`), never
  persisted. A reconnect re-reads the durable record, not the deltas.
- `eventsAfterCursor`, `terminalEvent`, `streamIntegrity` — cursor and
  integrity semantics a reconnecting reader and a verifier share.
- `adapterRouteContractSchema` — the strict descriptor: route id, mode,
  engine identity, all ten commands with explicit `native | host |
  unsupported` answers and a reason, streaming shape, model source,
  authentication, and `testedWith` — the exact binary version the evidence
  covers. A version drift invalidates the proof rather than stretching it.

`shared/contract-revision.ts` — `COMMAND_FAMILIES` extended additively with
`interrupt`, `resume`, `retry`, `fork`, `status`, `reconcile`, `close` (the
file's own extension point; the `2026-09-13.1` revision record is unchanged).

`server/engines/acp-client.ts` — the shared ACP stdio client. One
implementation of the JSON-RPC machinery the ACP routes ran twice:
incremental UTF-8 decode, newline framing with per-line and aggregate byte
bounds, correlated pending requests, declined server-to-client requests with
reply flushing before close, `session/cancel` on failure, drained stderr,
owned-process termination, and failure surfacing at close. Engine
differences are `AcpProfile` configuration — decline tables, the ignored
extension namespace, stdin-end and post-kill verify — exported as
`CURSOR_ACP_PROFILE` / `DEVIN_ACP_PROFILE`. `acpSession` owns the shared
lifecycle: private root, initialize handshake, optional authenticate,
`session/new`, session-id binding, readiness policy, the caller's work, and
root removal in every outcome.

`server/engines/cursor.ts` / `server/engines/devin.ts` — refactored onto the
shared client with public exports unchanged (`CursorAdapter`,
`CURSOR_ACCOUNT_ROUTE`, `CURSOR_VERSION`, `cursorCommand`,
`resolveCursorEntry`, `CursorAdapterDeps` and the Devin equivalents). The
version probe, workspace preparation, ask-mode policy, model pinning and
mode-confirmation state stay adapter-side; the transport does not.

`server/engines/contract.ts` — `TextEngineAdapter` gains the required
`contract` field: an adapter without a registered descriptor does not
typecheck. All five adapter classes bind their registry entry
(`routeContractFor`), so the bound descriptor *is* the registry object —
never a private copy.

`server/harness/route-contract.ts` — `ROUTE_CONTRACTS`: one descriptor per
route — the five text engines, `sample`, `codex` (external-session), and the
harness-side routes `native-fixture`, `codex-report`, `harness-runtime`.
Every command is answered honestly: harness routes get the run-service
surface (`resume`/`retry`/`fork`/`reconcile` native); single-turn text
routes declare `follow-up`/`steer`/`resume`/`fork`/`reconcile` unsupported
because nothing outlives the request process; `interrupt` is native where
the route owns the process.

`server/harness/conformance.ts` — the reusable conformance surface:
`contractChecks` (schema validity, all ten commands answered, unsupported
declared with reasons, streaming honest to mode, tested version pinned) and
`streamChecks` (dense seq, run-bound, typed, attributed step events, exactly
one terminal event at the end or none while parked). Outcomes reuse the
revision's evidence vocabulary.

`server/harness/adapters.ts` — `ADAPTER_CAPABILITIES` extended to all five
external engines with the honest enforcement labels (`toolCalls: observed`
per `TEXT_ROUTE_CONTROLS`; `resumability: unsupported` because each request
is a fresh session).

## Repairs after independent review (2026-09-17)

Codex's independent review (`swe2-b00-h01-review-20260917`) found the
contract declared but not operative, the preview channel under-specified,
capability labels overclaimed and conformance checks incomplete. The
repairs:

- **The descriptor is now operative.** `commandGate` in
  `shared/adapter-contract.ts` is the single check every entry point runs:
  `EngineService.generate` refuses dispatch when the adapter's descriptor
  declares `start` unsupported (`COMMAND_UNSUPPORTED`), when it carries no
  valid contract (`CONTRACT_INVALID`), or when the descriptor names a
  different route or an unproven build (`CONTRACT_MISMATCH`). `NativeAgent`'s
  constructor runs the same gate on its `ModelAdapter` — `contract` is now a
  required field — and `CodexEngineAdapter` and `askCodex` self-guard the
  same way.
- **The preview channel is a contract, not a callback.** `onDelta` stays the
  adapter-facing raw sink; callers receive `onPreview` frames through
  `previewSink`, which stamps run identity and a dense sequence, applies
  redaction (`baselineRedact` wired at `app.ts`; the deps seam is
  `redactFor`) *before* measuring, enforces the UTF-8 byte bound
  (`transientPreviewSchema` now measures bytes, not characters), and treats
  an over-budget frame as an `OUTPUT_LIMIT` violation — never a truncation.
  A caller-supplied `onDelta` is refused (`PREVIEW_CONTRACT`).
- **Capability labels are honest.** The five text routes' `filesystemWrites`
  read `observed`, not `enforced`: proposals arrive only through the
  recorded writer and the engine's own tool restriction is engine-honored
  configuration, not Diomedes containment. `codex`/`codex-team` keep
  `enforced` — the write-denial probe is a real check there.
- **Conformance proves agreement, not just shape.** `streamChecks` adds
  `terminal-state-agrees` (persisted state vs the terminal event — a
  completed run with no `run.completed` fails) and `lastseq-matches-stream`
  (`lastSeq` vs the last written seq). `contractChecks` adds
  `tested-version-current` — a descriptor whose engine version moved past
  its `testedWith` proof is stale evidence, not a valid route.

`server/harness/index.ts` — the registry and conformance surface exported at
the harness boundary.

## 2. What was deliberately not built

No H02–H12 work: no new runtimes, no provider sessions, no steering channel,
no durable delta stream (deltas stay transient by contract), no generic
control plane. The existing `RunService` remains the durable spine. The text
runtime seam drives its admission and dispatch steps; the follow-up repair also
checks the current lease and attempt at preview publication and invalidates
obsolete controllers. ACP remains a transport mapped onto the contract; nothing
in the descriptor is sourced from ACP.

The request/project/thread trace also carries run, step, attempt, fence and
preview sequence through Store/SSE to the Console. The presenter rejects
duplicate or older frames and discards a preview on a gap, changed attempt or
reconnect, then reads durable state without dispatching again. Result identity
checks and the durable run event sequence remain separate authorities.

## 3. Acceptance mapping

| required case | where it is proven |
|---|---|
| one versioned contract all routes carry | `adapterRouteContractSchema` strict-validated over `ROUTE_CONTRACTS` (adapter-contract test) |
| every real adapter family registered | `ADAPTER_CAPABILITIES` + `ROUTE_CONTRACTS` cover all five `EXTERNAL_ENGINES`; `.contract` bound on each class |
| durable event stream with explicit terminals | `streamIntegrity`/`terminalEvent` over a real `RunService` run (event-stream test) |
| replay without a second provider call | restarted `RunService` returns the persisted observation; handler count stays 1 |
| unsupported honestly declared | all-commands-answered + unsupported-with-reason checks; text routes declare the commands they lack |
| ACP as transport, not contract | `AcpClient`/`AcpProfile` — engine policy is configuration; conformance probes run both profiles |
| capability evidence invalidated on version drift | `testedWith` pins the binary version; adapters refuse `UNSUPPORTED_VERSION` on drift (existing adapter tests) |
| trace identity across the seam | `IDENTITY_MISMATCH` on response drift; current-lease publication plus run/step/attempt/fence/seq validation through the actual Console (`h01-preview-repair` and independent H01 probes) |
| adversarial transport | conformance probes: out-of-order replies, unmatched ids, oversized/truncated frames, split UTF-8, stderr flood, slow-stdin bound, mid-request exit, declined server calls, owned-process cleanup, extension-namespace profile difference |
| parked is not terminal | restart parks a non-idempotent in-flight step as `reconcile_required` with no terminal event |

## 4. Evidence

- `tests/h01-adapter-contract.test.ts` — 18 tests.
- `tests/h01-event-stream.test.ts` — 9 tests (real `RunService` + `FileRunStore`).
- `tests/h01-conformance.test.ts` — 24 tests (registry conformance + shared-client probes under both ACP profiles).
- `tests/cursor-adapter.test.ts` / `tests/devin-adapter.test.ts` — 83 tests unchanged, all passing against the shared client.
- `tests/b00-h01-repair.test.ts` — the producer-side repair suite: command
  gating at every entry point, stamped/redacted/byte-bounded preview frames,
  conformance false-completion and stale-proof rejections, capability-label
  honesty.
- `tests/swe2-independent-review.test.ts` — adapted from the earlier independent
  suite. SWE added the real `fixtureTextDispatch` fixture and required preview
  identity fields while retaining assertions. Its 22/22 historical producer run
  is a regression result, not a fresh independent verdict or byte-identical import.
- Mock adapters in `tests/engine-service.test.ts`, `tests/ai-setup-api.test.ts`, `tests/picker-setup.test.ts`, `tests/ai-engines-ui.spec.ts` carry `contract` — required field, so fixtures declare it too.

Live-provider evidence: none exists and none is claimed — the conformance
probes run against the shared client with scripted children, which is the
honest tier for this item.
