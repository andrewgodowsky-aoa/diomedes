# Nectovia governed memory and long-context execution specification

**ID:** NC-MEM-LC-2026-10-06.1. **Date:** October 6, 2026.
**Decision:** Andrew approved Approach 3 and the first-pass principles. This specification adds a researched long-context implementation design. Details below are engineering requirements/proposed defaults for builder review, not claims that they exist in the app. No product runtime or production changes are performed by this package.

## 1. Outcome and limits

A person should be able to resume work without repeating stable context, correct an outdated fact, and carry a task across many context windows without losing a constraint or repeating an uncertain effect. A business should be able to ask for an exhaustive reconciliation and see whether every authorized input was actually processed. The result must cite attributable evidence and expose unresolved disagreement and missing coverage.

The service must not pretend that retrieval expands a model's native context, that compaction preserves every detail, that a graph is a permission system, or that memory replaces current source-of-record reads. It must not infer authorization from remembered approval patterns, train on customer content by default, or silently move data to a cheaper provider.

**One architecture:** reuse Core, Runtime, Trust, Store, RunService, Tasks/Board, existing model and external-engine adapters, source policy, account/tenant identity, funding and capability packs. No parallel agent loop, scheduler, billing ledger, global company brain or cloud identity service.

## 2. Logical components and authority

These are responsibilities, not twelve new daemons.

| Component | Owns | Does not own |
|---|---|---|
| Evidence catalogue | Versioned references and authorized retained original spans/objects | External system-of-record truth or source access grants |
| Memory ledger | Scoped claims, preferences, episodes, entities, revisions, conflicts and dependencies | Policies, effect state or raw credentials |
| Retrieval planner | Point lookup, contextual retrieval, document reading, exhaustive traversal plan | Whether a result is factually true or an action authorized |
| Context controller | Qualified budget, selection, compaction and continuation decisions | A replacement model/provider runtime |
| Continuation capsule store | Versioned, source-linked task continuity material | The authoritative Task/Run lifecycle |
| Coverage ledger | Which snapshot partitions were consumed and reduced | A claim of coverage where the source inventory is incomplete |
| Memory maintenance capability | Incremental observations and consolidation candidates | Autonomous privilege escalation or unrestricted effects |
| Interop/engine adapters | Scoped projection and permitted delivery to exact routes | Universal guarantees for opaque vendor sessions |
| Console inspector | Readable evidence, correction, forgetting, omissions and continuity state | A second lifecycle to make a screen look complete |

Recommended module map is in 07_SOURCE_RECONCILIATION.md. The ledger/storage interface can have local SQLite/full-text and managed PostgreSQL implementations. Existing file-backed run records remain authoritative. A graph begins as entity/edge tables; dedicated graph infrastructure is optional after measured need. No customer account or usage migration follows from selecting a memory storage engine.

## 3. Five classes of state

**Original evidence:** message/file/tool-response content with source revision, exact location, classification and retention policy. This can be source-resident; reference-only retention must honestly lose rehydration when its source is gone. A content hash establishes byte identity, not truth.

**Durable memory:** source-supported facts, explicit preferences, recorded episodes and candidate patterns. Store epistemic status separately from active/superseded/retracted lifecycle. An explicit assertion is evidence that a person said something; it is not automatically independently verified.

**Current task state:** existing Task/Run/Step/approval/effect/usage records. The model's summary never determines whether an order was placed, a file was written, a payment succeeded or an approval exists.

**Continuation capsule:** a compact projection linking the objective, acceptance checks, exact active constraints, verified progress, unresolved questions, current source snapshot, relevant memory revisions, next intentions and recovery references. It is a navigation aid for the next window, not unrestricted long-term memory. Do not store hidden chain-of-thought. Store observable findings, concise decision reasons and source pointers.

**Policy and configuration:** existing Trust and organizational configuration. Learned rules and skills can be proposed to the existing reviewed revision process. Activation, permission and inference funding remain distinct.

## 4. Record contracts

See 10_DATA_CONTRACTS.md and contracts/records.schema.json. The strict schema is a portable starting contract; adopt the repository's canonical Zod naming/versioning conventions instead of adding an unvalidated parallel parser.

