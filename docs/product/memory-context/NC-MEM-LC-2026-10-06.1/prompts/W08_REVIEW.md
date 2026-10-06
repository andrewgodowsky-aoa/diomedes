# Independent review — W08

Review the candidate for **Add governed observational capture and bounded Dreaming maintenance** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites W02, W03, W04 and inspect server/guidance.ts, server/task-skills.ts, server/automation-scheduler.ts, server/automations.ts, server/harness/run-service.ts, server/rehearsal/.

Required behavior:
- Add opt-in incremental observation extraction with source watermarks, idempotent queue entries, qualified route selection and bounded repair.
- Implement dirty-scope consolidation as an existing Runtime/Automations capability, not a second scheduler. Check host ownership, current unattended authority, entitlement and budgets each run.
- Propose deduplication, temporal conflict links and private procedural improvements. Ground all candidates in original evidence; repeated generated summaries never add independent support.
- Promote meaning-preserving changes under an explicitly configured standing policy; route procedural changes to existing guidance/skill review, replay, monitoring and rollback.
- Yield to foreground work, cap batches and local concurrency, stop/resume safely, and block deletion resurrection after late extraction responses.

Read and challenge the tests: memory-maintenance.test.ts, memory-promotion.test.ts, memory-maintenance-scheduler.test.ts. Verify matrix coverage M12, M13, M15, M31, M32, M36, M47, L32, L33, L34. Check the specific counterexample: A correction/forget arrives while consolidation is in flight; a model proposes permission expansion and a summary cites itself. All must be refused without corrupting the last valid state.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-235](https://linear.app/diomedesdevs/issue/DIO-235/nc-mem-lc-w08-governed-capture-and-bounded-dreaming-maintenance) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
