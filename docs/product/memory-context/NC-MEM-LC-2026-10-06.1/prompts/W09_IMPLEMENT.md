# W09 implementation — Add temporal relationships and optional hybrid retrieval behind evaluation gates

<mission>
Implement W09 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W09 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W03, W05.
Inspect these existing seams: server/harness: ModelAdapter/route interfaces, server/evaluation/, server/harness/evaluation-adapter.ts.
</read_first>

<deliverables>
1. Implement tenant-scoped entity/edge relations with explicit support/contradiction/supersession/dependency semantics. Access checks apply before traversal and visible graph statistics.
2. Add replaceable embedding and reranking providers through existing allowed routes. Store embedding model/version/dimension/index generation and source epochs.
3. Implement bounded keyword/vector union, reranking and limited relationship expansion with deterministic tie-breaking, quotas and original-source recovery.
4. Provide rebuild/cutover and rollback of indexes without changing canonical records or final-answer model requirements. Exact/text retrieval remains a working fallback.
5. Run approved paired ablations; enable hybrid only for qualified task profiles with measured benefit. A negative result disables the accelerator, not basic memory.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: Inject wrong-dimension vectors, revoked graph neighbors, repeated self-support and unavailable embedding service; prove safe behavior without cross-tenant or silent cloud fallback.
Proposed files: server/memory/graph.ts, server/memory/embeddings.ts, server/memory/reranking.ts, tests/memory-hybrid.test.ts, tests/memory-index-migration.test.ts.
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run memory-hybrid.test.ts, memory-index-migration.test.ts, memory-graph-isolation.test.ts; implement the relevant matrix assertions M35, L35, L36, L37. W11 must verify them independently. Gate: Deterministic conformance and migration tests pass; real-model benefit/cost evidence is separately recorded before choosing a default.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
Do not add a dedicated graph database or new model service merely to meet the feature name. Local generation must not hide cloud embeddings.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-236](https://linear.app/diomedesdevs/issue/DIO-236/nc-mem-lc-w09-temporal-relationships-and-measured-hybrid-retrieval) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
