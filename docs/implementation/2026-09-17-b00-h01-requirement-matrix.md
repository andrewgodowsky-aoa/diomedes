# B00.I / H01.I — requirement-to-test matrix (repair candidate)

Date: 2026-09-17. Companion to `2026-09-16-b00-control-plane-contract.md` and
`2026-09-16-h01-adapter-contract.md`, updated after Codex's independent review
(`swe2-b00-h01-review-20260917`, REQUEST CHANGES) and the repair round.

Every case names the production interface that proves it and the test file(s)
that execute it. `deterministic` means offline and repeatable in the repo
suite; no live-provider, packaged or installed-app evidence exists or is
claimed for this item.

## B00 — 03a acceptance cases

| # | required case | production surface | tests | tier |
|---|---|---|---|---|
| 1 | Personal with cloud offline uses local/BYO | `decideAdmission` admits `local`/`byo` with `NO_ENTITLEMENT_SNAPSHOT`; `ManagedGateway.admit` returns payer `local`/`byo` without reservation | `b00-control-plane-contract.test.ts` "admits local and BYO payers with no entitlement service at all"; `managed-gateway.test.ts` local-only and byo cases | deterministic |
| 2 | dev-fixture org cannot become verified by editing settings | `verifySubject` refuses on `identitySource` alone | `b00-control-plane-contract.test.ts` "refuses a development fixture no matter how complete the record looks" | deterministic |
| 3 | paid invoice cannot override suspension | `decideAdmission` `security_suspended`; `ManagedGateway.admit` checks `billingStatusFor` before entitlement | `b00-control-plane-contract.test.ts` suspension case; `managed-gateway.test.ts` "a paid invoice cannot override a security suspension"; repair suite asserts the refusal precedes the clock read | deterministic |
| 4 | missing rate-card limit is unknown, managed refuses | `kindEligibility` → `unknown` → `charge_kind_unknown` | `b00-control-plane-contract.test.ts` "refuses managed admission when the rate card does not classify the kind" | deterministic |
| 5 | USD 0 cap cannot be changed by questionnaire or model output | `applySpendOverride` refuses every non-contract input; `SPEND_POLICY` frozen | `b00-control-plane-contract.test.ts` USD 0 cases | deterministic |
| 6 | one identity source / one local writer / one budget semantic / no cloud scheduler | `CONTROL_PLANE_SOURCES` map; `CLOUD_SCHEDULER = null` | `b00-control-plane-contract.test.ts` "one of each authority"; `b00-h01-repair.test.ts` module/export handoff + no-second-implementation scan | deterministic |
| 7 | vendor/features/fees matrix incl. rejected add-ons | `VENDOR_ALLOWLIST` + decision doc | `b00-control-plane-contract.test.ts` vendor cases; `b00-h01-repair.test.ts` dated sources, finite limits, `accountState: unverified`, Stripe processing-vs-Billing distinction | deterministic |
| 8 | malformed/missing expiry and invalid clocks fail closed | `leaseUsable`, `snapshotAt`, `assertMembership`, `verifyAuthorization`, `ManagedGateway.admit`, `AllowanceLedger.reserve` | `b00-h01-repair.test.ts` clock sections; `swe2-independent-review.test.ts` expiry/clock cases | deterministic |
| 9 | unknown or inadmissible charge kinds refuse | `isAdmissibleChargeKind` → `charge_not_admissible`; `kindEligibility` → `charge_kind_unknown` | `managed-gateway.test.ts`; contract fixture iteration | deterministic |
| 10 | integer micro-USD preserved; invalid ceiling refused | `AllowanceLedger.reserve` validates `maxMicroUsd` | `b00-h01-repair.test.ts` "a non-finite or non-integer ceiling is refused" | deterministic |

## H01 — 03b acceptance cases

