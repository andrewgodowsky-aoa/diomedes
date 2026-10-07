# DIO-271 app voice implementation

Feature: voice-audit-copy
Prompt: DIO-271, with confirmed engine copy findings feeding DIO-272
Branch: feature/voice-audit-copy
Worktree: F:/Diomedes/diomedes-wt/voice-audit-copy
Owner: Andrew Godowsky
Implementer: native Codex parent plus disjoint console and server workers
Base: bae249b60ffafa3934d775c6d59fbac80990a83e, fetched origin/main

Andrew's current request reopens the report-only audit for implementation. Every edited quote is checked in current source before a rewrite.

Voice authority: docs/reference/VOICE.md for app copy, plus F:/Diomedes/planning/Roadmap and prompts/Nectovia_Site_Copy_Rewrite_2026-09-28/reference/VOICE.md, including the 2026-10-07 Claude-isms amendment, and AMENDMENT-01_job-first.md. Both guides were read in current source. Defined app terms retain their documented meaning. Current candidate Pillars, Roadmap and Project Memory: 2026-10-06.1.

Why: remove repeated reassurance, assistant waiting speech, mechanism-first explanations, cute loading text and unnecessary jargon. State the action or outcome once. Keep information people cannot infer, including uncertain requests, partial effects, payer and permission boundaries.

Scope: unclaimed reader-facing copy in the app client, console, server and shared layer. Preserve active source/test claims. Runtime ids, storage, tool contracts, actual model attribution, policies, prices, tiers and model-facing prompts retain their meaning. Separate ledgers record exact changed text and reasons.

Delegation authorization: Andrew explicitly permits subagents. Native Codex tool inventory is the availability check. Long-horizon workers inherit the parent model and effort through the Codex harness; no outside provider or fallback is used. Root reconciles diffs and gates. The coordination role fable denotes the integrator seat, not the model.

Required validation: TypeScript, Vitest, Vite and browser gates on the combined candidate, serialized under the shared test slot. Do not package or replace an installed app. GitHub Actions remains stopped under F:/Diomedes/CI-STOP.md.

Completion boundary: this is an implementation pass, not audit-wide acceptance. Claimed findings remain pending their owners. DIO-271/DIO-272 are not marked Done by these edits alone.

Final local validation: TypeScript and Vite passed; full root Vitest 10285 passed, 0 failed, 5 skipped; required ui/native-ui/field Playwright 36 passed, 0 failed, 0 skipped, 0 unrun. The separate control-plane typecheck passed and six focused offline suites passed 187 tests with 0 failures or skips. The implementation report records exact snapshots, failure history, three protected assertion handoff hunks and source exclusions. The owner's passing-checkpoint instruction authorizes a commit and pushed review branch; this does not mark the audit complete.
