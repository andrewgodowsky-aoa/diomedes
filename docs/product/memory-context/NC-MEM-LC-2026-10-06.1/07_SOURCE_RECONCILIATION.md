# Source reconciliation and module ownership map

**Fresh inspected main:** cb2e756257de92a6091659200213cdcb79829700. Four code seams were re-read through GitHub. Wider code observations in archive/NC-MEM-2026-10-06.1.md are a prior snapshot, not a fresh whole-repository audit. Existing active issues and worktrees must be resolved by W00.

## Existing source to extend

| Existing path | Ownership/consequence | Proposed addition |
|---|---|---|
| server/harness/context-assembly.ts | H18 history/sections/prefix/omission logic | Separate memory/capsule sections and deterministic context compiler |
| shared/context-accounting.ts | H18 immutable estimated/reported/declared evidence | Versioned new sections and actual/estimated modality accounting |
| server/harness/native-agent.ts | prepare pure/cost0; transcript/tools/scope restrictions checked | Recorded retrieval/compaction steps before preparation; immutable snapshot consumption |
| server/harness/native-loop.ts | Existing plan/act/observe/delegate/finish | Safe checkpoint/rollover integration, no replacement loop |
| server/harness/tools.ts | Trusted registry, strict names and effect semantics | Underscore-named tools; explicit reviewed remote-write effect mapping |
| server/harness/run-service.ts | Policy, hooks, lease, budgets and durable steps | Memory/compaction capabilities using existing lifecycle |
| server/harness/run-store.ts and server/store.ts | Existing evidence and recorded file authority | Reference original evidence; new memory storage behind a port |
| server/discovery/service.ts | Existing provenance/correction/stale evidence pattern | Generalize appropriate contracts, not prospect-specific authority |
| server/guidance.ts and server/task-skills.ts | Reviewed versioned instructions and skills | Candidate learning promotion and pinned procedural reuse |
| server/automation-scheduler.ts and server/automations.ts | Existing single-host admission/scheduling | Bounded memory-maintenance capability, not another scheduler |
| server/harness/model-transcripts.ts and provider/engine adapters | Actual private session state | Native compaction and reset compatibility tests |
| services/control-plane | Existing cloud accounts, identity, permissions and funding | Scoped managed memory API/store after module/migration ownership mapping |
| client/console | One user surface and existing inspectors | Memory, source, capsule and coverage details in existing visual system |
| server/evaluation and existing H20 adapter | Evaluation evidence | New task/metric adapters, not a disconnected benchmark harness |

Proposed new modules: shared/memory.ts, shared/continuation.ts, shared/coverage.ts; server/memory/{service,store,local-store,managed-store,evidence,access,invalidation,retrieval,receipts,tools,coverage,partitioning,reducers,capture,consolidation,graph,embeddings,reranking,engine-port,routes}.ts; server/memory/interop/{agent-memory-repo,import-policy}.ts; server/harness/{context-controller,context-budget,continuation,context-compaction}.ts; server/harness/capabilities/memory-maintenance.ts. These are proposed logical boundaries, not proof the files exist or a requirement for every concept to become a separate class.

## Concrete findings requiring builder attention

1. **Registry names:** current regex excludes dots. Correct the first handoff's conceptual memory.search examples to actual `memory_search` registration; do not widen the global regex unnecessarily.
2. **Hidden inference:** native context preparation is a durable pure transform with cost0. Embeddings/reranking/summarization/remote counting must be separately admitted and metered. Do not make a pure transform network-dependent.
3. **Protocol/private transcript:** validatePrepared protects the original transcript. Provider compaction belongs in an explicit adapter/session operation with its own evidence.
4. **Independent request limits:** validatePrepared currently limits JSON.stringify length to262144; H18 estimates utf8-bytes/4. These are different measurements and neither alone proves the native window. Keep them distinct in tests and any proposed guarded refactor.
5. **Extractive summary risk:** firstSentence can omit a correction in a later sentence. File a source-grounded reproduction investigation; do not label a live customer hallucination proven without running the actual path.
6. **Documentation drift:** the three canonical documents and repository mirrors may differ. DIO-222 retains that work. Use the focused amendment file without overwriting historical bodies or claiming global sync.

## Exact inspected source anchors

- context-assembly.ts lines1–155, blob3fbf31e7aee4dce5ef10c06550fc8375e211cb49.
- shared/context-accounting.ts lines1–165, blob472c4ac7b94d9d7902ee488246ed14ecb7fd81e4.
- native-agent.ts lines1–135 and220–345, blob532665fe2e3d9f100770db037e55cc8cfa74aa6b.
- tools.ts lines87–121, blobe686c885f7ab94d0ffdb20d31df14fb479da1c1d.

The GitHub URLs and scope of each read are in sources.json. No source code was modified or executed by this research.
