# Agent task with a Team exchange, bounded helper and Jev review

Status: implementation authorized by Andrew on 2026-10-01 after exact private checkpoint transfer approval. Offline acceptance and live qualification are pending.

The scenario below records the initial bounded design against app commit
`ee856f18eb179123793e074ce5c3aacc60882ff5`, tree `ffc1e7865cf7a03c5d2aeaac08a45281043edaf3`.
Pillars, Roadmap and Project Memory repository mirrors: `2026-09-27.2`.
The Windows execution candidate preserves base `5f97d97e61300c08002d7767bbbb179c1882a5fc`
and the verified checkpoint, and composes all 94 selected published paths from main
`a0d752e94a6a83ba9cd3b7277361dd2986d56014` plus the exact accepted eight-file funding
source repair `eb7db3cadeacb53ab5db4fb39c1f455f82cb6b9f3a2b0f1bdc4892219d4573f9`.
Funding publication remains with its owner; migration014 alone is not deployable, migration013
and the runner are unchanged, and no SQL was executed. Prior dirty bytes, paid-access
admission/recovery and Board completion guards are retained. The current broader automatic-selection and scoped Personal Trust implementation
is described in [the implementation record](../../implementation/2026-10-01-agent-team-automatic-work.md).

Implementation approval does not authorize a commit, publication, deployment, provider call
or managed-Team rollout. Paid tests require exact account/model/billing qualification and
the parent's allocation within the shared experiment cap.

## Decision to review

Use one Agent task to coordinate a named Team member and a separate bounded helper. The Team
member identifies the discrepant inventory row and replies through Team; the helper calculates
the shortage and its value. The AWS Kimi K3 lead combines both results and asks Jev to review
only the selected synthetic input and combined report. Jev cannot approve changes. The normal
file approval and verification finish the Board task. Stop cancels every run this task started,
while retaining charges whose outcome is uncertain.

The approved bounded design uses that composition and a task-scoped Jev review grant. It grants
no general external evaluation permission and changes no saved project/organization preset.
The subsequent full implementation approval also covers host selection of measured, qualified
Teams for original work requests; explicit manual selection remains a supported bounded path.

## Required outcome and user journey

Both collaboration paths are required. A Team row, a mailbox fixture or an H14 handoff alone
does not prove the Team exchange; a Team member's normal run does not prove bounded delegation.

1. Open the actual Agent UI, select an isolated synthetic Project and its reconciliation task.
   Use the existing Team UI to select or create a lead and member through normal product actions.
   The lead is Kimi K3 through the approved AWS connection. The member and the separate helper
   use the verified OpenRouter GPT-6.1 Sol route with medium reasoning.
2. The task's existing loop-start dialog exposes the selected Team slots, a separate helper
   profile, selected source file, finite bounds and optional Jev review. Advanced model details
   show exact profiles without introducing a new application surface. Only currently admissible
   direct API routes appear; an unavailable route explains its refusal.
3. Starting records one native supervisory run. Its lead lists real members, creates/assigns a
   real Team task to the selected member and sends its bounded question through the mailbox.
   The member executes, sends a model-produced reply, and the lead reads that reply.
4. Separately, the lead calls existing H14 `assign_workers` for one calculation. This produces
   its own child run, explicit file scope, handoff and bounded result, with a different run ID
   from the Team response. The temporary helper is not silently added to the Team roster.
5. Jev reviews the combined report once. The lead proposes `Inventory reconciliation.md` through
   `propose_write`. A person approves the exact file change through the existing Need flow.
   Finish means Review until declared checks pass on the recorded output; then the Board shows Done.
6. A separate Stop exercise demonstrates cancellation while Team work or the bounded helper is
   active. UI evidence and durable control/run records must agree after reload.

Synthetic input: A expected/count `10/10`, B `8/6`, C `5/5`; B unit cost `$3.75`.
Expected result: one discrepant row, B short by 2 units; totals 23 expected and 21 counted;
shortage value `$7.50`. The report states that no inventory system was updated. The Team question
identifies the row; the separate helper calculates totals/value. No production/customer database,
connector or actual stock adjustment is involved.

## Existing runtime composition

