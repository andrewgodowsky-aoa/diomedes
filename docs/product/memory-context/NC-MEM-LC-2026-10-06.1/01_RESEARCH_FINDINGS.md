# Research pass 2: memory, long context and sustained task performance

Package: **NC-MEM-LC-2026-10-06.1**. Research date: **October 6, 2026**.
Status: research-grounded engineering proposal and execution handoff, not a model benchmark result or deployed feature.

## Finding

Yes: the approved Nectovia-owned memory architecture can support effective long-context work. The right design is a shared evidence substrate with **different mechanisms for long-term knowledge, active task continuity, and large-corpus analysis**. A memory graph alone does not make a model attend to every relevant detail, and a large advertised context window does not establish reliable long-horizon execution.

Distinguish four quantities in product and engineering reports:

1. **Native window:** the model/route's supported input-and-output envelope, with its actual tokenizer, protocol and modality limits.
2. **Qualified working window:** the context sizes and task classes shown to work acceptably on the exact model, quantization, route and harness profile. This is empirical and may be below the native window.
3. **Accessible evidence corpus:** the authorized original documents/events the application can retrieve or scan. It can be much larger than any one prompt.
4. **Task horizon:** the amount of work and number of context rollovers that can be completed while preserving goals, constraints, evidence, permissions and effect state.

These are not interchangeable. A successful query over a 100-million-token indexed corpus is not a 100-million-token native prompt, nor evidence that all parts were considered. Our proposed feature improves the third and fourth and intelligently uses the first two.

## Evidence and design consequences

### Portable memory is a format, not the entire runtime

Cognition's release combines a short MEMORY.md, linked topic notes and a proposed periodic consolidation process. The local reference skill is invocation-driven: it does not install automatic startup or scheduled Dreaming. It treats memory as data and makes remote synchronization explicit. The repository's MIT license is permissive subject to notice obligations. [S01–S04]

**Decision:** retain Approach 3. Nectovia owns factual provenance, access, transactions, retrieval and maintenance; Agent Memory Repo is a compatibility projection. No external format is allowed to mint trusted tenant IDs, source verification, permissions or successful task outcomes. No upstream code is copied into this package.

### Context management needs more than a longer prompt

Anthropic describes just-in-time retrieval, compaction, structured notes and focused subagents as complementary approaches. It explicitly warns that aggressive compaction can lose subtle details. Its long-running-harness work emphasizes incremental progress and durable artifacts between sessions. [S05, S06]

**Consequence:** add a versioned continuation capsule, keep exact constraints and pending-effect references outside lossy prose, and retain raw evidence for rehydration. Do not copy a vendor-specific initializer/worker runtime; use Nectovia's existing Task, RunService and handoff paths. Compaction is an optimization, never a new source of business truth.

### Synthetic long-context tests are useful but insufficient

RULER tests more than one easy needle: configurable sequence lengths and task complexities include multi-hop and aggregation. Its own limitations caution that synthetic tasks do not replace realistic work. Lost in the Middle motivates testing evidence at different positions rather than assuming a source is used merely because it was included. These historical findings do not certify current models or their rankings. [S07, S08]

**Consequence:** evaluate exact-model context profiles using position, distractor, cross-document dependency and aggregation sweeps, then test real-shaped Nectovia work. Never market a model's advertised window as Nectovia's demonstrated reasoning capacity.

### Long-term memory must remember change, not just old answers

LongMemEval includes extraction, multi-session reasoning, temporal reasoning, knowledge updates and abstention. Its official repository publishes evaluation and dataset preparation guidance. Public gold evidence/session IDs are evaluator data, not ingestion hints. [S09, S10]

**Consequence:** index chronologically without seeing the future question or answer. Keep updates, negations, supersession and uncertainty as explicit test categories. Include unanswerable questions in end-to-end results even when an upstream retrieval-only metric excludes them.

### Newer agent-memory evaluation is a better fit for this product

LongMemEval-V2's official repository describes 451 curated questions over web/enterprise agent trajectories. Its five abilities include dynamic state, workflow knowledge, local gotchas and premise awareness. The largest history contains up to 115 million tokens, retrieved from a corpus rather than presented as one model window. Its August 2026 update makes this materially newer than the original chat-memory benchmark. [S11]

**Consequence:** use V2 as an optional external evaluation track, after a small synthetic smoke suite. Add Nectovia-specific tasks where a workflow that works at one company is wrong at another. Do not download its largest datasets or run expensive reader/judge models as part of default CI.

### Observation logs are useful, but not authoritative

Mastra's observational-memory work separates an observer that records useful observations from a reflector that compresses them. This is a useful alternative to repeatedly searching raw transcripts, but its published performance belongs to its own evaluation setup. [S12]

