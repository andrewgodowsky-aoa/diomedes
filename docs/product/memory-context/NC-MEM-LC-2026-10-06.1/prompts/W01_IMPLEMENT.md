# W01 implementation — Implement versioned memory ledger and transactional local persistence

<mission>
Implement W01 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W01 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W00.
Inspect these existing seams: server/store.ts, server/harness/run-store.ts, server/migrations/registry.ts, server/lock.ts.
</read_first>

<deliverables>
1. Implement strict record/revision/source/dependency entities with expected-revision writes, immutable source links, lifecycle and epistemic status separated.
2. Provide a production local storage adapter with transaction tests, bounded file/database growth policies and safe schema upgrades. Store scope and tenant keys on every primary/foreign key path. Do not migrate existing run records.
3. Add tenant-scoped entity aliases and explicit conflict records. Temporal valid and recorded intervals preserve historical questions and future-effective policies.
4. Implement stable command identity and an outbox/event projection for memory changes, with crash recovery and deterministic read snapshots. No global Store lock spans a model or network call.
5. Add backup/readability checks and migration round trips. Rollback must not roll back revocation generations.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: Show cross-tenant IDs, stale expected revisions and interrupted transactions fail without the ledger protections; then implement only the transaction boundary needed to make them pass.
Proposed files: shared/memory.ts, server/memory/store.ts, server/memory/local-store.ts, server/memory/service.ts, tests/memory-ledger.test.ts, tests/memory-store-recovery.test.ts.
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run memory-ledger.test.ts, memory-store-recovery.test.ts, memory-contracts.test.ts; implement the relevant matrix assertions M03, M04, M05, M06, M08, M09, M28, M29, M30, M41, M42. W11 must verify them independently. Gate: Records survive close/reopen and injected crash points; duplicate commands do not duplicate revisions; no partially visible transaction.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
Use isolated local test profiles and disposable stores only. Do not touch the active user profile or silently select an incompatible native dependency.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-228](https://linear.app/diomedesdevs/issue/DIO-228/nc-mem-lc-w01-versioned-memory-ledger-and-transactional-local) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
