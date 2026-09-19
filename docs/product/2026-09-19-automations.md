# Diomedes Automations
## Existing-plan audit and architecture-aligned product specification

Date: September 19, 2026  
Version: 2026-09-19.1  
Status: Owner-authorized plan publication; implementation pending, not released or production-certified  
Canonical repository: docs/product/2026-09-19-automations.md  
Cloud counterpart: https://docs.google.com/document/d/1iOf_-0c1ft5w-KhJpp1eOXLMGzo8QVYHWQKJg9YYp5o/edit  
Traceability: BUS-10 (company workflow dashboard), OPS-08 (recurring work), OPS-09 (host availability), OPS-10 (notifications); existing Runtime / Trust / Console foundations  
Source snapshot: `andrewgodowsky-aoa/diomedes@448448683458c2ef813035f344baa79a4c6817bd`

## 1. Purpose and conclusion

Andrew requested a section of the harness where business owners and other users can see what is actually automated, its progress, and its results. He requested checking the current plans first and either creating the missing plan or closing edge-case gaps in the existing one.

The concept already exists. The September 5 business strategy explicitly describes an Automations section covering what runs, when, last result, failures, and checkpoints. The September 12 execution-brief review identifies BUS-10 as lacking a company workflow dashboard with owners, freshness, results, and time-return measures, and OPS-08 as lacking recurring scheduling with timezone, host, budget, and missed-run policy. The inspected September 18 main snapshot still declares only Thread, Board, Team, and Connections in `ShellView`; its business proposal compiler explicitly supports manual starts only and keeps recorded schedules inactive. [R1–R4]

Therefore, this is a consolidation and strengthening of planned work, not a new competing subsystem and not a claim that a production Automations feature already exists. Existing run, step, event, authorization, evidence, and presentation primitives are valuable foundations. Their presence does not by itself prove recurring execution or an owner-facing operations section. [R5–R8]

The proposed section should answer: What have we enabled? What does it do and not do? What is working now? What needs a person? What happened last time? When should it happen next? Is its data current? What did it change? Where does it run? How much did it use? How do we stop it safely?

Success means a nontechnical user can answer those questions without inspecting an agent transcript, and every answer can be traced to the same authoritative records used by the rest of Diomedes.

## 2. Evidence boundary and documentation drift

This audit read the existing repository contract, canonical roadmap and project memory, selected current source, and the historical execution review. It did not run the Windows app, execute repository tests, inspect every working branch, or prove production scheduling, host failover, connectors, or tenant isolation.

At the original audit, cloud roadmap/memory were version `2026-09-17.1`, while repository mirrors were `2026-09-15.5` and `2026-09-15.4`. The September 19 publication checkpoint reconciles their current entry points at `2026-09-19.1`, preserving MH-1 and unique repository decisions/evidence through the current index and incorporated pre-Automations snapshots. Those older versions describe audit provenance, not the current plan. Core Pillars remain `2026-09-10.1` and are not amended. See `docs/implementation/2026-09-19-automations-work-items.md`. [R7–R10]

Use Andrew's latest decisions for intent, pillars for enduring constraints, canonical roadmap for sequencing, project memory for meanings, and actual source plus fresh tests for implementation. This published plan does not change a pillar or certify a roadmap checkbox.

## 3. Recommended product shape

Add **Automations** as a first-class destination in the existing Console. Support the same concept in Personal and Business. The Business view can aggregate only the locations, projects, and operations its user is authorized to inspect; the Personal view uses the same core contracts for self-managed work.

The recommended approach is a dedicated Console section backed by existing work records. Putting everything inside Settings would make ongoing operations difficult to inspect. Building a separate workflow application or a second execution engine would duplicate the architecture. A node-graph editor is not required for the first useful release.

Automations and Auto To Do have different jobs. An automation describes the recurring responsibility or event-driven procedure. Auto To Do contains the concrete tasks produced by an occurrence. Thread explains an individual execution; Team shows participating workers; Files holds the resulting artifacts; Needs you contains the authoritative decisions. All cross-links resolve to the same records rather than creating copies.

