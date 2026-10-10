# Nectovia memory + long-context build package

**Package:** NC-MEM-LC-2026-10-06.1  
**Prepared:** October 6, 2026  
**Direction:** Andrew-approved Nectovia-owned memory service, Agent Memory Repo-compatible import/export, extended to governed context continuity and exhaustive evidence work.  
**Source baseline:** app main `cb2e756257de92a6091659200213cdcb79829700`; refresh before implementation.  
**Status:** implementation-ready research/design/handoff. No product implementation, application tests, live-model evaluation, migration, deployment or release was performed by this authoring session.

## Open the work

[Drive package folder](https://drive.google.com/drive/folders/1EiGGIuCgG6RSv397z8Rq1MQDUDFdLYMv) · [Notion feature and architecture](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204) · [Linear epic DIO-226](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [First slice DIO-227](https://linear.app/diomedesdevs/issue/DIO-227/nc-mem-lc-w00-reconcile-source-and-freeze-memorycontext-contracts).

Begin with [the Opus kickoff](prompts/00_OPUS_KICKOFF.md). It starts current-source reconciliation and actual local implementation, then moves through the gated build. Existing H18/DIO-23 is extended, not duplicated. Twelve new child issues are Backlog; live Linear owns their state. One separate [Bugs investigation DIO-239](https://linear.app/diomedesdevs/issue/DIO-239/investigate-h18-first-sentence-compaction-dropping-later-corrections) is Needs reproduction, not a claimed customer incident.

## What is included

**12 dependency-ordered implementation slices; 25 prompts (kickoff plus 12 implementation/review pairs); 96 specified acceptance cases (48 preserved + 48 new); 24 source records; 5 strict JSON Schema record types with examples; 12 fictional business scenario specifications; a reproducible 512-row smoke fixture and scalable generator.** These counts describe package contents, not passing product tests.

## Reading order

1. [Research findings](01_RESEARCH_FINDINGS.md), then [Architecture specification](02_ARCHITECTURE_SPEC.md).
2. [Current-source reconciliation](07_SOURCE_RECONCILIATION.md) and [Data contracts](10_DATA_CONTRACTS.md).
3. [Implementation plan](03_IMPLEMENTATION_PLAN.md) and machine-readable `work-items.json`; use only the current slice's prompts.
4. [Acceptance matrix](04_ACCEPTANCE_MATRIX.md) and [Evaluation protocol](05_EVALUATION_PROTOCOL.md).
5. [Upstream adoption](06_UPSTREAM_ADOPTION.md), [Operations runbook](08_OPERATIONS_RUNBOOK.md), [Risks and triage](11_RISKS_AND_TRIAGE.md).
6. [Proposed canonical addendum](09_CANONICAL_AMENDMENT.md); existing canonical documents have not been overwritten. DIO-222 remains separate.

[SOURCES.md](SOURCES.md) / `sources.json` record external primary and internal sources. [The original first-pass handoff](archive/NC-MEM-2026-10-06.1.md) is preserved unchanged; this pass qualifies its logical dotted tool names and adds the specific continuation/coverage/controller design. Do not treat dated source observations as refreshed implementation proof.

## Why memory and long context fit together

Durable memory answers what remains useful across sessions. A continuation capsule preserves the current task through window rollover. A coverage plan accounts for all evidence required by an exhaustive task. All use the same source/authorization spine while runtime effects remain in existing Task/Run/Step records. This extends reliable continuity and corpus access; it does not create an unlimited native context window.

## Build order and live issues

| Slice | Outcome | Live record |
|---|---|---|
| W00 | Reconcile source, ownership and baseline; freeze integration contracts | [DIO-227](https://linear.app/diomedesdevs/issue/DIO-227/nc-mem-lc-w00-reconcile-source-and-freeze-memorycontext-contracts) |
| W01 | Implement versioned memory ledger and transactional local persistence | [DIO-228](https://linear.app/diomedesdevs/issue/DIO-228/nc-mem-lc-w01-versioned-memory-ledger-and-transactional-local) |
| W02 | Enforce evidence scope, corrections, forgetting and managed-store isolation | [DIO-229](https://linear.app/diomedesdevs/issue/DIO-229/nc-mem-lc-w02-evidence-scope-corrections-forgetting-and-managed-store) |
| W03 | Deliver exact/text recall and immutable evidence receipts through the harness | [DIO-230](https://linear.app/diomedesdevs/issue/DIO-230/nc-mem-lc-w03-native-recall-tools-and-immutable-memory-use-receipts) |
| W04 | Extend H18 with model-aware budgets, continuation capsules and safe compaction | [DIO-231](https://linear.app/diomedesdevs/issue/DIO-231/nc-mem-lc-w04-h18-continuation-capsules-budgets-and-safe-context) |
| W05 | Implement exhaustive corpus traversal and source-coverage accounting | [DIO-232](https://linear.app/diomedesdevs/issue/DIO-232/nc-mem-lc-w05-exhaustive-corpus-coverage-and-duplicate-safe) |
| W06 | Qualify model/engine continuity adapters, caching and complete compaction metering | [DIO-233](https://linear.app/diomedesdevs/issue/DIO-233/nc-mem-lc-w06-engine-adapters-context-caching-and-complete-compaction) |
| W07 | Implement Agent Memory Repo round trips and scoped plugin access | [DIO-234](https://linear.app/diomedesdevs/issue/DIO-234/nc-mem-lc-w07-agent-memory-repo-interoperability-and-scoped-plugin) |
| W08 | Add governed observational capture and bounded Dreaming maintenance | [DIO-235](https://linear.app/diomedesdevs/issue/DIO-235/nc-mem-lc-w08-governed-capture-and-bounded-dreaming-maintenance) |
| W09 | Add temporal relationships and optional hybrid retrieval behind evaluation gates | [DIO-236](https://linear.app/diomedesdevs/issue/DIO-236/nc-mem-lc-w09-temporal-relationships-and-measured-hybrid-retrieval) |
| W10 | Complete Console controls, shared-service operations and opt-in rollout | [DIO-237](https://linear.app/diomedesdevs/issue/DIO-237/nc-mem-lc-w10-console-memory-controls-observability-and-rollout) |
| W11 | Run complete acceptance, comparative evaluation and platform release qualification | [DIO-238](https://linear.app/diomedesdevs/issue/DIO-238/nc-mem-lc-w11-full-memorycontext-evaluation-and-release-qualification) |

## Validate this package

From this extracted directory:

```sh
python tools/validate_package.py --root .
python tools/validate_package.py --root . --schemas
```

The first command uses Python's standard library. `--schemas` additionally requires the `jsonschema` package in the chosen environment and fails clearly if missing. It does not install dependencies. The validator checks counts, reference integrity, dependency cycles, fixture arithmetic/hashes and manifest integrity. It does not run Nectovia or any model.

To create a fresh larger synthetic fixture in an empty owned directory:

```sh
python tools/generate_long_horizon_fixtures.py --out ./local-fixture-4096 --rows 4096 --seed 42
```

Only authorized `agent/` inputs go to the evaluated agent/indexer. `evaluator/` contains gold answers and perturbation labels and must remain evaluator-only. Even agent input has deliberately separate tenant-scoped objects; the harness must filter them before disclosure. Generated data is fictional.

## Acceptance and authority

A working first vertical slice is not the whole feature. Source merge, local tests, independent review, live model quality, installed-device qualification and production deployment are independent gates. No repeated summary becomes independent corroboration; no memory becomes a grant. Preserve native/billing/tenant/source restrictions, cancellation, idempotency and evidence. No paid or customer-data test is authorized merely by this package.

`publication.json` records real destination and tracking IDs. `SHA256SUMS.txt` covers all package payload files except itself and the validation report; the externally published `UPLOAD_RECEIPT.json` records final archive upload verification without a self-referential ZIP hash. `package-validation.json` contains package-only check results.
