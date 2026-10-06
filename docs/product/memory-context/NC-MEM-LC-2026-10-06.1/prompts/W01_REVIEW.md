# Independent review — W01

Review the candidate for **Implement versioned memory ledger and transactional local persistence** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites W00 and inspect server/store.ts, server/harness/run-store.ts, server/migrations/registry.ts, server/lock.ts.

Required behavior:
- Implement strict record/revision/source/dependency entities with expected-revision writes, immutable source links, lifecycle and epistemic status separated.
- Provide a production local storage adapter with transaction tests, bounded file/database growth policies and safe schema upgrades. Store scope and tenant keys on every primary/foreign key path. Do not migrate existing run records.
- Add tenant-scoped entity aliases and explicit conflict records. Temporal valid and recorded intervals preserve historical questions and future-effective policies.
- Implement stable command identity and an outbox/event projection for memory changes, with crash recovery and deterministic read snapshots. No global Store lock spans a model or network call.
- Add backup/readability checks and migration round trips. Rollback must not roll back revocation generations.

Read and challenge the tests: memory-ledger.test.ts, memory-store-recovery.test.ts, memory-contracts.test.ts. Verify matrix coverage M03, M04, M05, M06, M08, M09, M28, M29, M30, M41, M42. Check the specific counterexample: Show cross-tenant IDs, stale expected revisions and interrupted transactions fail without the ledger protections; then implement only the transaction boundary needed to make them pass.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-228](https://linear.app/diomedesdevs/issue/DIO-228/nc-mem-lc-w01-versioned-memory-ledger-and-transactional-local) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