A manually invoked reusable job may appear in this catalogue, but it must be marked **Manual — not scheduled**. A saved suggestion, inactive schedule, unconfigured template, or rehearsal must never inflate the count of active automations.

Industry capability packs may provide templates, terminology, input schemas, and bounded procedures. Installing or activating a pack does not enable a schedule, establish a connection, grant permissions, or create a second runtime.

## 4. Owner-facing information design

### 4.1 Overview

The opening page uses a readable list or table, not a decorative wall of charts. Show a small summary of configured automations, running occurrences, items needing attention, and paused/not-ready items. Clearly define each count and derive it from the authorized query scope.

A row shows the job's plain-language name and purpose, project/location, accountable owner, operational state and reason, current occurrence or most recent result, next planned time or trigger, and source freshness. Display measured usage where useful; additional technical provenance belongs in the inspector.

Filter by location/project, owner, trigger, operational state, and attention. Search should find ordinary job names, not require skill IDs. Default attention ordering prioritizes unresolved external effects and decisions, then failures and missed work, rather than burying them under successful jobs. Preserve the distinction between an empty authorized list, a loading failure, and an offline cached list.

Suggested ordinary labels include **Running**, **Needs approval**, **Waiting for data**, **Waiting for computer**, **Scheduled**, **Paused**, **Manual**, **Setup incomplete**, and **Needs investigation**. Each label is a projection of recorded facts; labels are not new execution states.

### 4.2 Automation detail

Use a compact summary with readable subsections for Overview, Current run / Runs, Rules and access, and Changes. The detail must explain the trigger, actions, inputs, outputs, exclusions, accountable owner, execution identity, host, permitted processing routes, budget, and the specific decisions requiring a person.

Show a plain sentence such as: “Every Monday at 8:00 a.m. Eastern, prepare a management brief from the approved location exports and save it for review. It does not send emails or change schedules, orders, payroll, or payments.” This is proposed example wording, not a shipped behavior claim.

An owner should see what remains manual: which source must be uploaded, who reviews the result, which delivery is not connected, and what is not monitored. A supported draft-only job is useful; describing it as an end-to-end live automation would be misleading.

### 4.3 Current progress and results

Render verified business stages and their observations: sources read, sources rejected, transformation complete, draft saved, review requested, delivery accepted, or verification unresolved. Record elapsed time and the last observation timestamp.

Use determinate progress only when the denominator is real. “2 of 3 location exports checked” is meaningful; “87% complete” inferred from generated prose or token count is not. If an agent expands its plan, retain the history of that change and show updated stage counts without pretending the original estimate was precise. Estimated duration, when available, is labeled as an estimate and based on relevant prior runs.

Separate these facts: the worker finished, the expected artifact was verified, a human reviewed it, and an external destination accepted it. A saved draft is not a sent report. “No changes detected” is a valid result only if all required sources were successfully checked. Missing sources must not produce a reassuring no-change result.

### 4.4 Synthetic example

Proposed demonstration: “Weekly management brief — three locations.” The overview says “Waiting for data: North location export is missing.” The inspector shows two sources checked, one missing, no complete group comparison, no outbound delivery, and a request assigned to the appropriate manager. Once the missing input is supplied, the user can follow the same occurrence to a verified saved draft and its review record.

This example is a test fixture, not a claim about any real customer or an implemented three-location integration.

### 4.5 Readability and accessibility

Use the current Console visual system and the selected appearance package. Keep text on clean, flat surfaces with adequate spacing from borders and separators. Do not import the website's decorative treatment, background grain, glowing dots, or meaningless metaphors. Use explicit mechanical wording: “Runs every Monday,” “Last checked,” “Waiting for approval,” and “Connection expired.”

Do not use color alone for status. Support keyboard navigation, focus restoration after dialogs, screen-reader descriptions, reduced motion, browser/app zoom, long names, narrow supported windows, loading states, and pagination. A live update must not steal focus or constantly reorder the row the person is inspecting. The minimum supported window width remains governed by the existing product decision, not a new value invented here.

## 5. Architecture and ownership

The execution path is:

