# H01 preview repair after final independent rejection

Date: 2026-09-17. Author: parent Codex task, directly requested by Andrew.
Worktree: `diomedes-wt/codex-h01-repair-20260917`.
Base: `b115b3c657ec05f7222f0785bba75653df08f425`.
This is an uncommitted implementation candidate. H01 acceptance requires a fresh
independent verdict on its frozen bytes. No successor work is released here.

The frozen fifty-file SWE candidate was reconstructed from patch SHA-256
`8a0fa2d1b843f1f8ef0dcbe0898a70e0d52e60f82f8a8d56d375b939255cd09c`.
The original worktree, handoff and review evidence remain unchanged. Four new
independent probe files were imported byte-for-byte from the final review overlay.
The separately accepted Files UI patch is outside this repair.

## Findings and changes

| Final review finding | Repair | Regression boundary |
|---|---|---|
| P1: old-owner previews still reached the Console after takeover | RunService checks current owner, live lease, fence, running step and attempt inside its existing queue immediately before synchronous publication. Takeover/recovery abort obsolete controllers; a live renewal retains the controller and fence. | Unchanged independent Node and real Console takeover probes; new expiry, recovery, renewal and settlement cases. |
| P2: app events lost sequence and Console appended duplicates | App preserves sequence and attempt identity. Console accepts contiguous frames for one attempt, ignores duplicates/older frames, and discards previews on gaps, changed identity or a lost SSE connection. It re-reads state without another provider request. | Real Store/SSE and built Console cases, including reconnect and final durable answer after reload. |
| P2: ordinary Codex falsely advertised run-record durability | Direct Codex reports host-record, matching Ask's saved conversation Turn; the distinct codex-report route remains run-driven. Conformance refuses an unsupported external-session run-record claim. | Descriptor/conformance regression plus direct Ask source inspection. |
| Stale prerequisite and test provenance claims | Current local B00/C00 acceptance is cited; historical C00.R-3 remains intact. The earlier SWE-adapted review suite is correctly attributed. | Complete detached inventory and current shared integration records. |

Publication does not write token events or create another authority. EngineService
drains its ordered preview publications before the dispatch step can settle;
retained callbacks cannot emit after settlement. Ownership loss preserves the
existing DISPATCH_UNCERTAIN outcome instead of claiming user cancellation.

The presenter cursor is ephemeral. It grants no permission and cannot resume or
replay a provider. A gap invalidates the preview for the rest of that request;
the durable answer arrives through the existing recorded turn/state path.

## Reproduction and verification

Before production edits, the original independent stale-owner Node case failed.
New Node probes also failed for lease expiry and recovery; valid renewal passed.
The original two failing browser probes and seven new browser cases reproduced
the source defects. Initial ambiguous test locators were corrected before the
seven browser failures were used as behavioral evidence; raw logs are preserved.

Current command logs, actual exit codes, final counts and exact file hashes belong
in `F:/Diomedes/deliverables/codex-h01-repair-20260917/`. This document does not
replace that detached evidence or an independent acceptance record.

Andrew's Opus test-slot reservation was honored. Tests started only after its
recorded release and this task's own acquisition through the pinned coordination
tool. No live-provider call, credential access, packaging, install, commit, merge,
push, deployment or spending is part of this repair.

B00 and local C00 are accepted at the base according to the shared coordination
root's `results/integration-final-20260917.json` and
`results/C00.R-rollout-20260917.json`. The old C00.R-3 rejection is historical.
H01 remains subject to its own independent exact-candidate review.