Every memory has a host-bound tenant/workspace identity, visibility/scope reference, immutable revision identity, lifecycle and epistemic status, source references, observed/valid/verification times, dependencies and retention class. Business organization, department, location, project and individual user are separate dimensions: a nested folder alone cannot stand in for authorization.

Every source reference includes source identity, revision or explicit unknown, content digest where bytes are retained, locator, source type, capture time, current access-policy reference and data-route restrictions. A locator can address lines, transcript turns, page/region, sheet/table/row/column or tool/run/step. Tables retain units, currency, header relationships and formula provenance. Citation resolution never accepts a model-fabricated ID.

A memory use receipt binds run/step, memory snapshot, selected record revisions, all supporting sources, access and deletion epochs, context compiler version, exact rendered digest, selection/omission reasons and token-accounting quality. Unknown usage is unknown, not zero. Old receipts remain inspectable subject to their present read permissions.

A capsule binds a task and run lineage to an expected prior capsule revision and frozen evidence snapshot. It names authoritative runtime checkpoint/effect/approval references, not copied credentials or independently executable grants. A capsule records source coverage and processing frontier, but completion is still verified by the runtime and declared checks.

## 5. Capture and admission

The initial capture lane records only explicit save/correction requests and already-qualified deterministic source observations. General conversational extraction is enabled later after evaluation; it must not index all accessible files by default.

Event intake validates current identity, source consent, scope, retention class and data route. It records an idempotent capture intent with source revision and epoch; a queue is a work record, not permission for a later operation. Each dequeued job rechecks current policy and deletion generation. Original content is minimized before embedding or model extraction. Credentials belong in existing secret stores and are not stored as memory text.

An extraction model returns proposed semantic fields and source locators only. Host code supplies identity, timestamps, policy bindings, verification status and dependencies. Reject unknown fields, fabricated references, out-of-scope entities and malformed structured output. A bounded repair may be a new metered step; invalid records never partly activate.

Do not promote the first sentence of an H18 extract as if it were the entire source. Fetch the original source span, including adjacent qualifications, before creating a durable fact. Synthetic/demo/test outcomes remain explicitly separated from operational evidence.

## 6. Temporal truth and conflicts

Use separate valid-time and recorded-time intervals. An SOP learned today may take effect next month. A corrected historical report may change what is known now about last month's facts. These cases must not be collapsed into latest-text-wins.

Source priority is domain-specific configuration, not an LLM-assigned confidence number. Model inference never defeats a human-approved authoritative policy merely because it is newer. Keep conflicting claims in a conflict group, show their source/period and require an appropriate authoritative source or review when the task depends on resolution.

Entity identity uses stable tenant-scoped source IDs and reviewed aliases. Same names across locations or people do not prove identity. Source deletion invalidates derived links. Repeated generated retellings count as one source lineage; no confidence inflation from self-citation cycles.

Volatile facts such as inventory, balances, schedules and current approval status normally require a fresh qualified read before a commitment. A memory can identify the right source and interpretation without being the live number. Digital availability never implies a physical inspection that was not observed.

## 7. Retrieval and coverage

Choose one declared retrieval mode per subproblem:

- **Point:** exact entity/key or source record.
- **Contextual:** bounded exact/full-text plus optional semantic/relationship candidates.
- **Document:** selected whole document or context-preserving passage spans.
- **Exhaustive:** enumerate all inputs in a bounded snapshot and process every required partition.

The choice is host-validated against task requirements. Explicit all/every/total/reconcile requests and declared coverage checks cannot silently become a top-k answer. Search exhaustion does not prove an item never existed.

For exhaustive work, create a CoveragePlan containing source snapshot/manifest, inclusion criteria, expected item/partition count when available, stable partition IDs, continuation cursor, per-partition state and result digest, deduplication key and reducer version. Enumerate before promising completeness. Unknown source cardinality remains unknown until end-of-stream or an authoritative count is established. Permissions apply to the manifest and its metadata too.