`manual request / schedule / verified event -> durable occurrence admission -> existing task and Harness RunService -> authorized steps -> recorded effects, events, artifacts and Needs -> Console projections`

Runtime remains the owner of scheduling, occurrence admission, waits, recovery, cancellation, and execution. Core composes the workflow, rules, context, selected Agent/Team, and model/tool behavior. Trust checks identity, scope, credentials, routing, grants, and revocation. Observatory derives evidence and usage. Interop validates supported external event semantics. These are existing responsibility boundaries, not six new services. [R5–R10]

The current `RunService` explicitly owns run state, dispatch, approvals, and durable events; it also explicitly says it is not a scheduler. Therefore, scheduling must be added as a bounded Runtime capability feeding the current admission path, not asserted to exist already or implemented as an unrelated executor. Reuse that one scheduling capability for future infrastructure operating windows instead of adding a timer service per pack or feature. [R5]

Reuse H01 for route capability contracts, H12 for pre-effect authorization, H13/H14 for bounded supervision/delegation, and the established direct-model bridge beneath ModelAdapter. Preserve the September 17 execution-style distinction between Diomedes-owned model/tool loops and bounded external-harness tasks. A workflow cannot claim controls the selected external route has not demonstrated. Exact interface names and ownership must be checked against the active contract revision before implementation. [R7–R10]

### 5.1 Add only the records that do not yet exist

An **AutomationDefinition** is a versioned configuration binding: stable ID, tenant/workspace, explicit project target, owner, execution-principal reference, template/pack revision, trigger, input and output bindings, relevant rules/grant references, permitted hosts/routes, limits, missed-run/overlap policy, and verification requirements. It stores configuration, not an independent run lifecycle. It contains references to protected credentials, never secrets or an approval that can bypass Trust.

A **TriggerOccurrence** is a durable trigger/admission record: identity, trigger source and source event ID or scheduled instant, configuration revision selected for this occurrence, observed time, intended deadline, admission receipt or refusal, and references to the existing task/run. It records skipped, duplicate, expired, or deferred triggers even when no run was admitted. It must not copy the evolving state of a HarnessRun into a second authoritative status field.

The **AutomationOverview projection** joins the definition, occurrence records, current run/step state, Needs, verification, artifacts, host observations, connections, and usage. It includes the source revision/event cursor and observation time. A cache is rebuildable and never grants authority.

Pin the tenant, project target, workflow revision, relevant context/procedure versions, and admitted execution style. A workspace switch or settings change cannot redirect an in-flight job. A missing or deleted target is an explicit blocker; do not silently create a substitute project.

### 5.2 Keep five independent concepts visible

Configuration state answers whether the definition is draft, enabled, paused, or archived. Execution eligibility answers whether the required host, input, route, authority, and budget are currently available. Run state comes from RunService. Result verification records what was actually established. Attention records whether a person must act.

These concepts must not collapse into a single green badge. An enabled job can be blocked. A paused schedule can still have a running occurrence. A finished run can have an unverified business result. A historical success does not establish current connection health.

### 5.3 Preserve existing mutation and evidence paths

Actions use the established command/admission identities, idempotency receipts, expected-base checks, and recorded writer. The dashboard never directly starts a subprocess, calls a provider, writes a business file, changes credentials, or stores an untracked approval. Existing `presentRun`, Needs, and activity projections are the precedent, although they need richer business-facing summaries. [R5–R8]

One specific copy issue to address during implementation is `needFromWaitingStep`'s generic non-idempotent-action sentence promising that recorded before/after data lets the user undo a change. Reversibility must depend on the actual action and destination. Recording an external effect does not establish that it can be undone. This is a source-level observation, not a reproduced runtime incident. [R6]

## 6. Triggers, timing, and availability

The first recurring slice supports explicit local-time daily/weekly schedules plus manual invocation. Event-triggered support follows only for connectors with implemented, authenticated ingestion and tested delivery/recovery semantics. A plain-language editor may propose a schedule, but the user reviews the interpreted time, timezone, next occurrences, limits, and effect scope before enabling it. Do not expose unsupported options as working toggles.