Keep `NativeLoop`, `RunService`, `TeamService`, `ModelSessionRuns`, H14, Trust, History and the
existing spend ledger as the authorities. Do not create another scheduler, harness, task lifecycle
or spending system. The `nectovia` managed route continues to refuse Teams and delegates.
Business/Personal identity, paid Agent entitlement, account ownership and source-sharing checks
remain in force on direct API work.

At admission, pin the selected lead/member slot identities, profile revisions, route, requested
model, effort, account route, sources, finite work bounds and root job identity into the native
run. Recheck live membership, account, entitlement, privacy and source access before dispatch;
configuration or historical membership cannot revive revoked authority. Effort must reach the
serialized provider request, not merely the UI or profile record.

Expose the existing host Team tool definitions to the native lead as its admitted real Team slot.
Retain TeamService's membership and lead-role checks. Offer only the tools needed for member
listing, task assignment/status, and mailbox exchange; no agent spawning, deletion, token access
or unrelated project mutation is required. Restrict root-owned assignment effects to the selected
member and this task's recorded assignments. Team updates cannot complete the root task around
its acceptance checks or resolve its Needs.

An ordinary Team wake currently starts NativeWork, which refuses a second active project work
Session. Preserve that exclusivity. For a root-owned assignment, reuse the existing
`model-api-team-work` path in `ModelSessionRuns.workTurn` with a bounded response mode, the live
member's host tool registry, inherited authority ceiling and parent/root metadata. Its final
answer is a Team response, not an unsolicited file proposal. Do not fabricate a Session: TeamRun
already permits `sessionId: null`; add a durable harness-run/root link and project the new run's
status from RunService. Existing standalone Team Work retains its ordinary path.

Persist the assignment, dispatch identity and root ownership before any provider call. Stage
Team/mail effects under the Store lock, then release it before starting or awaiting model work.
The current `sendAsMember`/`maybeWake` chain must not await a nested worker under that lock.
Mailbox replies to the active native lead feed its existing run; they cannot auto-wake another
lead Session. One selected member executes at a time, and all automatic wakes caused by this
assignment retain its root ownership and cap. An unrelated or stopped membership cannot inherit it.

Use stable command, assignment and provider-attempt IDs. Completed replay returns the recorded
Team result without another call. An interrupted unknown provider effect parks for reconciliation;
neither restart nor a new UI click implicitly resends it. Persisted root ownership allows recovery
and Stop to find Team work even if the process exits between dispatch and projection.

The separate H14 child uses the existing sandbox, handoff and read scope. For this task its Agent
ceiling is read-only, its scope is the selected synthetic file, and its result grants no authority.
Root budgets cover both collaboration paths; child units and money are carved, never added.

## Jev authority, data and accounting

Jev is the configured typed evaluator `typesafe/jev-1.13` on OpenRouter Decisions, not a chat
teammate. Reuse `recordEvaluation` for a recorded external model step with actual provider origin,
one attempt and digest-bound input. Do not hide a paid call in pure prepare/inspect hooks.

The current default native principal has only `write-project-file`. A task review choice therefore
creates a revocable, exact scope for `evaluate-with-helper` through existing Trust admission:
this root run, this evaluation profile/version, selected source digests, proposed report digest,
approved route/account and one call. Never add the capability to `localHarnessPrincipal` globally
or pass it to Team members/helpers. Changed content or scope requires fresh review admission;
revocation or failed egress blocks before dispatch. Jev cannot approve a file, widen access, change
a payer or satisfy a human approval.

Use a fixed typed profile to assess: whether B is the sole discrepancy, whether the quantities
and value agree with the input, and whether the report avoids claiming an inventory update.
The input is the selected synthetic rows plus combined report only, excluding unrelated Team
mail/history and credentials. Record advice and abstention/refusal honestly. Missing review does
not count as successful acceptance of this experiment; deterministic verification remains separate.

The transport must carry the admitted downstream/data policy and enforce host input/question
bounds. Current public metadata lists a TypeSafe ZDR endpoint, while existing source commentary
says none exists: refresh qualification instead of treating either a comment or a listing as
proof of account eligibility. The raw SDK evaluation port is not sufficient evidence that a
policy was serialized. Jev has no documented request output-token cap; reserve the conservative
host-bounded request cost and retain it on an uncertain/nonstreaming cancellation.

