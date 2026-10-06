# Data contracts and interface behavior

**NC-MEM-LC-2026-10-06.1.** Proposed version1 logical contracts. Adapt names through current repository canonical Zod types. The JSON Schema checks shape, not authorization; host validation and source evidence decide authority. Do not use an input object's tenantId as authenticated identity.

## MemoryRecord

Identity/revision/tenant/workspace are host-bound. kind is fact/preference/episode/procedure-candidate. lifecycle is candidate/active/superseded/retracted. epistemic is asserted/source-supported/live-verified/inferred. These dimensions are independent. body is bounded text; sources contain exact origin and locator; validFrom/validTo describe when it applies. source access and processing restrictions remain live references, not caller-editable grants. dependencies enable transitive invalidation. A model-generated proposal cannot set live-verified.

Example: a purchasing manager's statement is asserted even when its message digest is valid. A fresh inventory API observation may support a count at its observation time but does not prove a physical shelf inspection. A procedure candidate does not execute until the existing skill/review/permission path admits it.

## SourceRef

Fields: sourceId, revision (nullable when genuinely unknown), locator, sourceType, contentSha256 (nullable for reference-only evidence), observedAt, accessPolicyRef, restrictionsRef. A locator preserves line/page/region/table/row/cell/tool-turn semantics as a typed host-validated string or an equivalent existing repository contract. Models propose only locators among supplied source IDs; host resolution verifies them against accessible source material.

Reference-only records require clear degraded rehydration behavior if the source disappears. Digest equality does not establish truth. Source revisions alone do not establish current permissions.

## ContinuationCapsule

Fields: taskId, runId, sourceSnapshotId, goal, constraints with exact text and evidence, runtimeStateRefs, memoryRevisionRefs, openQuestions, nextIntentions, coverageRefs, previousRevision and continuationIndex. It is a source-linked projection, not a new task state machine. runtimeStateRefs address current authoritative task/run/effect/approval records. nextIntentions are planning text, not executable effects or grants.

The host pins authoritative fields and validates model narrative separately. Do not request hidden reasoning. Before any new effect, reread the real permission/budget/effect state. A capsule may preserve a statement that was valid historically without making it valid now.

## MemoryUseReceipt

Fields: runId, stepId, sourceSnapshotId, memoryRevisionRefs, sources, accessEpoch, deletionEpoch, compilerVersion, renderedSha256, tokenCountQuality, estimatedTokens, reportedTokens and omissions. Each source must have been authorized and actually supplied. This is what makes provenance inspectable and replay reproducible. An old receipt can remain in the audit record while current rights restrict what a user may open from it.

## CoveragePlan

Fields: taskId, runId, sourceSnapshotId, mode, expectedItems nullable, completedItems, status, partitions and reducerVersion. Partitions have stable ID, source revision, state, result digest and canonical record IDs. source scope is explicit. status complete requires an enumerated denominator/end-of-stream plus all required partitions verified; schema alone cannot enforce that multi-record invariant.

Counts use source-record identity/version rather than passage occurrences. If an API has no consistent snapshot, record observation intervals and reconciliation status rather than claiming snapshot consistency. Every partition result belongs to the same allowed tenant/scope.

## Proposed service ports

| Port | Inputs | Result / invariants |
|---|---|---|
| MemoryStore.commit | authenticated scope, commandId, expected revision, proposed mutation | Atomic revision + outbox event; conflict rather than silent overwrite |
| EvidenceResolver.resolve | authenticated scope, known source IDs/locators, asOf/snapshot | Exact authorized original spans; unverifiable source is explicit |
| MemoryRetrieval.plan | query/objective, scope, budget, declared coverage mode | Eligible candidates/manifest and unknowns; no hidden future gold |
| MemoryRetrieval.read | frozen eligible selection + source epoch | Source-backed evidence and omission reasons |
| ContextController.plan | current model/route limits, task/runtime refs, source snapshot | Bounded retrieval/compaction plan and reserve requirement |
| ContextController.compile | frozen snapshots and validated capsule | Deterministic prepared context + receipt; no network or side effects |
| CapsuleStore.activate | intent, expected prior revision, current epochs, candidate | Validated atomic new capsule or explicit stale/refused outcome |
| CoverageStore.advance | partition identity, expected state, result digest | Idempotent frontier update and duplicate-safe reducer input |
| MaintenanceCapability.run | admitted dirty-set watermark, bounds, model route | Candidates and receipts; promotion only via configured review policy |
| AMRAdapter.export/import | authenticated source scope and explicit destination/base | Scoped projection or untrusted candidates; never new grants |

## Failure classes

Use existing ApiError/HarnessError conventions. Logical cases: memory_not_found_or_forbidden; stale_evidence; source_unavailable; revision_conflict; revoked_epoch; invalid_source_reference; memory_unavailable; context_budget_exceeded; context_capability_unknown; compaction_invalid; compaction_stale; coverage_partial; coverage_snapshot_changed; unsupported_engine_delivery. Do not expose restricted titles/details in an error merely to be helpful.

## Command and cache identity

Bind each mutation to tenant/workspace, authenticated command, source identity/revision, operation and expected revision. The same command with different payload is a conflict, not another attempt. Capture/deletion races compare monotonic epochs at commit. Cached retrieval/context identity includes scope/visibility, access+deletion epochs, source snapshot, compiler, model/tokenizer profile and relevant retrieval/index versions. A low TTL does not replace invalidation.

## Schema evolution

Append an explicit version and migrate from known supported old records using current migration ownership. Reject unknown incompatible versions. Keep historic context receipts readable. Do not fill missing old evidence/usage/identity fields with invented defaults that imply verification. The package's schema is a seed for implementation tests, not a new production authority or complete migration implementation.
