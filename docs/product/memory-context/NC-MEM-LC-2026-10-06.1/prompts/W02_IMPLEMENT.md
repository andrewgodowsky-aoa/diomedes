# W02 implementation — Enforce evidence scope, corrections, forgetting and managed-store isolation

<mission>
Implement W02 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W02 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W01.
Inspect these existing seams: server/trust/, server/discovery/service.ts, server/workspaces.ts, server/connection-secrets.ts, services/control-plane, server/harness/policy.ts.
</read_first>

<deliverables>
1. Bind principals, organization/location/project scope, source rights and processing policy on the server. Enforce before retrieval, reranking, compaction, prompt assembly and response delivery.
2. Add source revision/locator validation and original-span recovery; distinguish asserted/source-supported/live-verified/inferred evidence. Models never set tenant, epoch, approval or verification authority.
3. Implement correction/retraction/tombstone commands, synchronous active-record and cache invalidation, transitive derivative invalidation and queue suppression. Minimal non-content tombstones stop resurrection.
4. Implement managed PostgreSQL persistence within existing control-plane identity and funding boundaries, with restricted-role tests, composite tenant references and transaction semantics. Allocate the migration number from current source; apply only to disposable databases in this lane.
5. Define explicit retention modes and purge/export/backup limitations. Recheck current generations on restore, owner transfer and retained-session use. Preserve deliberate History lifecycle constraints.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: Inject forbidden vector candidates, revoked source dependencies, stale queued capture and a restored older database; assert no content or metadata escapes and deleted content cannot reactivate.
Proposed files: server/memory/evidence.ts, server/memory/access.ts, server/memory/invalidation.ts, server/memory/managed-store.ts, services/control-plane: proposed memory repository/routes after owner mapping, tests/memory-privacy.test.ts, tests/memory-forgetting.test.ts.
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run memory-privacy.test.ts, memory-forgetting.test.ts, memory-managed-store.test.ts; implement the relevant matrix assertions M02, M07, M17, M18, M19, M21, M22, M23, M24, M33, M34, M43, M44, M46, L11. W11 must verify them independently. Gate: Isolated local and disposable managed-store tests prove the same conformance suite, including restricted runtime roles; live deployment remains separate.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
No live migration or data deletion. Do not equate database row security alone with proof of tenant isolation.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-229](https://linear.app/diomedesdevs/issue/DIO-229/nc-mem-lc-w02-evidence-scope-corrections-forgetting-and-managed-store) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