Store a timezone identifier, not merely a fixed UTC offset. Differentiate calendar time (“8 a.m. each Monday”) from elapsed intervals (“every 24 hours”). Preview upcoming occurrences and daylight-saving behavior. Proposed first-release default for nonexistent local times is to skip and record the omission; for repeated local times, fire once at the first occurrence. These are explicit product defaults to validate and display, not facts already implemented in Diomedes. Vendor schedulers also distinguish calendar-time and elapsed-time behavior; AWS documents DST-specific scheduling behavior. [E1]

Each job records its execution location: this computer while the host process is running, a configured background service, or an authorized remote host. Cloud model access does not mean there is a cloud machine maintaining timers and running tools. Background service installation, auto-start, wake, failover, and remote status must remain unsupported until platform-specific proofs exist. [R7–R10]

An offline host cannot reliably announce its own outage from that host. Guaranteed offline alerts require an independent authorized observer. Without one, the interface on another device may show only the latest known heartbeat and timestamp, and local-only users receive a missed-run explanation when the host resumes. Do not advertise live monitoring from stale observations.

Missed-run policy is explicit and bounded: skip, perform one still-relevant catch-up, or ask. For a report template, one catch-up within its configured freshness window can be offered; the default for unconfigured or effectful jobs is no automatic catch-up. Do not flood the owner with days of stale work on restart. Scheduled intent remains distinguishable from actual start and completion times.

## 7. Safety, recovery, and concurrency contracts

At trigger admission and immediately before consequential effects, recheck the relevant live authority, project/tenant binding, data route, host capability, and budget. A previously enabled schedule is not perpetual permission. The organization owner, the accountable workflow owner, and the execution identity are distinct.

Use one durable occurrence identity across duplicate delivery, process restart, and admission retries. For schedules, identity includes the stable definition, trigger identity/generation, and scheduled instant with an explicit migration rule; an innocuous definition edit must not manufacture a second occurrence for the same intended slot. For events, scope deduplication by tenant, connection/provider, and provider event identity. When a provider can emit distinct events for the same business effect, also protect the destination operation with its own business/idempotency key.

An effectful request that timed out is not known to have failed. Keep it unresolved, query a supported reconciliation endpoint or request a person, and never blindly replay it. Lease fencing protects the run record, not an external action already issued; destination-specific idempotency or reconciliation is still required. Preserve this existing RunService invariant. [R5]

Proposed default concurrency is one active occurrence per automation with bounded queuing. Reserve cross-automation resource exclusion only where two workflows can mutate the same business target. Waiting for approval does not authorize bypassing that ordering. Deadlines, cancellation, and documented coalescing rules prevent queues from growing indefinitely. Interactive work takes precedence under the existing resource policy; waiting workflows do not keep models resident solely to remember a timer.

Budgets include child tasks, reviewers, correction attempts, and permitted retries. Keep provider cost, allowance debit, invoice, and estimates separate. An unknown price is not zero. A lost provider response is not permission to release a possibly consumed reservation. Block safely when a hard bound cannot be enforced; do not switch payer or send local-only data to a cloud fallback. [R7–R10]

Webhook adapters verify the provider's signature/authentication and tenant binding, persist accepted input durably, deduplicate, and then feed ordinary admission. Replays, out-of-order events, credential rotation, rate limits, oversized payloads, and reconciliation after gaps require tests. Signature verification does not make the content trusted instructions. Stripe's primary documentation explicitly covers duplicate events and lack of ordering guarantees; this informs the generic edge cases, not a commitment to ship a Stripe integration. [E2]

## 8. Controls and multi-user behavior

**Pause future runs** stops new automatic admissions. It does not claim to stop an occurrence already performing work. **Stop current run** uses the existing scoped cancellation path and records whether it was acknowledged, confirmed, or left uncertain. **Pause and stop** may combine those operations with an explicit scope preview, but must show partial completion if only one succeeds.

**Run once** is an ordinary admitted occurrence with its own identity and the same policies. It must not bypass pause policy, an unresolved effect, or a depleted budget by acting as an unguarded retry. Distinguish retrying a safe failed step from starting a newly authorized run. Both retain lineage and evidence.

