# W10 implementation — Complete Console controls, shared-service operations and opt-in rollout

<mission>
Implement W10 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W10 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W02, W03, W04, W05, W06, W07, W08.
Inspect these existing seams: client/console/, server/workspace-routes.ts, server/observability/, server/organization-export.ts, server/support-bundle.ts.
</read_first>

<deliverables>
1. Ship memory/source/period/conflict inspector and edit/forget/export controls in the one Console. Show unknown, partial, stale, unverified and permission-denied states honestly.
2. Add task context budget/omission/capsule/coverage/receipt views, with readable scope and actor attribution. Do not resurrect a retired History UI as an unapproved parallel surface.
3. Implement source-retention/egress and unattended-maintenance controls distinct from full-computer file permissions. Preserve Free/Individual/Business boundaries and existing billing decisions.
4. Integrate managed API identity, rate/size quotas, current permissions, offline cache limitations, backup/restore, purge and offboarding with existing control plane.
5. Instrument metadata-only analytics, redact support bundles, mask sensitive replay, provide kill switches and bounded opt-in rollout/recovery runbooks.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: Drive UI/API fixtures with hidden source titles, revoked access, unavailable indexes, failed export and queued forget. The UI must not imply saved/complete/verified states without records.
Proposed files: client/console: existing inspector/settings surfaces after ownership mapping, server/memory/routes.ts, services/control-plane: memory API integration, tests/memory-console.spec.ts, docs/product/memory-context/operations.md.
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run memory-console.spec.ts, memory-routes.test.ts, memory-observability.test.ts, memory-offboarding.test.ts; implement the relevant matrix assertions M48, L43, L44, L45. W11 must verify them independently. Gate: Browser and route tests prove core user controls and no content leakage in logs/replay/export; hosted and physical-device qualification remain explicitly separate.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
No production rollout or broader sharing. Add no pricing gates or automatic full-disk ingestion. Existing appearance and Console contracts govern design.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-237](https://linear.app/diomedesdevs/issue/DIO-237/nc-mem-lc-w10-console-memory-controls-observability-and-rollout) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
