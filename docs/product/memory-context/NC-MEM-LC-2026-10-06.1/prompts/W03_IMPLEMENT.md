# W03 implementation — Deliver exact/text recall and immutable evidence receipts through the harness

<mission>
Implement W03 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W03 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W02.
Inspect these existing seams: server/harness/tools.ts, server/harness/run-service.ts, server/harness/instruction-delivery.ts, server/harness/model-session-run.ts.
</read_first>

<deliverables>
1. Implement exact IDs and full-text retrieval first, with deterministic ordering, bounded source snippets, quoted exact clauses and explicit misses/conflicts.
2. Register memory_search/memory_read and restricted mutation tools using existing H12 schemas/effect classes. Do not put dots in registered names or classify a remote write as pure to evade current effect rules.
3. Make ordinary native turns host-recall eligible; models can request more through tools. Keep retrieval/network/extraction in separate recorded admitted steps before deterministic prepare.
4. Add a frozen MemoryUseReceipt and versioned H18 sections for memory/capsule/coverage. Preserve source restrictions and opaque transcript identity through validatePrepared.
5. Expose source lookup and citation validation. Claims citing nonexistent/not-delivered IDs fail; historical replay retains exact old context bytes but rechecks present authority.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: A new session misses a saved scoped preference on baseline; the new path must recall it with source/revision receipt. Also fail fabricated citations and stale-epoch replay.
Proposed files: server/memory/retrieval.ts, server/memory/tools.ts, server/memory/receipts.ts, shared/context-accounting.ts, server/harness/context-assembly.ts, server/harness/native-agent.ts, tests/memory-recall.test.ts, tests/memory-context-receipts.test.ts.
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run memory-recall.test.ts, memory-context-receipts.test.ts, memory-tool-contracts.test.ts; implement the relevant matrix assertions M01, M10, M11, M16, M37, M39, M40, L27, L28, L29. W11 must verify them independently. Gate: One real native model-API path with scripted adapter proves retain/correct/recall/receipt/forget behavior without any hidden network call inside prepare.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
Pure preparation is not a free place to call an LLM, database mutation or remote search. Keep existing read-scope limitations explicit.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-230](https://linear.app/diomedesdevs/issue/DIO-230/nc-mem-lc-w03-native-recall-tools-and-immutable-memory-use-receipts) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