| # | required case | production surface | tests | tier |
|---|---|---|---|---|
| 1 | duplicate and out-of-order events | `streamIntegrity` + ACP request correlation | `h01-event-stream.test.ts` (duplicated seq, gap, foreign runId); `h01-conformance.test.ts` (out-of-order replies, unmatched id) | deterministic |
| 2 | missing terminal event after a successful response | `streamChecks` `terminal-state-agrees` — persisted `completed`/`failed`/`cancelled` without the matching event fails; `lastseq-matches-stream` | `b00-h01-repair.test.ts` conformance section; `swe2-independent-review.test.ts` | deterministic |
| 3 | truncated/oversized JSON | `AcpClient` per-line and aggregate byte bounds | `h01-conformance.test.ts` "fails on a line bigger than the JSON bound", "fails a truncated JSON frame when the process exits" | deterministic |
| 4 | Unicode split across chunks | incremental UTF-8 decode in `AcpClient` | `h01-conformance.test.ts` "decodes a multi-byte character split across chunks" | deterministic |
| 5 | stderr flood | bounded stderr drain in `AcpClient` | `h01-conformance.test.ts` "fails on a stderr flood without retaining diagnostics" | deterministic |
| 6 | slow client | `replyTimeoutMs` reply bound | `h01-conformance.test.ts` "a slow client hits the reply bound rather than hanging" | deterministic |
| 7 | dropped SSE connection | the request surfaces a failure — never a silent success; cancellation and request-timeout sentences stay distinct; a real socket destroy mid-stream aborts the remote session | `opencode-adapter.test.ts` "an SSE connection drop midstream never fabricates a completion and aborts the remote session" (spawned HTTP server, `socket.destroy()` after a partial delta) plus timeout/cancellation/failure-preservation cases | deterministic |
| 8 | two controllers | `EngineService.generate` per-thread `REQUEST_ACTIVE`; `askCodex` `NATIVE_BUSY`; a second dispatch under the same run is fenced by `RunService.step` (`maxAttempts: 1`, lease fence) | `engine-service.test.ts` "refuses duplicate dispatch and drops a late answer after cancellation"; `h01-runtime-seam.test.ts` takeover case; `integrations.test.ts` busy cases | deterministic |
| 9 | process exit mid-tool / mid-request | owned-process failure surfaces; a restarted `RunService` parks the in-flight step `reconcile_required` | `h01-conformance.test.ts` "process exit mid-request fails the request, not silently"; `h01-event-stream.test.ts` reconciliation parking; cursor/devin adapter exit cases | deterministic |
| 10 | sign-out/model withdrawal between listing and dispatch | `selection()` revalidates `AUTH_REQUIRED`/`STALE_STATUS`/`MODEL_UNAVAILABLE` inside the recorded `text:admission` step; the route's enabled/account settings are re-read at dispatch and result commit | `engine-service.test.ts` "rejects a withdrawn model without falling back or sending", "does not mistake unknown authentication for usable models"; `h01-runtime-seam.test.ts` | deterministic |
| 11 | restart with a persisted but unresolved command | `RunService` parks `reconcile_required`; conformance keeps it non-terminal; a cancelled run may carry parked steps while completed/failed never may | `h01-event-stream.test.ts` parking case; `streamChecks` `parked-is-not-terminal` (cancelled-exempt) + `terminal-state-agrees` | deterministic |
| 12 | one authoritative terminal state; unchanged historical attribution | `TERMINAL_EVENT_TYPES` closed set; `single-terminal-event`, `terminal-only-at-end`, `terminal-state-agrees`; intent-hashed steps, origin snapshots never rewritten | `h01-event-stream.test.ts`; `b00-h01-repair.test.ts`; `step-origin.test.ts` | deterministic |
| 13 | fixtures against all five real adapter families | `claude`/`opencode`/`omp`/`cursor`/`devin` adapters under scripted transports | `claude-adapter.test.ts`, `opencode-adapter.test.ts`, `omp-adapter.test.ts`, `cursor-adapter.test.ts`, `devin-adapter.test.ts` | deterministic |

## Owner and SDK amendments

