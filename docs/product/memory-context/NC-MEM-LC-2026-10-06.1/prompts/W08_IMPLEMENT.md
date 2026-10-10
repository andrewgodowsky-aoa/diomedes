# W08 implementation — Add governed observational capture and bounded Dreaming maintenance

<mission>
Implement W08 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W08 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W02, W03, W04.
Inspect these existing seams: server/guidance.ts, server/task-skills.ts, server/automation-scheduler.ts, server/automations.ts, server/harness/run-service.ts, server/rehearsal/.
</read_first>

<deliverables>
1. Add opt-in incremental observation extraction with source watermarks, idempotent queue entries, qualified route selection and bounded repair.
2. Implement dirty-scope consolidation as an existing Runtime/Automations capability, not a second scheduler. Check host ownership, current unattended authority, entitlement and budgets each run.
3. Propose deduplication, temporal conflict links and private procedural improvements. Ground all candidates in original evidence; repeated generated summaries never add independent support.
4. Promote meaning-preserving changes under an explicitly configured standing policy; route procedural changes to existing guidance/skill review, replay, monitoring and rollback.
5. Yield to foreground work, cap batches and local concurrency, stop/resume safely, and block deletion resurrection after late extraction responses.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: A correction/forget arrives while consolidation is in flight; a model proposes permission expansion and a summary cites itself. All must be refused without corrupting the last valid state.
Proposed files: server/memory/capture.ts, server/memory/consolidation.ts, server/harness/capabilities/memory-maintenance.ts, tests/memory-maintenance.test.ts, tests/memory-promotion.test.ts.
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run memory-maintenance.test.ts, memory-promotion.test.ts, memory-maintenance-scheduler.test.ts; implement the relevant matrix assertions M12, M13, M15, M31, M32, M36, M47, L32, L33, L34. W11 must verify them independently. Gate: Dirty-set runs are repeatable, bounded and attributable; scheduling or a positive model judgment never promotes an operational permission.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
The current scheduler is single-host. Do not claim maintenance occurs while the host is off or fund automated work through a personal bought-credit exception.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-235](https://linear.app/diomedesdevs/issue/DIO-235/nc-mem-lc-w08-governed-capture-and-bounded-dreaming-maintenance) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
