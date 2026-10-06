# W06 implementation — Qualify model/engine continuity adapters, caching and complete compaction metering

<mission>
Implement W06 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W06 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W04.
Inspect these existing seams: server/harness/model-transcripts.ts, server/harness/model-api-adapter.ts, server/harness/aws-model-adapter.ts, server/harness/claude-session-run.ts, server/harness/codex-session-run.ts, server/managed-usage.ts.
</read_first>

<deliverables>
1. Define capability support for portable memory delivery, native opaque compaction, token counting, reset, cancellation and actual usage. Unsupported and unverified are distinct.
2. Implement provider-specific optional compaction only where the exact route supports it. Preserve full standalone output where required; never send opaque state to another provider.
3. Account all compaction/extraction/rerank/embedding iterations without double-counting top-level totals, preserve uncertain charges, and use the existing reserve/settle authority.
4. Scope context caches by tenant/visibility/epochs/snapshot/serializer/provider model. Keep stable instructions separate from dynamic evidence. Test cache on/off behavior rather than assuming prompt reuse.
5. Deliver permitted portable evidence to supported external engines through actual interfaces; test session retirement and rebuild on access reduction, model switch or incompatible update.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: Use synthetic provider envelopes with top-level usage excluding compaction iterations, null compaction content, opaque items and stale sessions. Reject missing accounting and invalid continuation.
Proposed files: shared/route-capabilities.ts, server/harness: existing provider adapters, server/memory/engine-port.ts, tests/context-adapter-conformance.test.ts, tests/context-compaction-usage.test.ts.
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run context-adapter-conformance.test.ts, context-compaction-usage.test.ts, context-cache-invalidation.test.ts; implement the relevant matrix assertions M20, L12, L13, L14, L15, L16. W11 must verify them independently. Gate: Contract fixtures pass for each supported adapter; real provider/installed-engine tests are separately budgeted and reported, never inferred from mocked responses.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
No new paid API calls or credential copying by default. Do not change account routing or privacy floors. Use official current docs and capture their date/version in the adapter evidence.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-233](https://linear.app/diomedesdevs/issue/DIO-233/nc-mem-lc-w06-engine-adapters-context-caching-and-complete-compaction) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
