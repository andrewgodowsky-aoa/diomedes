# H03 opt-in Claude native lifecycle candidate, 2026-09-19

Base: `57e8b6ae10eb410598c600cf97f6792a89023bdb`.
Worktree: `F:/Diomedes/diomedes-wt/h03-native-sessions-20260919`.
Actual worker: Astra, explicitly authorized by the parent for this session.
Original leaf claim: `claim_mu801cy7_a8f26dd2` (released).
Production extension claims: `claim_mu8157nn_ef0ab9db` and
`claim_mu81ipdu_3217e95d`, recorded fable integrator seat under parent authorization.
H01 repair is included in this base; formal H01 full acceptance is separate.
This candidate does not declare full H03 acceptance.

Authority read: Core Pillars 2026-09-10.1, roadmap and project memory 2026-09-19.1,
current AGENTS.md, package H03 brief/work item and runtime/adapter contracts.

## Implemented boundary

The default `ClaudeAdapter.generate`, single-turn route descriptor and normal Ask
behavior remain unchanged. The separate opt-in `claude-code-session` descriptor
covers persistent stream-JSON start, sequential follow-up, interrupt, explicit
resume, native fork, status and close. Active steering and provider reconciliation
remain unsupported. Capability evidence is protocol-fixture evidence, not paid
live acceptance.

`ClaudeAdapter.openSession` retains safe-mode, disabled tools/hooks/plugins/skills,
restricted settings, explicit instructions and controlled MCP configuration.
Environment filtering and the existing subscription account route remain in use;
there is no API-key fallback. Permission requests receive a native denial and
terminate the owned process. Child/tool observations, foreign session IDs, model
reroutes and unknown completion fail closed. Account identity is rechecked each
turn. Interrupt acknowledgment never substitutes for the final result boundary.

The persistent transport has a 128-turn limit, 2 MB aggregate process-output
limit and a 30-minute owned lifetime timer that closes active or idle processes.
Identical active input joins one dispatch;
conflicting request identities fail. Repeated identical results are ignored.
Unknown completion leaves busy/uncertain metadata and cannot be resumed or
automatically retried. Explicit native fork uses exact `--resume` plus
`--fork-session` and captures distinct provider identity with retained lineage.
The integrated driver permits same-project, same-thread, same-model/instructions
forks; the lower-level transport supports a separately authorized same-project
thread change, but this HTTP candidate does not expose that broader operation.

## Existing runtime integration

`ClaudeSessionRuns` is a capability driver over the existing RunService.
It stores only live transport handles and active dispatch coordination in memory.
The existing project RunStore, run principal, leases, fences, budgets, stable
step IDs, intent hashes and recovery remain authoritative. Every admitted turn
has a local admission step followed by one external model step. Each idle gap
uses the existing pure wait step with `Suspended('event')` / `waiting_event`.
Ordinary exceptions retain retry-wait behavior.

A generic optional `StepRecord.nativeCheckpoint` envelope contains version,
provider ID and bounded provider payload. RunService validates the exact envelope
and 128 KB bound both on write and reload; the host reuses the strict Claude
schema. That schema bounds all strings and both 128-entry identity ledgers.
Checkpoint metadata contains only IDs, scope/version/model details, account and
instruction digests, and state. No raw prompts, credentials, email, native
transcript content or permission payload is stored there. Ordinary run/step
intent retains the admitted text through the existing runtime convention.

`StepContext.saveNativeCheckpoint` queues the write under the existing run lock,
checks owner/fence/lease, running state, attempt and callback abort/expiry before
mutation, validates, then commits metadata and a hash-only `step.checkpointed`
event. The transport waits for busy metadata before stdin dispatch and idle
metadata before accepting a final result. Process-generation closures prevent a
late callback from binding to a resumed process. A callback timeout supplies its
aborted signal to the durable queue; a timeout wrapper alone is not the fence.

Native metadata is deliberately not a ProviderTranscriptRef: no verified native
prefix hash exists and none is invented. Generic portable pure-prefix forks now
strip native checkpoints from copied observations. The explicit native fork
creates a child via an empty pure prefix and sends the validated parent ID back
to Claude, never copying hidden provider state. Before admission it pins source
metadata in the child's own local read step. Admission retries require that same
parent checkpoint; a changed source refuses before model execution.

Completed/cancelled/failed/uncertain runs cannot accept new turns. Stable command
IDs replay persisted outcomes rather than dispatching again, including the
parent's idempotent Core-conversation projection repair. Explicit resume requires
idle validated metadata and fresh admission; missing live transport is never
silently replaced by follow-up. Unknown interrupted/closed turns remain uncertain.
Result-phase Settings revocation closes the process and prevents success commit.
Shutdown invalidates active requests, closes owned processes and prevents an
opening process from dispatching after shutdown.

The host admits only the exact additional `claude-native-session` capability
through the existing text Settings authorizer. Default authorizer behavior still
accepts only `engine-text-turn`; unrelated capability IDs remain denied.
Native startup recovery executes the existing RunService recovery after validated
load, separately from the Session/Task bridge. No provider process starts during
recovery. Stop/status do not need a currently enabled sending account.

## Mounting and parent-owned projection

