# Board workflows

Branch: `feature/board-workflows`.
Worktree: `F:/Diomedes/diomedes-wt/board-workflows`.
Owner: Codex integrator, coordinated with the conversation-driver merge chat.
Initial base: `dd43c358fd29140a2429692bf80cbbfd0bef351d` (Board PR #170).
Composed prerequisite: `05ef1b066908221c1cdae0c2e1924a00719f5ccf` (PR #171).
Merged base: `af0fbec122e49f04895ea85137e5be0fc500685a` (PR #171).
The composed and merged bases have the identical tree
`c04e468c4752b2f88698cf1e74936ebc03898a1e`.
Scope: O44 continuation, Inbox, child tasks, source links and managed Board Work.

Andrew authorized implementation and merge on 2026-09-27. His continuation
decision is Full approval or Stop on phase change. Continuation controls when
the task moves between Plan, Build and Review. It does not grant file access,
service consent, a paid Agent entitlement or more spending capacity.

## Implementation

- Agent proposals wait in Inbox. Acceptance is a person action. Work, native
  loop admission, manual status changes and automatic start enforce that gate.
  A task explicitly accepted from a conversation proposal remains accepted.
- A task can opt into a native workflow with a revision-checked continuation
  choice and 1-16 action turns, plus one planning call. Legacy tasks keep their
  previous execution path until configured.
- Stop on phase change uses the existing exact Need and harness step approval
  records. Approving resumes the same run, with its recorded model calls and
  budget. Full approval crosses the two phase boundaries without another phase
  decision. File-write approvals remain governed by the existing Trust rules.
- A parent can create four separate-output children, at most two levels deep.
  Deleting a child does not replenish that limit.
  Children inherit continuation and turn ceilings, receive no copied grants,
  and start in Inbox. The native `propose_task` tool creates them under a
  receipt for the exact tool attempt; replay does not create another task.
- The source conversation and message are captured when a conversation makes
  a task. The inspector opens that source, without inventing links for older
  tasks. Board updates continue through the existing event stream.
- Nectovia Board Start uses the native single-agent loop. Its signed-in
  business, published model and task-thread tier are resolved by the host.
  Every model call re-admits under the original job and cap. Managed loops
  refuse teams, delegates and conflicting model or account selections.
- Explicit native workflows on supported provider routes use the same loop;
  unsupported external harnesses refuse rather than ignoring phase limits.
  Existing task profiles remain available for the legacy external-work path.
  Team wakes and direct Build/Fix requests cannot bypass a bound task's Inbox
  or workflow controls; configured tasks start through the Board loop.
- A task can select a playbook from an enabled project pack. Work pins its
  version, digest and exact instruction text through the existing contribution
  loader. Build and Fix accept the same guidance. This follows Andrew's later
  clarification that skills should not be restricted to Ask and Plan.
- The engine menu refreshes its current catalogue when opened. The related
  engine-discovery work remains in the coordinated conversation-driver branch.

Manual board access is separate from Agent execution. Free harness access or
a provider connection does not grant the paid Agent. Paid admission still
runs before live model work. Local scripted fixtures are verification only.

## Verification ledger

Application and test sources match validated tree
`439fa9ebf9b657f96dc9f620a3f2dce2ce687b5a`. They stayed unchanged through the final
gates. Later edits only update this evidence record and the macOS build heap
setting described below; generated browser screenshots are retained in ignored
local evidence.

| Check | Final result | Local log |
| --- | --- | --- |
| Seven repaired regression suites | 132 passed, 0 failed, 0 skipped | `evidence/board-final-focused.log` |
| Phase approval fixture correction | 10 passed, 0 failed, 0 skipped | `evidence/board-phase-fixture-focused.log` |
| Full root Vitest, four workers | 491 files passed; 8,241 tests passed, 0 failed, 4 skipped | `evidence/board-phase-fixture-full.log` |
| TypeScript and Vite build | Passed | `evidence/board-phase-fixture-build.log` |
| Required UI, native UI, Field, Board and workflow browser suites | 46 passed, 0 failed, 0 skipped | `evidence/board-phase-fixture-browser.log` |

The first combined root run found stale route/tool/limit assertions, one wrong
product name, a missing-task consent fixture and a scoped-work timeout. The
assertions, name and fixture were repaired. The unchanged scoped-work suite
passed both focused and full runs with reduced worker contention. Historical
failure logs remain in local evidence and are not counted as passing gates.

The first macOS and Windows CI runs on `44eb78e` found one test-fixture clock dependency:
the identity replay assertion created two distinct Needs one millisecond apart.
Their expiry and proposal digest correctly differed. The fixture now replays
the same recorded Need, and the changed-phase check preserves the timestamp to
isolate the phase change. Application code did not change. The focused approval
suite, full local suite, build and browser gates above all passed after this
correction. GitHub checks
and the accepted head remain recorded on PR #172.

On corrected head `7edb20c`, macOS completed the full suite with 8,224 passed,
21 platform skips and zero failed tests. Its earlier build step exhausted Node's
automatic roughly 2 GB heap during root type checking. The macOS build step now
sets a 4 GB heap explicitly; test-worker memory settings and application code
are unchanged. Workflow YAML parsing passed. Local Node v22.23.2 already reports
the same 4,144 MiB total V8 heap limit with and without the explicit 4,096 MiB
old-space setting, so the passing local builds used the same ceiling. The
hosted build must pass on the updated head before merging.

Independent review through OpenCode Go Muse Spark 1.3 (model-default effort,
read-only, no fallback) found and then confirmed repairs for the team-wake
workflow bypass and deleted-child restore limits. The final repair review
reported no remaining blocking findings. The integrator owns runtime checks.
The minor child-button note was also resolved by sharing the backend's lifetime
count and depth blocker with the panel.
The separate fixture review (`ses_f1a792765ffeksD0sp16ma5uG1`, same model and
read-only scope) confirmed that the correction preserves the positive and
negative assertions, with no blocking findings.

The Board decision sections were synchronized into the cloud Roadmap and
Project Memory through revision-checked native document edits. Readback verified
the inserted text, unchanged tab topology and SHA-256 equality of all preexisting
document text. The newer NC-IF, pricing and self-configuring amendments remain
intact. Their wider implementation is outside this Board slice.

No provider, desktop package, deployment or device claim follows from mocked
transport and local browser tests. The conversation-driver chat owns the
separate live native/AWS evidence and prerequisite PR. No release is requested.

## Merge record

Integration branch: `feature/board-workflows`, targeting `main` after the required
GitHub checks. The pull request's merge event records the exact accepted main
revision; the cloud checkpoint and coordination journal receive that revision
after merging. Existing package prompt completion records are unchanged; this
work does not close a broader roadmap prompt by implication.