**Test safely** uses synthetic or approved data with external effects structurally disabled. A prompt saying “do not send” is not enough. A paid live-model test requires explicit bounded route/cost consent and is labeled accordingly. **Resume** revalidates current permissions, inputs, revisions, and deadlines.

**Edit** makes a new configuration revision with an impact preview. In-flight work keeps its admitted revision unless a separately authorized checkpoint supports the change. **Archive** disables future admissions and preserves history; it is not an unreviewed evidence-deletion switch. Rollback cannot revive revoked authority, removed members, expired credentials, spent credit, or superseded occurrence identities.

View, create, edit, enable, trigger, pause, stop, approve, and inspect sensitive evidence are distinct permissions. Enforce them at the API/host, in aggregations, search, exports, notifications, deep links, and live subscriptions—not only by hiding a button. Location managers see their permitted location scope; organization owners do not implicitly inherit every credential or every sensitive source. Personal and Business remain isolated.

If the responsible employee leaves, jobs must not continue impersonating that employee. An organization-owned execution identity may continue only within an explicitly valid policy and credential arrangement; otherwise block and request reassignment. The first production multi-user rollout depends on verified organization identity and service-principal controls, not local development fixtures.

## 9. Edge-case audit and required proof matrix

The table specifies proposed acceptance tests. None was executed in this planning pass.

| ID | Failure or boundary | Required behavior and proof |
|---|---|---|
| A01 | A recorded schedule has no scheduler | Show Manual / schedule inactive; cannot count as enabled automation. |
| A02 | Host sleeps before a due time | Record missed occurrence on recovery; honor configured skip/catch-up deadline; no invented completion. |
| A03 | Host heartbeat becomes stale | Show last-known time and unknown/unavailable status; do not claim live outage alerts without an independent observer. |
| A04 | Clock change, DST gap, repeated hour | Stable occurrence identity; explicit local-time semantics; preview and deterministic clock tests. |
| A05 | Double-click Run once; repeated trigger | One admitted occurrence for the same command/trigger identity, with a receipt for duplicates. |
| A06 | Crash after trigger persist but before dispatch | Recovery finds and admits the existing occurrence, not a duplicate or silently lost job. |
| A07 | Crash after an external send but before receipt | Mark uncertain; reconcile before retry; never send again solely because response was lost. |
| A08 | Two hosts claim one occurrence | Fence stale claims; prove destination-effect protection or forbid automatic takeover for effectful work. |
| A09 | Previous occurrence still running/awaiting approval | Apply declared overlap policy, queue bound, deadline, and shared-target ordering. |
| A10 | Pause races with a due trigger | Admission has a defined atomic boundary; receipt shows whether it started before pause or was suppressed. |
| A11 | Stop races with external completion | Preserve sent/changed facts; report uncertainty honestly; never label an irreversible effect undone. |
| A12 | Restart after pause or stop | No revival of disabled schedules, cancelled attempts, or spent/revoked authority. |
| A13 | Rule, pack, model, or schedule changed mid-run | Immutable admitted revision and route provenance; explicit impact preview for future runs. |
| A14 | Target project deleted or workspace switched | Existing run remains bound; missing destination blocks; no implicit substitute or cross-tenant output. |
| A15 | Owner/member removed or credential expires | Revalidate live authority; safely block/reassign; no implicit credential inheritance. |
| A16 | One of several location inputs is missing | Expose missing coverage; do not label a complete group report verified. |
| A17 | Source is stale, malformed, incomplete, or schema-changed | Identify exact source and freshness/coverage problem; stop or produce explicitly partial output according to policy. |
| A18 | Empty source response | Distinguish a valid empty result from failed pagination, denial, outage, and missing exports. |
| A19 | Report finishes; delivery fails | Show verified artifact separately from unsent/uncertain delivery and the required next action. |
| A20 | Webhook duplicate, replay, or disorder | Verify source; deduplicate; check current entity state where required; do not revert newer truth with an older event. |
| A21 | Event storm or automation feedback loop | Bound queue/rate/depth, retain causal lineage, coalesce only where semantically safe, surface a circuit-breaker reason. |
| A22 | Retry/reviewer/team exhausts budget | Stop through shared admission; include all child costs; no silent payer/provider/data-policy fallback. |
| A23 | Awaited approval expires or action/input changes | Invalidate stale approval; require the correct fresh decision; no blanket approval copied from a previous run. |
| A24 | Two people edit or approve simultaneously | Expected revision/digest conflict; one recorded decision; no last-write-wins permission expansion. |
| A25 | Unauthorized list/search/live-event/deep-link access | No existence, title, count, result, or secret leakage across tenant/location scope. |
| A26 | Cached UI, lost event cursor, deleted visible source | Rebuild from authorized records, show stale timestamps, avoid ghost-running/false-success states. |
| A27 | Rehearsal has a real email/payment tool configured | Effect capability denied outside prompts; assert no outbound operation, no real business mutation. |
| A28 | Agent never finishes or repeats no-progress corrections | Bounded attempts, deadline and resource use; record blocked/failed reason and recovery choice. |
| A29 | External harness lacks reliable cancellation or containment | Narrow/refuse workflow at admission or truthfully disclose bounded controls; never upgrade observed to enforced. |
| A30 | Capability pack removed; application updated; store restored | Validate compatibility and migrations; preserve old evidence; no reactivation of revoked permissions or duplicate replay. |
| A31 | Alerts recur on every polling cycle | One attention record per underlying issue, deduplicated notifications, explicit escalation and quiet-hour rules. |
| A32 | Completion notification sent to wrong channel/member | Resolve recipient authorization at delivery time; redact sensitive details; link to an access-checked record. |
| A33 | Archive/delete/offboarding request | Disable future execution safely; apply designed data lifecycle; no blunt evidence purge or unrelated infrastructure disablement. |
| A34 | ROI dashboard has no baseline or uncertain usage | Show Not measured / Unknown; no fabricated hours, cash savings, or zero-cost claims. |
| A35 | Definition edited around scheduled boundary | Preserve slot semantics across trigger-generation changes; prevent skipped or duplicated slots with explicit migration tests. |
| A36 | Input changes between inspection and effect | Bind/check expected source/target revision; revalidate or request review instead of applying stale instructions. |