Partitioning must preserve records and dependencies: invoices are not split between amount and currency, table headers follow rows, and contract exceptions remain attached to the provision. Overlap can be used for narrative passages but cannot double-count business records. Reducers operate on canonical record identity and version; exact arithmetic uses deterministic code, not free-form LLM addition.

Re-read or invalidate a source whose revision changes during the scan. For a source without a consistent snapshot, record the observation interval and reconcile changes; do not call that result a transactionally consistent total. A partition failure leaves coverage partial. Retries resume the existing frontier and must not repeat a previously applied external effect.

## 8. Context budget and selection

Extend H18 rather than replacing it. Keep separate sections for policy/instructions, tools, user request, recent protocol-complete turns, memory evidence, continuation capsule, selected source spans and tool results. Preserve original History and old context-accounting records.

The planner uses this conceptual budget:

`inputRoom = min(nativeTotalWindow, qualifiedTaskTotalWindow, configuredTotalWindow) - outputReserve - protocolAndNextToolReserve - safetyMargin`

Apply every additional route request-byte and serialization guard independently. The native validation's current JSON.stringify length ceiling is not a byte count or the native context window. Any change to it needs explicit resource bounds and adversarial tests, not deletion of a guard. Images, audio, tool schemas, wrapper tokens and hidden provider overhead require measured/declared reservations; a text-only estimate must not pretend to count them exactly.

When a provider supports a permitted token-counting API, the counting request itself obeys data-route restrictions and network accounting. A qualified local tokenizer can count locally. Otherwise record an estimate and maintain conservative per-profile bounds; do not claim the estimate is a hard token guarantee. Unknown model window is not infinity. Large-context admission requires a known bounded route/profile or a visible refusal/segmentation plan.

**Proposed initial test settings, not promised optimum:** plan compaction near 70% of admitted inputRoom and target at most 45% after compaction. Hysteresis avoids compacting every turn. Both values are configurable in the qualified profile. Hard admission always checks the next full request regardless of the soft threshold. If exact required content alone will not fit, segment/retrieve a narrower scope or stop with an explicit need; do not silently drop the current question, active constraints or pending tool state.

Use deterministic stable ordering and source-unit boundaries. Critical exact constraints are anchored by host/source evidence, not selected by a model's free confidence score. Superseded constraints stay available for historical questions but not as operative instructions. Memory text remains data, lower priority than real instructions.

## 9. Safe compaction and continuation

Compaction is distinct from Dreaming. Foreground compaction preserves one current task; Dreaming proposes reusable cross-task knowledge later. Neither should write authoritative task state from model prose.

At a safe step boundary:

1. Freeze input sequence and source/authority epochs; preserve complete pending tool-call/result and effect-reconciliation references.
2. Create a durable compaction intent naming method/model/route, parent job budget, source manifest, previous capsule revision and maximum cost/size.
3. If a model is needed, invoke through an admitted model step outside the Store lock. It has no effectful tools and returns a candidate capsule with evidence references.
4. Validate exact constraints, source coverage, open questions, known outcomes and protocol shape. Compare candidate references to the frozen ledger. A generated summary cannot be its own sole verifier.
5. Recheck epochs and expected revisions. Commit the new capsule, receipt and cursor atomically, or discard the stale candidate without replacing valid state.
6. Build the next context from approved instructions, capsule, relevant memory, recent protocol-complete turns and rehydrated sources. Revalidate at actual model dispatch.

Prefer a deterministic capsule for objectives, exact constraints and runtime references, with optional model-generated narrative as a separate field. Do not recursively summarize summaries indefinitely: periodically rebase from original evidence and authoritative state. Record compression lineage and drift checks.

A failed/null/oversized/incomplete candidate leaves the previous valid capsule intact. A bounded fallback can use deterministic extraction or smaller source partitions on the same permitted route; never silently choose a different provider or payer. Budget exhaustion suspends safely. Do not launch a compaction call only after its own input already exceeds the route limit.

Retire or sanitize a retained external-engine session that already contains revoked material before further inference. It is impossible to make a model unsee material merely by removing it from future retrieval. Portable continuity may require a fresh vendor session and a truthful lineage-reset notice.

## 10. Runtime integration