Use the existing `SpendExposure`/`JobCaps` ledger with one host-issued root scope across AWS,
OpenRouter Team work, H14 work and Jev. Provider adapters must use the supplied scoped ledger.
Neither role wake, retry, recovery nor evaluation may mint a fresh dollar cap. The admissible
amount is the intersection of existing connection/job limits and the root's reserved experiment
allocation; no funding, balance or allowance is changed. The experiment's coordinator also keeps
the aggregate ledger across Mac and any later Windows work: internal stop $8, hard ceiling $10.
That evidence file does not replace runtime reservations.

Default experiment bounds: one Team response run (at most 6 model calls), one H14 child (at most
3), one Jev call, and lead maximum 12 action turns plus its plan call; execute provider calls
sequentially. Use a complete serialized-input bound no greater than 5,000 tokens and a provider
output/reasoning ceiling no greater than 4,096 where the route proves that combined bound.
These are ceilings, not permission to spend: reject oversized prompts or an unproven billing
bound before sending, and reserve every attempted call including failed/uncertain ones. No paid
server tools, automatic provider retries, fallbacks or silently raised limits are part of this task.

## Stop, verification and evidence

Stopping the root prevents further dispatch first, then cancels all persisted root-owned Team
runs and existing H14 children, aborts active HTTP reads and removes owned sandbox resources via
existing cleanup. Stop on a participating Team member also cancels its active owned run through
the host control seam; marking a roster status alone is insufficient. Do not stop unrelated work.
Cancellation/recovery cannot erase requests, mail, receipts, output history or uncertain spend.
Late replies cannot resurrect a stopped member, write the report or advance the root to Done.

Declare supported `file-exists` and `text-contains` checks for the report and expected findings
before running. H17 binds results to recorded output digests; inspect the complete artifact as well,
since matching text alone does not establish absence of contradictory claims. Model/Jev claims
are not deterministic verification. Keep the original input unchanged.

Offline proof must cover the actual serialized routes/models/medium effort; paid entitlement,
membership and Jev permission refusals; source and downstream policy enforcement; real Team
assignment/mail identities distinct from the H14 handoff; root cap exhaustion across both paths;
idempotent replay, revoked scope, Stop races/restart, uncertain holds and approval/Done gating.
Use existing Team/H14, model-session, evaluation, job-cap, sandbox and Board suites. The coordinator
runs checks serially on the 8 GB Mac; fixtures are labeled as fixtures.

Live acceptance starts from the actual Console after secure existing-account readiness and
bounded pricing checks. Retain UI captures, source/build hashes, input/output hashes, root/Team/
child/handoff/Need/verification/control IDs, requested and reported models, serialized effort,
sanitized provider request IDs and usage/cost receipts. Show Ready, working, approval/Review,
verified Done, and the separate Stop outcome. Catalog existence, mocked responses and API-only
probes do not constitute live UI acceptance.

## Implementation boundary and dependencies

Likely integration files: `client/console/{LoopStart.tsx,loop-start-model.ts,TeamView.tsx,Shell.tsx}`;
`shared/{types.ts,native-loop.ts,team-delegation.ts,team-routes.ts}`;
`server/{app.ts,native-loop-routes.ts}`; `server/team/{service.ts,tools.ts,routes.ts,board.ts}`;
`server/harness/{native-loop.ts,model-session-run.ts,evaluation.ts,evaluation-adapter.ts}`;
`server/harness/capabilities/{native-loop.ts,team-loop.ts}`; and the existing route/job-ledger seams.
Keep new composition focused; assign exact ownership before changing shared hot files.

The bounded AWS K3, scoped-ledger/OpenRouter effort and Jev limit fixes proceed under their own
claims and reviews. Do not duplicate the credit-fix owner: app PR #182, Operations PR #8 and real
PostgreSQL role cases remain a separate dependency. Refresh and reconcile current main before
integration; no main merge or production deployment is authorized by this design.

Normal authorized Team-member creation may maintain its existing internal scoped Team token.
That is distinct from creating an external provider credential. No provider key creation, secret
copying/logging, OAuth grant, entitlement/funding mutation or security bypass is needed or permitted.
Mac Codex `PLATFORM_UNPROVEN` checks stay intact; these routes use HTTP, not a substituted Codex
subscription. Live work remains blocked until existing secure account access, current privacy/
price qualification, enforceable billing bounds and the shared budget reservation are available.