These cases cover proposed contracts and known boundaries; they do not establish that every edge case in the eventual implementation has been found.

## 10. Notifications and escalation

Reuse Needs you and durable history rather than create another approval inbox. Group alerts by the underlying occurrence/incident and show the concrete action required, authorized recipient, affected scope, due time, and a deep link to the same record.

Routine successes belong in optional summaries; failures, missing data, exhausted budgets, stale monitoring, and uncertain effects have different severities. Quiet hours defer notifications, not safety enforcement. Escalation follows an explicitly configured roster and permissions; failure to reach a reviewer never becomes automatic approval. Push/email delivery status is distinct from the automation's business result.

No push channel, email notification, phone control, or always-on monitoring is marked supported before its underlying connection and host/device identity are implemented and tested.

## 11. Measuring actual usefulness

For an individual job, show successful verified outcomes, attempts/retries, missed/blocked occurrences, elapsed time, time awaiting people, source freshness, and attributable usage. Retain denominators and coverage windows. A success rate must specify whether skipped and blocked occurrences are included; do not hide them by reporting only completed executions.

Time returned requires an explicit baseline and measured new review, correction, and maintenance effort. Manual measurements are labeled as such. Gross machine runtime is not human time saved, and salaried capacity is not automatically cash savings. Keep synthetic demonstrations separate from real customer evidence and publication permissions. [R1, R9]

## 12. Delivery milestones and dependency gates

### Milestone A — Inspectable catalogue and existing-job visibility (BUS-10 foundation)

Add the Console destination, permission-aware listing, job detail, recorded-run links, freshness/coverage, results, and existing controls. Adapt the current weekly-brief configuration as a clearly labeled manual job; do not represent it as an active timer. Readonly visibility can precede scheduling, but production Business aggregation cannot precede verified tenant controls.

Acceptance: from the normal Console, a person finds the configured job, sees that it is manual, runs it through existing authorized admission, follows its real work/evidence, sees a missing-input failure, and returns after restart to the same saved records. No competing RunService or fabricated automation record is introduced for unrelated tasks.