| amendment | where it landed | tests |
|---|---|---|
| Diomedes contract first; ACP is a transport mapped onto it | `shared/adapter-contract.ts` vocabulary is Diomedes' own; `acp-client.ts` is transport machinery only | `h01-adapter-contract.test.ts`, `h01-conformance.test.ts` |
| `RunService` is the durable spine; no parallel subsystem | `NativeAgent` + `CodexEngineAdapter` drive `RunService`; no new runtime added | `h01-event-stream.test.ts`, `codex-engine.test.ts` |
| `TextEngineAdapter`, `ModelAdapter`, `askCodex` are support modes of one contract | required `.contract` on both adapter interfaces; `commandGate` at `EngineService.generate`, `NativeAgent` ctor, `CodexEngineAdapter.run`, `askCodex` | `b00-h01-repair.test.ts` gating section; `swe2-independent-review.test.ts` |
| a second ACP route is launcher/profile configuration | `acpSession` + `AcpProfile` + the shared turn choreography (`acpSessionUpdate`/`acpPromptTurn`/`acpTurnResponse`/`acpExplicitModel`); cursor/devin carry only mode policy and launch/auth differences | `cursor-adapter.test.ts`, `devin-adapter.test.ts` (83 behaviors preserved) |
| external text dispatch is a durable run, not a call beside the runtime | `EngineService.generate` admits through `TextRouteRuntime` on the host `RunService` (`text:admission` local step + `text:dispatch` external model step, `maxAttempts: 1`, egress re-checked at dispatch and result commit); `createApp` wires `harness.textRoute` into the service | `h01-runtime-seam.test.ts` (6 cases: identity persisted pre-dispatch, replay, cancel-before-dispatch, late preview, over-budget preview parking, takeover fencing); mutation-verified: removing the seam fails all six |
| replay without a second provider call | `RunService.step` replays persisted observations; a completed text run answers from its recorded result | `h01-event-stream.test.ts` replay case; `h01-runtime-seam.test.ts` replay case |
| version drift invalidates capability proof | `contractChecks` `tested-version-current`; adapters refuse `UNSUPPORTED_VERSION` | `b00-h01-repair.test.ts`; adapter tests |
| trace identity across the seam | preview frames carry `projectId`/`threadId`/`requestId` + `runId`/`stepId`/`attempt`/`fence`/`seq` through Store/SSE; Console rejects duplicate/older frames and discards on gaps or incompatible attempts | `h01-preview-repair.spec.ts`; `independent-h01-final-20260917.spec.ts`; existing identity suites |
| UTF-8 byte bounds on previews | `transientPreviewSchema` measures bytes; `previewSink` poisons the stream on violation, never truncates | `b00-h01-repair.test.ts`; `swe2-independent-review.test.ts` byte case |
| redaction before broadcast | `previewSink` applies `redact` before measuring/emitting; `baselineRedact` wired via `redactFor` in `app.ts` | `b00-h01-repair.test.ts` redaction cases |
| stale/fence rejection; no late preview after cancel | `RunService` serializes live owner/lease/fence/step/attempt checks with publication; takeover/recovery invalidate old signals; live renewal preserves them; expired leases cannot publish | `h01-preview-repair.test.ts`; `independent-h01-20260917.test.ts`; `independent-h01-final-20260917.spec.ts`; existing cancellation cases |
| preview reconnect without replay | a real EventSource disconnect clears ephemeral text; reconnect re-reads state without another provider call | `h01-preview-repair.spec.ts` |
| direct Codex durability | ordinary `codex` declares `host-record`; `codex-report` remains run-driven; conformance rejects a fabricated `external-session` run-record claim | `h01-preview-repair.test.ts`; direct Ask source path in `server/app.ts` |
| capability honesty (repair) | text routes' `filesystemWrites: observed`; `codex`/`codex-team` keep `enforced` (write-denial probe) | `b00-h01-repair.test.ts` capability section; `h01-adapter-contract.test.ts` |
| preserve source error codes | `acpRpcFailure` maps to `AUTH_REQUIRED`/`USAGE_LIMIT`/`PROVIDER_ERROR`; `EngineError` codes unchanged | adapter suites, `swe2-independent-review.test.ts` |

## Live / blocked / unsupported labels

- **Live-provider:** none. No credential is installed and no live call is in
  scope; every row above is deterministic fixture or scripted-transport
  evidence.
- **Unsupported (declared, not faked):** `follow-up`, `steer`, `resume`,
  `fork`, `reconcile` on the five single-turn text routes — the descriptor
  says `unsupported` with a reason, and dispatch refuses through
  `commandGate`.
- **Current prerequisites:** B00 and the local C00 rollout are accepted at
  `b115b3c`, as recorded in the shared coordination root's
  `results/integration-final-20260917.json` and
  `results/C00.R-rollout-20260917.json`. C00.R-3 and its incomplete transition
  remain historical records. H01 is still unaccepted pending independent review
  of the exact repaired candidate; green producer tests do not release successors.
