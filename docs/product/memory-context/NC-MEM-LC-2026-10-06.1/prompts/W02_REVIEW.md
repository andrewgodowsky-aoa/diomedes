# Independent review — W02

Review the candidate for **Enforce evidence scope, corrections, forgetting and managed-store isolation** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites W01 and inspect server/trust/, server/discovery/service.ts, server/workspaces.ts, server/connection-secrets.ts, services/control-plane, server/harness/policy.ts.

Required behavior:
- Bind principals, organization/location/project scope, source rights and processing policy on the server. Enforce before retrieval, reranking, compaction, prompt assembly and response delivery.
- Add source revision/locator validation and original-span recovery; distinguish asserted/source-supported/live-verified/inferred evidence. Models never set tenant, epoch, approval or verification authority.
- Implement correction/retraction/tombstone commands, synchronous active-record and cache invalidation, transitive derivative invalidation and queue suppression. Minimal non-content tombstones stop resurrection.
- Implement managed PostgreSQL persistence within existing control-plane identity and funding boundaries, with restricted-role tests, composite tenant references and transaction semantics. Allocate the migration number from current source; apply only to disposable databases in this lane.
- Define explicit retention modes and purge/export/backup limitations. Recheck current generations on restore, owner transfer and retained-session use. Preserve deliberate History lifecycle constraints.

Read and challenge the tests: memory-privacy.test.ts, memory-forgetting.test.ts, memory-managed-store.test.ts. Verify matrix coverage M02, M07, M17, M18, M19, M21, M22, M23, M24, M33, M34, M43, M44, M46, L11. Check the specific counterexample: Inject forbidden vector candidates, revoked source dependencies, stale queued capture and a restored older database; assert no content or metadata escapes and deleted content cannot reactivate.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-229](https://linear.app/diomedesdevs/issue/DIO-229/nc-mem-lc-w02-evidence-scope-corrections-forgetting-and-managed-store) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