### Milestone B — Bounded recurring execution (OPS-08 with OPS-09)

Add durable trigger records and one Runtime scheduler feeding existing admission. Prove one supported daily/weekly draft-only workflow, next-run preview, host availability, pause, skip/catch-up policy, budget enforcement, deduplication, and restart recovery. Start with one explicitly assigned host; multi-host takeover is not an implicit part of this milestone.

Acceptance: the job starts at its interpreted time without a person pressing Run, or visibly records why it could not. Restart, sleep, DST, duplicate dispatch, pause races, stale source, expired grant, and exhausted budget tests behave as specified.

### Milestone C — Supported event-driven work and production hardening

Implement only named real connector/event paths with verified ingress, credentials, deduplication, ordering/reconciliation, rate limits, version handling, and destination-effect semantics. Add scoped notifications and real multi-location authorization where the required identity and tenancy controls are ready.

Acceptance: reproduce duplicate and out-of-order events, partial external success, revoked members, cross-tenant attempts, and outage recovery on a real supported path without unapproved business effects. A rehearsal fixture alone cannot certify production readiness.

### Milestone D — Governed templates, remote operations, and measured value

Capability-pack templates and reviewed plain-language setup feed the same versioned definitions. Add supported remote status/controls, multi-host operation only after ownership and effect fencing are proved, and baseline-backed value reporting. These are later extensions, not dependencies for a useful single-host draft workflow.

A generic workflow canvas, unrestricted remote shell, arbitrary vendor support, automatic cloud fallback, and invented ROI are excluded. Preserve existing prerequisites, Field Readiness milestone ownership, optional SDKO status, and concurrent worker boundaries rather than renumbering the current program.

## 13. Implementation handoff boundaries

Before changing code, reconcile the active contract revision and work claims. Use an isolated authorized worktree. Candidate integration seams already observed include `client/console/types.ts`, `client/console/Shell.tsx`, the activity projection, `server/harness/run-service.ts`, `server/harness/present.ts`, the weekly-brief service, configuration contracts, the recorded writer, and shared work-control commands. Their appearance here is a navigation map, not permission to edit files another worker owns.

Shared hot files and Trust interfaces follow the current repository integration rules. Any new definition/occurrence modules are proposals; confirm existing equivalents before adding them. Do not rewrite the scheduler or runtime around a third-party workflow system merely to build this screen.

Implementation verification must include focused unit tests for projection and schedule semantics, integration tests for admission/authorization/recovery, the failure matrix above, browser tests of the ordinary user path and accessibility, and a real packaged Windows journey on named build bytes. Record exact commands, counts, skips, failures, and environmental limits; do not copy earlier green counts. Follow the repository's current required gates and independent-review requirements. Andrew authorized publication of this planning patch to GitHub and Drive on September 19, 2026. That authorization does not extend to a future implementation commit, push, release, deployment, real customer effect, or production credential use.

## 14. Pillar and roadmap impact

Advances: P01 deterministic work where sufficient; P02 common configurable product; P04 point-of-work visibility; P05 inspectable setup and health; P06 bounded unattended ownership; P07 honest model/engine attribution; P08 meaningful human decisions; P09 scoped authority and billing; P10 measured value; P11 less founder-dependent support; P12 shared Personal/Business foundations.

Risks to prevent: a second runtime, inflated autonomy claims, a decorative dashboard detached from evidence, owner-role overreach, approval spam, accidental billing changes, and health claims based on stale local observations. No intentional pillar supersession is proposed.

Roadmap impact: expand BUS-10 and OPS-08 acceptance criteria and bind them to OPS-09/OPS-10 rather than create a duplicate initiative. Keep the current weekly brief manual until scheduling is actually implemented. Use the reconciled version 2026-09-19.1 roadmap/memory entry points and preserved snapshots; do not repeat the superseded draft reconciliation handoff. Basic status, permission visibility, pause/stop safety, and truthful failure reporting are Core correctness, not a paid safety upsell.

## 15. Sources and provenance

