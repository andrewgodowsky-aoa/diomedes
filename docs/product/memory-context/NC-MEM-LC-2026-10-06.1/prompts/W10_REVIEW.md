# Independent review — W10

Review the candidate for **Complete Console controls, shared-service operations and opt-in rollout** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites W02, W03, W04, W05, W06, W07, W08 and inspect client/console/, server/workspace-routes.ts, server/observability/, server/organization-export.ts, server/support-bundle.ts.

Required behavior:
- Ship memory/source/period/conflict inspector and edit/forget/export controls in the one Console. Show unknown, partial, stale, unverified and permission-denied states honestly.
- Add task context budget/omission/capsule/coverage/receipt views, with readable scope and actor attribution. Do not resurrect a retired History UI as an unapproved parallel surface.
- Implement source-retention/egress and unattended-maintenance controls distinct from full-computer file permissions. Preserve Free/Individual/Business boundaries and existing billing decisions.
- Integrate managed API identity, rate/size quotas, current permissions, offline cache limitations, backup/restore, purge and offboarding with existing control plane.
- Instrument metadata-only analytics, redact support bundles, mask sensitive replay, provide kill switches and bounded opt-in rollout/recovery runbooks.

Read and challenge the tests: memory-console.spec.ts, memory-routes.test.ts, memory-observability.test.ts, memory-offboarding.test.ts. Verify matrix coverage M48, L43, L44, L45. Check the specific counterexample: Drive UI/API fixtures with hidden source titles, revoked access, unavailable indexes, failed export and queued forget. The UI must not imply saved/complete/verified states without records.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-237](https://linear.app/diomedesdevs/issue/DIO-237/nc-mem-lc-w10-console-memory-controls-observability-and-rollout) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