The existing native `prepare` transform remains pure and zero-cost. It can consume a frozen evidence/capsule snapshot prepared by earlier recorded read/model steps. It must not hide database mutation, network retrieval, embeddings, reranking or hosted compaction inside itself.

ModelAdapter.prepare currently cannot change the opaque transcript. Native compaction updates belong in the adapter's explicit admitted session lifecycle and transcript record, never a bypass of validatePrepared. Subsequent validation may refuse stale context but cannot rewrite saved bytes. Add source restriction propagation tests for all newly selected evidence.

Logical operations include search, read, propose, correct, forget and corpus traversal. Actual registered names must conform to the current registry: `memory_search`, `memory_read`, `memory_propose`, `memory_correct`, `memory_forget`, `corpus_open`, `corpus_next`, `evidence_read`. Privileged correction/forgetting require a host-authenticated user intent or a separately authorized policy; a model requesting them is not authorization. Most normal turns should receive a small automatic host-selected evidence set, with tools for deeper access.

Do not misclassify a remote hosted write as pure/local to fit today's effect enum. Managed memory operations require an explicitly reviewed effect/idempotency mapping within H12/RunService. A sink's request identity/receipt is required for retry reconciliation. Deterministic local reads can be cheap without being called zero-cost model inference.

## 11. Model and engine independence

Define independent ports for extraction, embedding, reranking, summarization and final generation. Every port binds to existing route/payer/privacy admission. Never assume a cloud embedding provider is allowed because foreground generation is local. Changing the final-answer model should not require re-embedding; changing embedding space requires a new index version and verified cutover.

Capability records must distinguish native Nectovia model loops, supported subscription engines, MCP transport, portable message delivery, session reset, opaque compaction, token counting, actual usage and cancellation. Test each supported route. Unavailable compaction is a truthful unsupported capability, not evidence that ordinary memory is unavailable.

OpenAI opaque compaction items remain with the exact qualified provider/session semantics; standalone returned context is preserved whole. Anthropic on-demand/threshold modes are different adapter operations with different continuation and usage rules. Aggregate compaction iteration cost when present without double-counting top-level message usage. Record unknown/uncertain provider charges and preserve reservations. The application should never spend promotional credits by assumption.

Tool/result pairing, provider item IDs and required reasoning-related protocol objects stay adapter-owned. Do not extract or manufacture hidden reasoning. Cross-provider handoff carries permitted original evidence and capsule facts, not opaque encrypted state or private upstream credentials.

## 12. Agent Memory Repo and plugins

Pin upstream revision `1db04a5735adbc4f2158308f2077fd960e243c04` as the research reference; builder revalidates exact files before adaptation. Support MEMORY.md, topic Markdown, root-relative wikilinks and optional metadata. Extend with a Nectovia sidecar binding exported record IDs/revisions/digests without claiming upstream defines our schema.

Export a scoped current-state projection by default. Git history and remote synchronization are explicit advanced choices with deletion/retention disclosures. Import interprets notes as untrusted candidates. Outside edits require expected-base reconciliation; never turn Markdown text into verified source metadata, permissions or executable skills.

Reject path escapes, Windows aliases/case collisions where applicable, symlink escapes, oversized trees, archive bombs, submodules, Git hooks, active links and automatic script/query execution. Do not resolve every external URL in a note. A link is not consent to fetch it. Separate user repositories remain separately scoped when combined in a session.

Plugins receive minimal scoped memory tools through the existing pack/plugin capability system, not the database file or unrestricted organization checkout. Loading a plugin is not approval to index its whole data source. Imported executable procedures must use the existing reviewed skill/tool path and current grants.

## 13. Governed Dreaming

Capture changed source watermarks and process dirty scopes only. A maintenance capability uses existing Automations admission, run leases, budgets, pause/stop and device ownership. It does not create a scheduler per plugin. Local-only maintenance runs only on its authorized eligible host; no promise of progress when that machine is asleep or off.

The pipeline is observe → candidate → deterministic validation/source checks → replay/held-out evaluation where procedural → authorized promotion → monitoring/rollback. Low-risk meaning-preserving deduplication can follow a configured standing policy; high-consequence procedural changes go to the existing review path. The proposing model cannot be the sole approver of its own operational policy change.