Repository links are pinned to the inspected snapshot except the canonical cloud documents, whose observed versions are stated above. Older documents supply historical intent, not evidence of current code.

- R1 — User-uploaded `Achilles_v4_Business_GTM_Strategy(1).md`, dated September 5, 2026, section 12 (Automations) and sections 3–6, 15–16 (boundaries and trust).
- R2 — `docs/implementation/2026-09-12-brief-review.md`, BUS-10 and Brief 07 OPS-08–OPS-10 review: https://github.com/andrewgodowsky-aoa/diomedes/blob/448448683458c2ef813035f344baa79a4c6817bd/docs/implementation/2026-09-12-brief-review.md
- R3 — `client/console/types.ts`, inspected ShellView: https://github.com/andrewgodowsky-aoa/diomedes/blob/448448683458c2ef813035f344baa79a4c6817bd/client/console/types.ts
- R4 — `shared/packs.ts`, inspected lines 570–640, manual-only schedule handling: https://github.com/andrewgodowsky-aoa/diomedes/blob/448448683458c2ef813035f344baa79a4c6817bd/shared/packs.ts
- R5 — `server/harness/run-service.ts`, inspected lines 1–160, run authority and effect/fencing boundary: https://github.com/andrewgodowsky-aoa/diomedes/blob/448448683458c2ef813035f344baa79a4c6817bd/server/harness/run-service.ts
- R6 — `server/harness/present.ts`, inspected lines 1–200, status and approval presentation: https://github.com/andrewgodowsky-aoa/diomedes/blob/448448683458c2ef813035f344baa79a4c6817bd/server/harness/present.ts
- R7 — Canonical roadmap, observed version 2026-09-17.1: https://docs.google.com/document/d/1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE/edit
- R8 — Canonical project memory, observed version 2026-09-17.1: https://docs.google.com/document/d/13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw/edit
- R9 — Repository Core Pillars, observed version 2026-09-10.1: https://github.com/andrewgodowsky-aoa/diomedes/blob/448448683458c2ef813035f344baa79a4c6817bd/docs/DIOMEDES_CORE_PILLARS.md
- R10 — Repository operating contract and roadmap/memory mirrors: https://github.com/andrewgodowsky-aoa/diomedes/blob/448448683458c2ef813035f344baa79a4c6817bd/AGENTS.md ; https://github.com/andrewgodowsky-aoa/diomedes/blob/448448683458c2ef813035f344baa79a4c6817bd/docs/DIOMEDES_LIVE_ROADMAP.md ; https://github.com/andrewgodowsky-aoa/diomedes/blob/448448683458c2ef813035f344baa79a4c6817bd/docs/DIOMEDES_PROJECT_MEMORY.md
- R11 — `server/weekly-brief.ts`, inspected lines 1–125, deterministic source-linked draft and no sending/publishing: https://github.com/andrewgodowsky-aoa/diomedes/blob/448448683458c2ef813035f344baa79a4c6817bd/server/weekly-brief.ts
- E1 — External primary-source check, AWS EventBridge Scheduler, schedule types and daylight-saving behavior, accessed September 19, 2026: https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html
- E2 — External primary-source check, Stripe webhook documentation, duplicate events, ordering, and verification, accessed September 19, 2026: https://docs.stripe.com/webhooks

External sources inform failure-case design only. No AWS scheduler or Stripe connector adoption is implied. All requirements beyond the source inventory are proposed product/engineering choices, not discovered implementation facts.

## 16. Completion and publication status

This owner-authorized planning publication supplies the existing-plan audit, architecture mapping, proposed behavior defaults, 36 acceptance scenarios and dependency-gated delivery milestones. Detailed implementation plans, candidate defaults and code changes still require the normal reviews and verification before construction or availability claims.

Build: unchanged; no product code written and no application tests run for this documentation change. Publication: version 2026-09-19.1 is the authorized GitHub/Drive planning checkpoint, linked from the current canonical roadmap and project memory. Earlier detached draft/amendment handoffs are superseded for planning status. Deployment and customer automation: none.

Completion boundary: documentation publication and source review only; the acceptance matrix is not a test-pass claim.
