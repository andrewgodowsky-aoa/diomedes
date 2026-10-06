# W05 implementation — Implement exhaustive corpus traversal and source-coverage accounting

<mission>
Implement W05 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W05 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W03, W04.
Inspect these existing seams: server/harness/tools.ts, server/harness/native-loop.ts, server/task-workflow.ts, server/outcome-evidence/.
</read_first>

<deliverables>
1. Implement point/contextual/document/exhaustive retrieval modes with host-validated coverage requirements. Explicit all/every/reconcile cannot silently degrade to top-k.
2. Create source snapshot manifests, stable partition IDs, expected counts when known, cursors, visited frontiers and result digests. Unknown source cardinality stays partial until enumerated.
3. Preserve row/header/units and clause/exception relationships across chunk boundaries. Keep exact row identity separate from overlapping passage context.
4. Implement bounded deterministic reducers and duplicate-safe partition results. Reconcile mid-scan source changes and restart from the saved frontier without duplicate effects.
5. Connect coverage checks to existing outcome verification and capsule references; final prose cannot override an incomplete manifest.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: A 512-row fixture has crucial records outside the top results and duplicate overlap. The expected exact total must fail a top-k or naive overlapping reducer; resume and source-change variants must also fail unsafely implemented versions.
Proposed files: shared/coverage.ts, server/memory/coverage.ts, server/memory/partitioning.ts, server/memory/reducers.ts, tests/context-coverage.test.ts, tests/context-aggregation.test.ts.
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run context-coverage.test.ts, context-aggregation.test.ts, context-source-snapshot.test.ts; implement the relevant matrix assertions L19, L20, L21, L22, L23, L24, L25, L26. W11 must verify them independently. Gate: Exact totals match independent deterministic gold, every counted record has an eligible unique source ID, and partial sources never show complete.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
No generic unrestricted Python/SQL executor. Use existing mediated tools and sandbox contracts; source APIs without snapshot guarantees must disclose observation intervals.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-232](https://linear.app/diomedesdevs/issue/DIO-232/nc-mem-lc-w05-exhaustive-corpus-coverage-and-duplicate-safe) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