Maintenance cannot place orders, send messages, change permissions or independently start accepted Board tasks. It may propose a bounded follow-up task through existing rules. Tenant learning never automatically becomes global training data or a public plugin.

Foreground requests take scheduling priority. Default local maintenance concurrency is one within the memory subsystem, and it cooperates with existing model/hardware resource ownership rather than loading a second large model. Batches have explicit event/token/step/wall-time limits, frozen input manifests, retry ceilings and idempotency keys. All values remain configuration with tested upper bounds, not magical overnight-learning promises.

## 14. Corrections, deletion and authorization races

Correcting a memory atomically deactivates its previous operative revision and invalidates dependent retrieval projections. Rebuilding embeddings can happen later; serving a stale revision cannot. Forgetting increments a non-reversible suppression/deletion generation, removes authorized retained content and projections according to lifecycle policy, cancels obsolete queued jobs and prevents replay from resurrecting it.

Derivatives inherit the intersection of source visibility and the union of processing restrictions. Alternative independently sufficient support can justify a separately validated less-restricted derivative; the model must not casually relabel a mixed-source summary. Hidden titles, graph edges, counts, snippets, autocomplete, cached answers and analytics are data too.

Backups, exported clones, previously delivered provider input and other recipients' copies cannot be erased by a local database tombstone. Document the actual controllable lifecycle and retention limits. Recovery applies current revocation/suppression generations before exposing restored material. Existing History protection remains until its deliberate lifecycle rules authorize deletion; forgetting may remove active personalization without falsely claiming all legal/audit records were destroyed.

Stale precomputed contexts cannot dispatch after access epoch changes. Use the existing authoritative gate as the dispatch linearization point. An already-sent request cannot be recalled; request cancellation where supported and prevent further sends or results from leaking to newly unauthorized users. Report the boundary honestly.

## 15. Console, privacy and operations

Ship the inspector early in the existing Console. It shows statement, scope, source, valid period, verification status, conflict, recent uses, edit/forget actions and retention/source controls. A task inspector adds context utilization quality, omitted evidence, capsule revision, coverage status and last verified checkpoint. A graph view is optional browsing, never a substitute for these records.

Full-computer access is not automatic memory-indexing consent. Distinguish selected source ingestion, retention, cloud processing and unattended maintenance. Free local/manual functionality uses existing entitlements; managed autonomous work remains separately admitted. This feature creates no pricing change or bought-credit automation loophole.

Telemetry defaults to metadata: timing, sizes, counts, error classes, epochs and pseudonymous technical IDs. Exclude prompts, memory text, source titles, embeddings, credential values and sensitive screen replay. Use existing PostHog plumbing where enabled; credits do not justify collecting content. AWS can host qualified workers/inference when allowed, but do not add always-on GPU costs or migrate the existing account service for this feature.

Monitor queue lag, recall misses, conflicts, stale suppressions, compaction validation failures, unsupported-citation rate, coverage failures, added model calls and all-in accepted-task cost. Correlate through opaque receipt IDs. A kill switch stops new capture/model maintenance and invalidates projections safely; it does not delete evidence or restore old grants.

## 16. Rollout and acceptance

Twelve work items W00–W11 cover the entire build. The first gate is an offline vertical slice: retain → correct → search → deliver receipt → roll over → resume → forget, using synthetic two-tenant sources and the real native harness seams. Then add exhaustive coverage, route/engine integration, interop, managed operation, semantic retrieval and governed maintenance.

Acceptance requires the 96-case specified matrix plus model evaluation in 05_EVALUATION_PROTOCOL.md, not simply a high test count. Zero observed isolation/authority/forbidden-route failures is a release gate on tested cases, not a mathematical guarantee. Token limits, accuracy, latency and costs must be reported per exact model/profile/task class.

Review each slice independently. Do not collapse source implemented, tested, reviewed, merged, packaged, deployed and customer-qualified into one Done checkbox. An optional accelerator can remain disabled after honest negative evaluation; an unbuilt required ledger/continuity/deletion path cannot be called complete. W11 reports every capability and route's supported/unsupported/unverified state.