`mountClaudeSessionRoutes(app, engines, { authorize, prepare, recordResult? })`
is exported by `server/engines/claude-session-routes.ts`.
Wire `engines.nativeSessions = harness.claudeSessions`.

- `authorize(req)`: existing request/project authority for all routes.
- `prepare(req, body)`: existing selected Claude thread, explicit consent,
  Settings/native account/model selection, ask/plan instructions and guarded Files
  selection; returns the exact admitted TextRequest.
- `recordResult(req, body, result, input)`: optional idempotent projection to
  the existing Core conversation from the committed result, also on replay.

The strict turn body is
`{commandId, threadId, text, mode:'ask'|'plan', sources:[{path,sha}], consent:true}`.
At most eight source references and 32,000 text characters are accepted.
The parent preparation additionally enforces safe paths, exact hashes and total
selected document bytes <=128 KB. No request-supplied model, account, instructions
or checkpoint override is accepted. Routes never retain a Store lock across
generation.

Base: `/api/projects/:id/claude-sessions`.
POST base starts; POST `/:runId/turn`, `/resume`, `/fork` take turn bodies.
POST `/:runId/interrupt` and `/close` take only `{commandId}`.
GET `/:runId` returns the bounded status projection.
Fork allocates a new durable child run ID. Admission mode/source are bound into
turn intent so a command cannot be replayed against a different lifecycle action.

Parent owns `server/app.ts` mounting, Core conversation projection and
`tests/h03-native-session-routes.test.ts`. Those changes are not worker-authored
and their independent HTTP verdict belongs to the parent.

## Evidence and remaining limits

Installed read-only `claude --version` returned 2.1.252 on 2026-09-19.
`claude --help` confirmed stream-JSON input/output, partial output, safe mode,
resume, fork, explicit session IDs and persistence opt-out.
No real auth command, credential read, provider invocation or paid call was run.

Primary upstream sources consulted:

- [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions).
- [Official Python control transport](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py).

The original leaf verification passed 24 owned Node protocol fixtures and eight
existing Claude single-turn regressions. The extension adds 14 focused runtime
tests for checkpoint persistence/reload/fencing, durable replay/collisions,
resume/fork/close/interrupt, unknown recovery, Settings revocation and unchanged
retry semantics. The focused H01 contract, engine-service, provider-outcomes and
Harness lifecycle regressions add 55 tests. Final frozen worker run at
2026-09-19 03:17:41 local passed all 101 tests across seven focused files, with
zero failures and zero skipped. `tsc --noEmit` exited 0 after the final code
edits; `git diff --check` exited 0. Exact hashes accompany the worker handoff.

Fixtures prove host/protocol behavior with fake provider output. They do not
prove real Claude persisted/resumed full conversation contents, live stop of
provider computation, missing native transcript behavior, account expiry/login,
real provider rerouting, packaged restart or live no-orphan behavior.

No full suite, browser, packaging, release, dependency install, commit, push,
merge, new spending or installed-app modification was performed by this worker.
Production candidate implementation is reviewable and uncommitted. Independent
parent review and the explicitly unrun live/package gates remain open.

## Conformance correction and read-only review, 07:24 UTC

Parent's full regression gate found three native-descriptor conformance failures
and one separate scoped-work waitFor timeout. The former were genuine stale
assumptions: only Harness/single-turn modes could declare run-record events and
only Harness routes could fork. The correction admits only the explicit pinned
Claude native profile with its complete expected lifecycle/streaming/model/auth
declarations; unrelated external sessions remain denied. Ten negative mutation
cases cover drift. Targeted B00/H01 repair, conformance, contract and native runtime
tests passed 111/111; TypeScript passed. This does not erase the full-gate failure
or confer full H01 acceptance; the parent owns the next full verdict.

Read-only review identified two implementation issues, then parent-authorized
follow-up corrected both before the final archive:

1. A native fork creates its child before admission. After a failed admission,
   retrying the same command finds the child but does not recover the parent
   checkpoint. The leaf receives `fork:true` without `restore` and refuses it,
   leaving a model step uncertain even though no provider request was sent.
2. Generic Harness cancellation of an idle native run does not close its live
   process. The finished turn removed its abort listener; the native close route
   rejects terminal runs before cleanup. EngineProcess's deadline records an
   error for a reader but does not itself terminate an idle process. Thus the
   stated transport deadline is not a proven idle process lifetime bound.

The fork now durably pins source metadata before admission and verifies the
same parent on retry. A failed admission creates no model step; a changed parent
is refused before dispatch. Connections retain the owning RunService signal
between turns, close on cancel/takeover, and remove their listener/timer on close.
An owned timer actively closes each connection within 30 minutes even when no
reader is waiting. Terminal close disposes transport without new durable work.
Cleanup promises and failures are retained through shutdown.

Five behavioral regressions cover failed-admission retry, changed-source refusal,
generic idle cancellation, terminal cleanup and finite idle lifetime/resume.
The runtime suite is now 19 tests. The final frozen affected suite at
2026-09-19 03:29:23 local passed 185/185 across nine files, zero failed/skipped;
TypeScript and diff checks passed. Artifact hashes are reported in the handoff.
The earlier full-suite failure remains recorded;
the parent owns rerunning and reporting the full regression gate.