**Consequence:** trial incremental, source-linked observations within Nectovia. Preserve input watermarks, raw source pointers and deleted-source suppression so asynchronous capture cannot forget an update or resurrect removed information. Do not add a second framework just to obtain this pattern. Measure the lag and all capture/reflection costs.

### Very large inputs can be processed as an environment

Recursive Language Models explores treating long inputs as an external environment that the model inspects and decomposes, sometimes with recursive subcalls. That is a test-time orchestration pattern, not an increase to a base model's native window. [S13]

**Consequence:** build bounded corpus traversal through existing registered tools and sandboxed delegation. Do not give an untrusted memory system a new unrestricted REPL. For exhaustive totals and comparisons, use a source manifest, a durable coverage frontier and deterministic reducers; top-k search is not enough.

### Native provider compaction is useful but must remain optional

OpenAI documents encrypted opaque compaction state and different handling for server-side chaining versus standalone compact output. The standalone output must be preserved as a whole rather than reduced to the opaque item. This state is provider-specific, not our portable memory record. [S14]

Anthropic currently documents on-demand and threshold compaction, with different request/protocol behavior. Its threshold documentation separates compaction-iteration usage from top-level usage, and warns about a null summary failure case with tools. Capability and usage semantics must be checked on the precise API route, not inferred from the model's name. [S15, S16]

**Consequence:** use adapter capability records for compaction, separately admit and meter any hosted operation, validate the result and preserve the original recoverable state on failure. Do not assume a Bedrock, OpenRouter, Vertex or subscription-engine wrapper exposes the same feature. Never send an opaque compaction token to a different provider. Model switching reconstructs context from portable permitted evidence and records the lineage transition.

## What the new source pass found in Nectovia

Current inspected main: **cb2e756257de92a6091659200213cdcb79829700**. This replaces the first-pass snapshot for files rechecked below. No product tests were run in this research session.

| Source | Fresh observed behavior | Required integration consequence |
|---|---|---|
| server/harness/context-assembly.ts | Existing history logic uses recency/lexical selection and bounded first-sentence extracts. Blob unchanged from first pass. | Add an evidence/capsule lane; keep old records readable; do not promote extracts as verified facts. |
| shared/context-accounting.ts | Estimated, reported and declared numbers are distinct; utf8-bytes/4 estimator; no memory/capsule/coverage sections yet. | Version the schema additively; preserve unknowns; tokenize/count complete serialized requests for admission when qualified. |
| server/harness/native-agent.ts | prepare is recorded as pure, cost 0; validates scope, tools, source restrictions and unchanged opaque transcript. | Retrieve/compact in separately admitted steps. Deterministic prepare consumes a frozen snapshot. Do not change opaque state inside prepare. |
| native-agent.ts validatePrepared | JSON.stringify length has a 262144-unit guard. | Audit all route byte/token/serialization caps. This guard is not a provider window; do not simply remove it to advertise long context. |
| server/harness/tools.ts | Registry names match ^[a-z][a-z0-9_-]{0,63}$. | Actual tool names use memory_search and memory_read, not the dotted logical names from pass 1. |
| Linear DIO-23 | H18 is already In Progress with H11/H13/H09 dependencies; full acceptance open. | Coordinate with existing work; this package extends it, does not create a replacement H18. |

The original handoff's remaining source observations remain dated evidence, not fresh reinspection of every file. W00 must reconcile them, active PRs/worktrees, recent hooks/plugin changes, the full current source and any unseen local work. DIO-222 remains the owner of broader canonical-doc divergence.

## Recommended experiments, not benchmark claims

Compare: current H18; native long-context without new memory where it genuinely fits; Agent Memory Repo-style notes; exact/text memory; exact/text plus continuation capsule; hybrid graph/semantic retrieval; and the same system with governed consolidation. Use the same reader models, permissions, source chronology and admitted task budget. Report total preprocessing, maintenance, retrieval, compaction and generation costs, not only the final answer call.

A small local model may benefit from a good evidence set and stable state, but it may still fail tasks requiring sophisticated synthesis. Escalation is permitted only through an existing qualified route and explicit data/payer policy. There is no assumption that memory makes a small model equivalent to a large one.

## Build conclusion

Build governed memory and the H18 continuity controller together, but stage rollout. The first integrated proof is an explicit user correction that survives a new session and repeated context rollover, remains attributable to the original source, and does not trigger a duplicate effect. The full build then adds exhaustive coverage, hosted/shared operation, portable formats, native-engine integrations, evaluated semantic retrieval and bounded Dreaming.

Read 02_ARCHITECTURE_SPEC.md for binding proposal contracts, 03_IMPLEMENTATION_PLAN.md for all twelve work packages, and 05_EVALUATION_PROTOCOL.md for how a successful result must be measured.
