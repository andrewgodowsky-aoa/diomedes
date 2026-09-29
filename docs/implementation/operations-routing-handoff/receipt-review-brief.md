# Bounded independent review: conversation routing evidence

Review only. The user requested independent review of this feature. Use the
current workspace, F:/Diomedes/diomedes-wt/operations-routing. Read files and
Git objects only. Do not edit, install, run tests or type checks, start servers,
touch databases or credentials, call providers, commit, push, message other
chats, or delegate. An exclusive verification slot is held by another task.

This feature adds Operations-controlled, scoped provider routing. Previous
reviews already covered the gateway and funding. Review the new conversation
receipt projection and deferred source-history repairs for concrete, reachable
scope, attribution, compatibility or privacy defects. Do not repeat the broad
gateway review or propose unrelated hardening.

Read these authored inputs:

- server/harness/routing-receipts.ts
- client/console/ManagedRoutingReceipt.tsx
- shared/routing-policy.ts (receipt contracts and source-rule merge)
- tests/operations-routing-harness.test.ts
- docs/implementation/operations-routing-handoff/conversation-receipts.patch
- docs/implementation/operations-routing-handoff/harness-repairs.patch
- docs/implementation/operations-routing-handoff/harness.patch

The app source checkpoint is 07dc5ba8efa230cbfe583b119c49e2eb9bf4cc61, but
the listed reader/tests/view and repair artifacts are newer uncommitted work.
The deferred files remain at the old feature base until dependency composition.
For their actual target source, use git show
b4a1e92f74fe0938d8c7a43ba36b8f1cd1636957:<path> for:

- shared/harness.ts
- server/harness/native-agent.ts
- server/harness/policy.ts
- server/harness/model-api-adapter.ts
- server/harness/run-service.ts
- server/harness/model-session-run.ts
- server/harness/conversation-history.ts
- server/harness/model-context.ts (or the actual selectHistory module)
- client/console/ThreadView.tsx

The full dependency will be composed, the original harness.patch applied, and
the regression file run RED before harness-repairs.patch is applied. The
current tool-step receipt display bug, dropped direct-model source rules,
missing wrapper capability flag, missing durable failure receipt, successful
receipt validation and structured source error mapping are intentionally
unrepaired in executable source before that RED. Do not report those as new
findings when the repair artifact already addresses them.

Check whether the combined artifacts would fix those defects correctly. In
particular, reconcile history contributors/compaction with the real driver,
writing-helper ancestry, tenant/project/command scope in receipt projection,
cursor behavior while new turns arrive, and any path that accepts tool content
as trusted billing evidence. Check compatibility with real historical records.

Return only actionable findings, each with severity, exact source/patch lines,
a concrete reachable counterexample and a narrow suggested repair, followed by
remaining evidence limits. State explicitly if no new defect is found. Do not
claim runtime, provider or acceptance proof; no checks are authorized here.
