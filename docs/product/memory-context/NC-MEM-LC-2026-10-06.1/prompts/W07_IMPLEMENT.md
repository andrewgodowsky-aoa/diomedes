# W07 implementation — Implement Agent Memory Repo round trips and scoped plugin access

<mission>
Implement W07 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W07 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W03.
Inspect these existing seams: server/pack-contributions.ts, server/pack-lifecycle.ts, server/paths.ts, server/harness/tools.ts.
</read_first>

<deliverables>
1. Pin and verify upstream spec/skill/license. Implement required entry point, topic notes, wikilinks and optional metadata without copying its runtime assumptions.
2. Export authorized current-state projections with stable Nectovia sidecar IDs/revisions/digests. No organization-wide dump or hidden historical Git export by default.
3. Treat imports and outside edits as source-attributed candidates with expected-base conflicts. Do not trust imported policy/tenant/verification fields.
4. Limit import count/bytes/depth, resolve platform paths safely, and refuse symlink traversal, hook/submodule execution, active URLs and query/script execution.
5. Expose least-privilege memory capabilities to the existing plugin system. Installing a pack neither enables source retention nor grants account-wide memory access.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: Round-trip a two-scope fixture and edit an export after a concurrent correction. Reject stale mutation and malicious wikilinks/Windows alias escapes.
Proposed files: server/memory/interop/agent-memory-repo.ts, server/memory/interop/import-policy.ts, tests/memory-interop.test.ts, tests/memory-hostile-import.test.ts, docs/product/memory-context/upstream-adoption.md.
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run memory-interop.test.ts, memory-hostile-import.test.ts, memory-plugin-scope.test.ts; implement the relevant matrix assertions M25, M26, M27, L30, L31. W11 must verify them independently. Gate: Interop preserves supported meaning and provenance with explicit unsupported fields; unsafe inputs execute nothing and no hidden source is exported.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
No private remote is created or pushed automatically. Preserve MIT notices for any actual copied upstream material and record exact revisions.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-234](https://linear.app/diomedesdevs/issue/DIO-234/nc-mem-lc-w07-agent-memory-repo-interoperability-and-scoped-plugin) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
