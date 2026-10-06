# Risks, investigations and implementation boundaries

Package NC-MEM-LC-2026-10-06.1. October 6, 2026. All product acceptance remains open.

## Tracked investigation

[https://linear.app/diomedesdevs/issue/DIO-239/investigate-h18-first-sentence-compaction-dropping-later-corrections](https://linear.app/diomedesdevs/issue/DIO-239/investigate-h18-first-sentence-compaction-dropping-later-corrections) is DIO-239 in the existing Bugs project, Backlog / Needs reproduction, no asserted severity or priority. At app main cb2e756257de92a6091659200213cdcb79829700, compactTurns retains first-sentence extracts and references to original messages. A later sentence can contain the correction that changes the meaning of the first. Source reading establishes that loss from the extract, not an installed-app or live-model failure. W00 exercises actual functions and the downstream recovery; W04 addresses a confirmed gap. Close as intended behavior only with rationale while preserving the new no-loss-of-critical-constraints acceptance requirement. Relevant M14/L01/L03.

## Design risks and required controls

| Risk | Required control | Primary slices |
|---|---|---|
| Hallucination retained as fact; summary echo | Source lineage, explicit epistemic class, independent origins, no source-sha-as-truth | W01–W03, W08 |
| Cross-tenant or department disclosure | Host-bound scope, derivative restriction intersection, filtered search and metadata, kept-session invalidation | W02–W03, W06 |
| Compaction loses corrections or exceptions | Exact critical constraint pins, original-source retrieval, schema/semantic validation, safe rollback | W04 |
| Top-k misses records in all-record work | Complete manifest/frontier and stable partition identity; honest partial status | W05 |
| Duplicate or uncertain effect after rollover | Existing effect ledger and destination reconciliation; capsule is not execution authority | W04–W06 |
| Hidden inference in pure context prepare | Recorded read/model steps and frozen compiler input; all-in reservation/settlement | W03–W06 |
| Incorrect provider compaction usage | Aggregate documented extra iterations without double-counting; preserve uncertain charges | W06 |
| Forgetting undone by queues/backups | Monotonic deletion epochs, suppress stale queued promotion, restore revalidation | W02, W08, W10 |
| Memory import executes code or leaks Git history | Untrusted candidates, path/size/active-content limits, filtered snapshot export, no automatic Git hooks/remotes | W07 |
| Embedding changes corrupt relevance | Versioned isolated indexes, shadow rebuild and evaluation before atomic cutover | W09 |
| Local resource exhaustion or hidden cloud fallback | Bounded batches, yield to foreground, same data/payer policy across every model operation | W06, W08–W10 |
| False long-context marketing | Task-qualified evidence and full failure/cost reporting; no infinite native-window or inherited leaderboard claim | W11 |
| Documentation race or parallel implementation | W00 current-source/claim refresh, DIO-23/H18 ownership, preserve DIO-222 reconciliation | W00 throughout |

## Decisions the builder must qualify, not guess

The exact local transactional database driver must work in the supported Electron/Node build and platform packaging. This package selects a storage interface and transactional semantics; W00 qualifies the driver before an authorized dependency change. A managed migration number belongs to the current migration owner, not this dated package.

The actual model route must prove advertised window, tool protocol, native compaction, token accounting, provider retention and external-engine injection. A provider documentation example does not prove every Bedrock/Vertex/OpenRouter/subscription wrapper supports it. An unknown capability is not supported by default.

Compaction thresholds, retrieval token ceilings and proposed quality margins are versioned trial settings in the spec/protocol, not unconditional performance facts or new customer-plan terms. They may be refined through evaluation without loosening hard source/authority rules. No user pricing change, new data-training entitlement or retention/legal policy is silently created here.

## Publication versus execution

The user approved approach 3 and requested this complete setup. Documentation and tracking writes are performed in this session; code execution is delegated through the initial prompt. Repo commit/push/merge/deployment and live spending require actual current authorization. Test tools in this package are offline authoring aids; their passing does not close any M/L product acceptance case.
