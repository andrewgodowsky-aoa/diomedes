# DIO-271 server and shared copy ledger

Base: `bae249b60ffafa3934d775c6d59fbac80990a83e`. Candidate: uncommitted `F:/Diomedes/diomedes-wt/voice-audit-copy`, source frozen on 2026-10-07. The owner's implementation request supersedes the audit's report-only instruction.

Reason for changing: VOICE.md sections 5 and 6 call for contractions, one statement of a fact, direct errors and actions, and removal of unnecessary reassurance tails and assistant waiting prose. The app surface keeps technical precision when a person needs it. AMENDMENT-01 does not authorize changing product capability, price, authority or release evidence. The canonical product documents read for this pass are version `2026-10-06.1`.

Voice source: `F:/Diomedes/planning/Roadmap and prompts/Nectovia_Site_Copy_Rewrite_2026-09-28/reference/VOICE.md`, with the 2026-10-07 section 6 addition; `AMENDMENT-01_job-first.md` in the same folder. Audit source: `F:/Diomedes/deliverables/voice-audit-20261007/parts/app-server-others.md`.

This lane changes literal presentation text only. It preserves uncertain paid outcomes, accepted-request identity, absent effect evidence, original file versions, external edits, actual account/payer identity, scope, sending consent and approval provenance. It leaves shipped model instructions, protocol ids, machine data, financial values, historical stored attribution and live claimed paths intact. It does not introduce a text filter.

Exact change accounting: 364 reviewed edits, 390 source occurrences, 81 production files. 93 existing assertion edits, 96 occurrences, 55 test files. This includes 90 fragments authored in this lane and three formerly held expectations applied by the integrator under `claim_muxqx43p_0a6a590d`. Every old and final production fragment was matched against baseline/current source. Source locations below name baseline and frozen candidate lines.

Validation performed: all 81 changed production files parse without TypeScript syntax diagnostics; masking string/template text gives identical AST structure to HEAD, including unchanged interpolation expressions. Focused `git diff --check` returns 0, with only repository CRLF conversion warnings. These are source checks, not typechecking, tests, build, browser, provider, package or acceptance evidence. This lane ran no test suites. The integrator owns gate execution and acceptance.

The audit reconciliation covers 421 logged server/shared/control-plane lines and 460 source references, including compound references and the inventory wildcard. It checks the cited source windows rather than assuming every auditor judgment is a break. Eight auditor excerpts are shortened, templated, normalized or split in source and are marked as context reads rather than literal quote matches. Do not interpret a file-level copy change as closing every finding in that file.

Audit dispositions: 123 changed; 36 changed / retained; 37 blocked; 196 retained; 0 of the ten specific remaining candidates; 29 parent-owned. All nine initially held integration groups were reverified and resolved in the bounded reopened pass; one compound finding keeps the other adapters' necessary access explanation. 'Changed / retained' means some cited text changed while a quoted fragment or necessary boundary remains. The ten specific source candidates identified during the first freeze are now resolved. Parent-owned findings require the integrator's combined reconciliation.

The ten previously remaining source candidates were reverified and changed: allowance cards, status-only usage wording, expired engine asks, caller cancellation, scheduled jobs, sample-task failure and recovery, Ready receipts, discovery details and attention categories. Retained and blocked audit dispositions remain explicitly recorded below. This does not claim that every audited workspace or original coverage gap is resolved.

The three expectations in [server-tests.patch](../handoffs/server-tests.patch) are now applied: two in `tests/codex-session.test.ts` and one in `tests/aws-conversation-authority.review-20260921.test.ts`. The integrator recorded exited owner PIDs, no matching helpers, clean preserved worktrees and commits before releasing PR169-R8 (`claim_mukzterw_7f7875bf`) and security-hardening-interaction-fixtures (`claim_mudp0bbf_e0df6718`) through the pinned tool. Fresh status confirms those claims are absent and `claim_muxqx43p_0a6a590d` covers only the two expectation files. The patch remains a historical handoff record and must not be applied again. The paired resume/checkpoint, interrupted request, zero-provider-send, delivery and approval checks remain unchanged. This test handoff implements no additional production copy.

Our exact claims remain held for the integrator to release after reconciliation:

- `claim_muxpd50e_b21aad84`, DIO-271.SERVER, 19 paths.
- `claim_muxpgs6h_4fc52431`, DIO-271.SERVER, 19 paths.
- `claim_muxpmfq9_5e82a32d`, DIO-271.SERVER.TESTS, 15 paths.
- `claim_muxpoco6_2cfaaa8f`, DIO-271.SERVER.TESTS, 2 paths.
- `claim_muxpt60i_7605d508`, DIO-271.SERVER.RECONCILE, 14 paths.
- `claim_muxpwd9z_d7841e6c`, DIO-271.SERVER.RECONCILE, 28 paths.
- `claim_muxpzwcr_733bd114`, DIO-271.SERVER.TESTS, 5 paths.
- `claim_muxq0oa9_c8874c6b`, DIO-271.SERVER.TESTS, 1 path.
- `claim_muxq2q4w_128eded6`, DIO-271.SERVER.RECONCILE, 1 path.
- `claim_muxqarbi_b07caa65`, DIO-271.SERVER.REMAINDER, 2 paths.
- `claim_muxqdf8v_ea80af30`, DIO-271.SERVER.TESTS, 3 paths.
- `claim_muxqophd_0ca6fb4c`, DIO-271.SERVER.TESTS, 6 paths.
- `claim_muxqrcrn_f302ddfe`, DIO-271.SERVER.TESTS, 13 paths.
- `claim_muxqsk01_4dab81f2`, DIO-271.SERVER.TESTS, 7 paths.
- `claim_muxr68ei_2efcb59b`, DIO-271.SERVER.INTEGRATIONS, 1 path.
- `claim_muxuc9h4_8187367b`, DIO-271.SERVER.INTEGRATIONS.TESTS, 2 paths.

## Exact production changes

### server/accounts/agent-gate.ts

S001. Source: `server/accounts/agent-gate.ts:44` at base; candidate lines 44. 1 occurrence.

Now:

```text
This project is not linked to one business. An owner or administrator must link it before the Nectovia Agent can work here. Nothing was sent.
```

New:

```text
This project isn't linked to one business. An owner or administrator must link it before the Nectovia Agent can work here.
```

Reason: VOICE 5 and 6: use a contraction and keep the required linking action without the tail.

S002. Source: `server/accounts/agent-gate.ts:47` at base; candidate lines 47. 1 occurrence.

Now:

```text
${FEATURE_LABELS[MANAGED_INFERENCE]} isn't part of this business's plan, so the Nectovia Agent can't answer here. Nothing was sent.
```

New:

```text
${FEATURE_LABELS[MANAGED_INFERENCE]} isn't part of this business's plan, so the Nectovia Agent can't answer here.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

### server/app-updates.ts

S003. Source: `server/app-updates.ts:135,138,140` at base; candidate lines 135,138,140. 3 occurrences.

Now:

```text
The installer resolved to an untrusted location. Nothing was saved.
```

New:

```text
The installer download address failed the safety check.
```

Reason: VOICE 6 and 7: name the failed download address check and cut the redundant tail.

S004. Source: `server/app-updates.ts:252` at base; candidate lines 252. 1 occurrence.

Now:

```text
The installer redirected too many times. Nothing was saved.
```

New:

```text
The installer download redirected too many times.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S005. Source: `server/app-updates.ts:255,260` at base; candidate lines 255,260. 2 occurrences.

Now:

```text
The installer redirect was invalid. Nothing was saved.
```

New:

```text
The installer download redirected to an invalid address.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S006. Source: `server/app-updates.ts:279,298,314,323,685` at base; candidate lines 279,298,314,323,685. 5 occurrences.

Now:

```text
The installer size does not match the release record. Nothing was saved.
```

New:

```text
The installer size doesn't match the release record. Download it again.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S007. Source: `server/app-updates.ts:693` at base; candidate lines 693. 1 occurrence.

Now:

```text
The installer digest does not match the published digest. Nothing was saved.
```

New:

```text
The installer doesn't match the published release. Download it again.
```

Reason: VOICE 6 and 7: keep the integrity failure and recovery action without checksum jargon or a tail.

S008. Source: `server/app-updates.ts:819` at base; candidate lines 819. 1 occurrence.

Now:

```text
The staged installer has no trusted expected digest. Nothing was launched.
```

New:

```text
The downloaded installer couldn't be verified. Download it again.
```

Reason: VOICE 5 to 7: name the failed verification and the recovery action.

S009. Source: `server/app-updates.ts:828,839,845,856,862` at base; candidate lines 828,839,845,856,862. 5 occurrences.

Now:

```text
The staged installer changed after verification. Nothing was launched.
```

New:

```text
The downloaded installer changed after verification. Download it again.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S010. Source: `server/app-updates.ts:195` at base; candidate lines 195. 1 occurrence.

Now:

```text
Diomedes could not reach the release channel. Check the connection and try again.
```

New:

```text
Nectovia couldn't check for updates. Check your connection and try again.
```

Reason: VOICE 5 and 7: current product name, contraction and direct action.

### server/harness/present.ts

S011. Source: `server/harness/present.ts:43` at base; candidate lines 43. 1 occurrence.

Now:

```text
Waiting to start.
```

New:

```text
Queued to start.
```

Reason: VOICE 6: describe the queue state directly.

S012. Source: `server/harness/present.ts:60` at base; candidate lines 60. 1 occurrence.

Now:

```text
Waiting for your OK: ${describeIntent(waitingStep)}.
```

New:

```text
Approve ${describeIntent(waitingStep)} to continue.
```

Reason: VOICE 6: replace assistant waiting voice with the required action.

S013. Source: `server/harness/present.ts:67` at base; candidate lines 67. 1 occurrence.

Now:

```text
Waiting for something outside Diomedes.
```

New:

```text
Paused for an external response.
```

Reason: VOICE 6: describe the actual external wait and remove the old product name.

S014. Source: `server/harness/present.ts:76` at base; candidate lines 76,125. 1 occurrence.

Now:

```text
Something may have happened outside Diomedes that it could not confirm. Check before starting again; nothing will be repeated on its own.
```

New:

```text
An external action has an unconfirmed result. Check what happened before starting again.
```

Reason: VOICE 6: preserve uncertain external effects and the check-before-retry warning in direct language.

S015. Source: `server/harness/present.ts:98` at base; candidate lines 98. 1 occurrence.

Now:

```text
Waiting for data: a file it reads is missing, so nothing was written.
```

New:

```text
A required file is missing. Add it before starting again.
```

Reason: VOICE 6: name the missing input and next action.

S016. Source: `server/harness/present.ts:99` at base; candidate lines 99. 1 occurrence.

Now:

```text
Stopped because something went wrong. Nothing will be repeated on its own.
```

New:

```text
The job failed. Check its error before starting again.
```

Reason: VOICE 6: direct failure and action instead of vague failure plus reassurance.

S017. Source: `server/harness/present.ts:125` at base; candidate lines 125. 1 occurrence.

Now:

```text
Stopped. One action may have happened outside Diomedes that it could not confirm. Check before starting again.
```

New:

```text
Stopped. An external action has an unconfirmed result. Check what happened before starting again.
```

Reason: VOICE 6: preserve uncertainty and check-before-retry warning without a vague stand-in.

S018. Source: `server/harness/present.ts:170` at base; candidate lines 170. 1 occurrence.

Now:

```text
A rule held this before it ran: ${held.reason} Nothing happens until you say go ahead, and your OK covers exactly this continuation and nothing else.
```

New:

```text
A rule blocked this continuation. ${held.reason} Approve this continuation to proceed.
```

Reason: VOICE 6: name the blocked action and retain exact continuation approval.

S019. Source: `server/harness/present.ts:171` at base; candidate lines 171. 1 occurrence.

Now:

```text
The agent finished this phase and asks to continue to the next one, staying within its granted files, services and spend. Nothing happens until you say go ahead, and your OK covers exactly this continuation and nothing else.
```

New:

```text
This phase finished. Approve this continuation to proceed within the existing permissions and spending limit.
```

Reason: VOICE 5 and 6: keep permission and spending boundaries while removing repetitive approval narration.

S020. Source: `server/harness/present.ts:172` at base; candidate lines 172. 1 occurrence.

Now:

```text
This continues the task to ${label} within its existing file, service and spend permissions. It moves the task\u2019s phase marker and records the move in History; it grants nothing new and writes no files itself.
```

New:

```text
This continues the task to ${label} within its existing permissions and spending limit. History records the phase change.
```

Reason: VOICE 6: preserve bounded phase continuation and History while cutting mechanism and repeated authority caveats.

S021. Source: `server/harness/present.ts:185` at base; candidate lines 185. 1 occurrence.

Now:

```text
This sends information outside this computer. Diomedes cannot take it back afterwards.
```

New:

```text
This sends information outside this computer. Nectovia can't take it back afterwards.
```

Reason: VOICE 5: current product name and contraction; keep the irreversible-send warning.

S022. Source: `server/harness/present.ts:188` at base; candidate lines 188. 1 occurrence.

Now:

```text
This changes files in this project. Diomedes records the before and after, so you can undo it in Review.
```

New:

```text
This changes files in this project. Nectovia records the before and after, so you can undo it in Review.
```

Reason: Current product name; keep available undo truth.

S023. Source: `server/harness/present.ts:189` at base; candidate lines 189. 1 occurrence.

Now:

```text
This changes something. Diomedes records what it did, but it cannot promise this can be undone.
```

New:

```text
This makes a change. Nectovia records it. Undo isn't guaranteed.
```

Reason: VOICE 5 and 6: retain the unknown reversibility limit with direct wording.

S024. Source: `server/harness/present.ts:191` at base; candidate lines 191. 1 occurrence.

Now:

```text
This makes a change that is safe to repeat. Diomedes records it.
```

New:

```text
This makes a change that can be repeated safely. History records it.
```

Reason: VOICE 6: clearer idempotent-effect consequence without old product name.

S025. Source: `server/harness/present.ts:192` at base; candidate lines 192. 1 occurrence.

Now:

```text
This only reads. Nothing changes.
```

New:

```text
This reads information.
```

Reason: VOICE 6: state the read consequence once.

S026. Source: `server/harness/present.ts:198` at base; candidate lines 198. 1 occurrence.

Now:

```text
Go ahead with ${describeIntent(step)}?
```

New:

```text
Approve ${describeIntent(step)}?
```

Reason: VOICE 6: direct approval action.

S027. Source: `server/harness/present.ts:200` at base; candidate lines 200. 1 occurrence.

Now:

```text
A rule held this before it ran: ${held.reason} Nothing happens until you say go ahead, and your OK covers exactly this step and nothing else.
```

New:

```text
A rule blocked this step. ${held.reason} Approve this step to proceed.
```

Reason: VOICE 6: name the blocked step and retain exact step approval.

S028. Source: `server/harness/present.ts:201` at base; candidate lines 200,201. 1 occurrence.

Now:

```text
This step asks for your OK before it runs. Nothing happens until you say go ahead, and your OK covers exactly this step and nothing else.
```

New:

```text
Approve this step to proceed.
```

Reason: VOICE 6: exact step approval stated once.

### server/work.ts

S029. Source: `server/work.ts:175` at base; candidate lines 175. 1 occurrence.

Now:

```text
If you say go ahead, the sample work starts.
```

New:

```text
Approve to start the sample work.
```

Reason: VOICE 6: direct approval action.

S030. Source: `server/work.ts:176` at base; candidate lines 176. 1 occurrence.

Now:

```text
If you say go ahead, the file is created and listed in History.
```

New:

```text
Approve to create the file and record it in History.
```

Reason: VOICE 6: direct approval action with the History consequence retained.

S031. Source: `server/work.ts:196` at base; candidate lines 196. 1 occurrence.

Now:

```text
Waiting for your OK to start ${task.name}.
```

New:

```text
Approve to start ${task.name}.
```

Reason: VOICE 6: replace assistant waiting voice with the action.

S032. Source: `server/work.ts:197` at base; candidate lines 197. 1 occurrence.

Now:

```text
Waiting for your OK to add a file.
```

New:

```text
Approve to add the file.
```

Reason: VOICE 6: replace assistant waiting voice with the action.

### server/harness/lifecycle.ts

S033. Source: `server/harness/lifecycle.ts:193` at base; candidate lines 193. 1 occurrence.

Now:

```text
Nothing has been approved for this change, so it was not written.
```

New:

```text
This change needs approval.
```

Reason: VOICE 6: name the unmet requirement once.

S034. Source: `server/harness/lifecycle.ts:197` at base; candidate lines 197. 1 occurrence.

Now:

```text
This work was admitted to run on ${resolution.route.routeId}, and the change came from ${request.routeId}. Nothing was written.
```

New:

```text
This work was assigned to run on ${resolution.route.routeId}, but the change came from ${request.routeId}.
```

Reason: VOICE 6: retain the execution route assignment mismatch without describing route admission as human approval.

S035. Source: `server/harness/lifecycle.ts:202` at base; candidate lines 202. 1 occurrence.

Now:

```text
The file changed since this was prepared. Nothing was written; look at it again.
```

New:

```text
The file changed since this was prepared. Review it again.
```

Reason: VOICE 6: preserve stale-file failure and required review action.

S036. Source: `server/harness/lifecycle.ts:314` at base; candidate lines 314. 1 occurrence.

Now:

```text
Diomedes has tried this ${CORRECTION_LIMITS.maxAttempts} times and stopped. What it ran into is recorded below.
```

New:

```text
Nectovia stopped after ${CORRECTION_LIMITS.maxAttempts} attempts. Read the recorded error.
```

Reason: VOICE 6: current product name and direct recovery action instead of ran into.

### server/harness/text-route.ts

S037. Source: `server/harness/text-route.ts:205` at base; candidate lines 205. 1 occurrence.

Now:

```text
This request is parked: its provider outcome was never confirmed.
```

New:

```text
The provider request has an unconfirmed result. Check what happened before trying again.
```

Reason: VOICE 6: replace parked with an explicit uncertainty and retry warning.

S038. Source: `server/harness/text-route.ts:210` at base; candidate lines 210. 1 occurrence.

Now:

```text
This request failed. Its record is kept.
```

New:

```text
This request failed.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S039. Source: `server/harness/text-route.ts:255` at base; candidate lines 255. 1 occurrence.

Now:

```text
The run is parked for reconciliation: ${
```

New:

```text
The request needs an outcome check: ${
```

Reason: VOICE 6: retain the underlying error while replacing parked and reconciliation jargon.

### server/harness/board-progress.ts

S040. Source: `server/harness/board-progress.ts:72` at base; candidate lines 72. 1 occurrence.

Now:

```text
${label}${detail} waits for approval or a response.
```

New:

```text
${label}${detail} needs approval or a response.
```

Reason: VOICE 6: retain the actual approval-or-event requirement without assistant waiting phrasing.

### server/harness/capabilities/weekly-brief.ts

S041. Source: `server/harness/capabilities/weekly-brief.ts:55` at base; candidate lines 55. 1 occurrence.

Now:

```text
Read the approved exports, compose a source-linked draft and save it for review. Nothing is sent.
```

New:

```text
Read the approved exports and save a draft with sources for review.
```

Reason: VOICE 6: keep the deterministic brief description without the redundant no-send tail.

S042. Source: `server/harness/capabilities/weekly-brief.ts:93` at base; candidate lines 93. 1 occurrence.

Now:

```text
Waiting for data: ${missing.join(', ')} could not be read, so nothing was written.
```

New:

```text
These required files couldn't be read: ${missing.join(', ')}. Check them before starting again.
```

Reason: VOICE 5 and 6: name missing input files and the next action.

S043. Source: `server/harness/capabilities/weekly-brief.ts:199` at base; candidate lines 199. 1 occurrence.

Now:

```text
The setup revision this run was admitted under is no longer recorded, so nothing was written.
```

New:

```text
The setup version for this job is missing. Check the business setup before starting again.
```

Reason: VOICE 6 and 7: name the missing setup version and action.

S044. Source: `server/harness/capabilities/weekly-brief.ts:320` at base; candidate lines 320. 1 occurrence.

Now:

```text
Save the draft to the pinned destination for review. Nothing is sent.
```

New:

```text
Save the draft to the approved destination for review.
```

Reason: VOICE 6 and 7: retain destination and draft-review boundaries without pinned jargon or redundant tail.

### server/file-drops.ts

S045. Source: `server/file-drops.ts:103` at base; candidate lines 103. 1 occurrence.

Now:

```text
${name} does not say how large it is. Files did not add it.
```

New:

```text
${name} doesn't have readable picture dimensions.
```

Reason: VOICE 5 and 6: name the unreadable image dimensions without a tail.

### shared/automations.ts

S046. Source: `shared/automations.ts:397` at base; candidate lines 397. 1 occurrence.

Now:

```text
The last press was interrupted before its run started. Nothing was written. Press Run once again.
```

New:

```text
The last start was interrupted. Press Run once again.
```

Reason: VOICE 6: direct interruption and existing retry action.

S047. Source: `shared/automations.ts:400` at base; candidate lines 400. 1 occurrence.

Now:

```text
The last run’s record could not be read.
```

New:

```text
The last job's history couldn't be read.
```

Reason: VOICE 5 and 7: contractions and plain history wording.

S048. Source: `shared/automations.ts:406` at base; candidate lines 406. 1 occurrence.

Now:

```text
A step is waiting for your exact OK.
```

New:

```text
Approve the next step to continue.
```

Reason: VOICE 6: replace assistant waiting voice with the action.

S049. Source: `shared/automations.ts:407` at base; candidate lines 407. 1 occurrence.

Now:

```text
The last run is waiting on something outside Diomedes.
```

New:

```text
The last job needs an external response.
```

Reason: VOICE 6: external wait described directly.

S050. Source: `shared/automations.ts:411` at base; candidate lines 411. 1 occurrence.

Now:

```text
The last run may have done something it could not confirm. Check it before running again.
```

New:

```text
The last job has an unconfirmed action. Check what happened before starting again.
```

Reason: VOICE 6: retain uncertain effects and check-before-retry action.

S051. Source: `shared/automations.ts:414` at base; candidate lines 414. 1 occurrence.

Now:

```text
The last run stopped because something went wrong.
```

New:

```text
The last job failed. Check its error before starting again.
```

Reason: VOICE 6: direct failure and action.

S052. Source: `shared/automations.ts:423` at base; candidate lines 423. 1 occurrence.

Now:

```text
${listFiles(run.missing)} could not be read, so nothing was written.
```

New:

```text
${listFiles(run.missing)} couldn't be read. Check the required files before starting again.
```

Reason: VOICE 5 and 6: direct input failure and action.

S053. Source: `shared/automations.ts:426` at base; candidate lines 426. 1 occurrence.

Now:

```text
Nothing starts on its own until an owner or admin resumes it.
```

New:

```text
An owner or admin can resume the schedule.
```

Reason: VOICE 6: state the actual resume action.

S054. Source: `shared/automations.ts:428` at base; candidate lines 428. 1 occurrence.

Now:

```text
Its schedule is assigned to another computer, so nothing starts here.
```

New:

```text
The schedule is assigned to another computer.
```

Reason: VOICE 6: state the assigned host once without claiming that the schedule is running there.

S055. Source: `shared/automations.ts:432` at base; candidate lines 432. 1 occurrence.

Now:

```text
This computer has not checked its schedule recently, so it cannot say it will start on time.
```

New:

```text
This computer hasn't checked its schedule recently. Check the schedule before relying on its start time.
```

Reason: VOICE 5 and 6: keep stale schedule evidence and user action.

### shared/conversation-engines.ts

S056. Source: `shared/conversation-engines.ts:66` at base; candidate lines 66. 1 occurrence.

Now:

```text
${routeDisplayName(engine)} ${state} on this computer, so this conversation can't continue here. Nothing was sent.
```

New:

```text
${routeDisplayName(engine)} ${state} on this computer, so this conversation can't continue here.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

### shared/individual-plan.ts

S057. Source: `shared/individual-plan.ts:195` at base; candidate lines 195. 1 occurrence.

Now:

```text
The Nectovia Agent isn't part of your personal work here. It comes with an Individual plan of your own, or with a business workspace that includes it. Nothing was sent.
```

New:

```text
The Nectovia Agent isn't part of your personal work here. It comes with an Individual plan of your own, or with a business workspace that includes it.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S058. Source: `shared/individual-plan.ts:199` at base; candidate lines 199. 1 occurrence.

Now:

```text
Managed Personal work requires Individual account routing and setup. Refresh your account in a current app to continue. Nothing was sent.
```

New:

```text
Your Personal account setup needs an update. Refresh your account in a current app to continue.
```

Reason: VOICE 6: retain legacy Individual account setup requirement with a direct next action.

S059. Source: `shared/individual-plan.ts:210` at base; candidate lines 210. 1 occurrence.

Now:

```text
Your Individual plan has ended, so the Nectovia Agent is not available for your personal work. Your files and history are unchanged.
```

New:

```text
Your Individual plan has ended, so the Nectovia Agent isn't available for your personal work.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S060. Source: `shared/individual-plan.ts:211` at base; candidate lines 211. 1 occurrence.

Now:

```text
Your Individual plan was withdrawn, so the Nectovia Agent is not available for your personal work. Your files and history are unchanged.
```

New:

```text
Your Individual plan was withdrawn, so the Nectovia Agent isn't available for your personal work.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

### shared/native-loop.ts

S061. Source: `shared/native-loop.ts:564` at base; candidate lines 564. 1 occurrence.

Now:

```text
Waiting for your OK
```

New:

```text
Needs your OK
```

Reason: VOICE 6: use the existing product approval label.

S062. Source: `shared/native-loop.ts:566` at base; candidate lines 566. 1 occurrence.

Now:

```text
The next action, ${view.waiting.tool}, waits for your OK. Nothing runs until you answer.
```

New:

```text
Approve ${view.waiting.tool} to continue.
```

Reason: VOICE 6: required exact action stated directly.

S063. Source: `shared/native-loop.ts:567` at base; candidate lines 567. 1 occurrence.

Now:

```text
Waiting for something outside Diomedes.
```

New:

```text
Paused for an external response.
```

Reason: VOICE 6: actual external wait described directly.

S064. Source: `shared/native-loop.ts:573` at base; candidate lines 573. 1 occurrence.

Now:

```text
An action may have happened that Diomedes could not confirm. Nothing will be repeated on its own.
```

New:

```text
An action has an unconfirmed result. Check what happened before starting again.
```

Reason: VOICE 6: preserve uncertainty and retry guard.

S065. Source: `shared/native-loop.ts:613` at base; candidate lines 613. 1 occurrence.

Now:

```text
Stopped because something went wrong. Nothing will be repeated on its own.
```

New:

```text
The job failed. Check its error before starting again.
```

Reason: VOICE 6: direct failure and action.

### shared/access.ts

S066. Source: `shared/access.ts:326` at base; candidate lines 326. 1 occurrence.

Now:

```text
The Nectovia Agent is part of a Business plan. You can still use your workspace and your own AI tools directly.
```

New:

```text
The Nectovia Agent is part of a Business plan.
```

Reason: VOICE 6: keep the entitlement reason without a reassurance about other work.

S067. Source: `shared/access.ts:329` at base; candidate lines 329. 1 occurrence.

Now:

```text
Buy credits or get a plan to use the Nectovia Agent here. Your own AI tools work without either.
```

New:

```text
Buy credits or get a plan to use the Nectovia Agent here.
```

Reason: VOICE 6: retain the credit/plan action without an unrelated reassurance.

### shared/route-unavailable.ts

S068. Source: `shared/route-unavailable.ts:9` at base; candidate lines 9. 1 occurrence.

Now:

```text
${provider} is unavailable right now. Please contact support and check that your account is connected and has credits remaining.
```

New:

```text
${provider} is unavailable right now. Check your connection and credits, then contact support if it still fails.
```

Reason: VOICE 5 and 6: put existing recovery checks in order and remove Please.

### server/engines/google-vertex.ts

S069. Source: `server/engines/google-vertex.ts:201` at base; candidate lines 201. 1 occurrence.

Now:

```text
No Gemini 3.8 Flash price is recorded for this date. Nothing was sent.
```

New:

```text
No Gemini 3.8 Flash price is recorded for this date.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S070. Source: `server/engines/google-vertex.ts:207` at base; candidate lines 207. 1 occurrence.

Now:

```text
The recorded Gemini 3.8 Flash price (${entry.card.version}) needs re-checking against Google’s pricing page before more calls are priced. Nothing was sent.
```

New:

```text
The recorded Gemini 3.8 Flash price (${entry.card.version}) needs re-checking against Google’s pricing page before more calls are priced.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S071. Source: `server/engines/google-vertex.ts:219` at base; candidate lines 219. 1 occurrence.

Now:

```text
The price this call was prepared with (${card.version}) is no longer in force. Nothing was sent.
```

New:

```text
The price this call was prepared with (${card.version}) is no longer in force.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S072. Source: `server/engines/google-vertex.ts:326` at base; candidate lines 326. 1 occurrence.

Now:

```text
No Google Application Default Credentials were found. Run `gcloud auth application-default login` and verify the connection in AI setup. Nothing was sent.
```

New:

```text
No Google Application Default Credentials were found. Run `gcloud auth application-default login` and verify the connection in AI setup.
```

Reason: VOICE 6: cut only the tail; keep owner-only credential recovery command.

S073. Source: `server/engines/google-vertex.ts:332` at base; candidate lines 332. 1 occurrence.

Now:

```text
The Google credential on this computer is not the one this connection was verified with. Verify it again in AI setup. Nothing was sent.
```

New:

```text
The Google credential on this computer isn't the one this connection was verified with. Verify it again in AI setup.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S074. Source: `server/engines/google-vertex.ts:348` at base; candidate lines 348. 1 occurrence.

Now:

```text
Google did not issue an access token for the saved credential. Sign in again with `gcloud auth application-default login`. Nothing was sent.
```

New:

```text
Google didn't issue an access token for the saved credential. Sign in again with `gcloud auth application-default login`.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S075. Source: `server/engines/google-vertex.ts:353` at base; candidate lines 353. 1 occurrence.

Now:

```text
Google issued no access token. Nothing was sent.
```

New:

```text
Google issued no access token.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S076. Source: `server/engines/google-vertex.ts:632` at base; candidate lines 632. 1 occurrence.

Now:

```text
The request ${why}. Nothing was sent.
```

New:

```text
The request ${why}.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

### server/managed-gateway.ts

S077. Source: `server/managed-gateway.ts:83` at base; candidate lines 83. 1 occurrence.

Now:

```text
You can’t reserve this business’s included usage yourself. Your work in the app draws on it as it runs. Nothing was held.
```

New:

```text
You can’t reserve this business’s included usage directly. Nectovia reserves it when work starts.
```

Reason: VOICE 6: retain the direct-reservation restriction and one timing explanation.

S078. Source: `server/managed-gateway.ts:128` at base; candidate lines 128. 1 occurrence.

Now:

```text
You can’t settle this business’s usage yourself. Your work in the app settles as it finishes. Nothing was changed.
```

New:

```text
Nectovia records usage when your work finishes. You can’t settle it directly.
```

Reason: VOICE 6: retain direct-settlement restriction without redundant state narration.

S079. Source: `server/managed-gateway.ts:221` at base; candidate lines 221. 1 occurrence.

Now:

```text
You are not an active member of this business, so nothing runs on its account.
```

New:

```text
You aren't an active member of this business. Its account can't fund this work.
```

Reason: VOICE 5 and 6: retain identity and payer boundary in direct wording.

S080. Source: `server/managed-gateway.ts:245` at base; candidate lines 245. 1 occurrence.

Now:

```text
This business keeps its work on its own computers, and that route sends work elsewhere. Nothing was sent and nothing was downgraded quietly.
```

New:

```text
This business requires work to stay on its own computers. The selected connection sends work elsewhere.
```

Reason: VOICE 6: preserve the processing policy conflict without tails or quietly.

S081. Source: `server/managed-gateway.ts:269` at base; candidate lines 269. 1 occurrence.

Now:

```text
The request time is not readable; nothing was reserved and nothing was admitted.
```

New:

```text
The request time couldn't be read.
```

Reason: VOICE 5 and 6: name the invalid request time once.

S082. Source: `server/managed-gateway.ts:297` at base; candidate lines 297. 1 occurrence.

Now:

```text
This call could cost more than one job is capped at. Nothing was held and nothing was sent.
```

New:

```text
This request could exceed the job’s spending limit.
```

Reason: VOICE 6: retain spending refusal without reservation/send tails.

### server/engines/nectovia.ts

S083. Source: `server/engines/nectovia.ts:59` at base; candidate lines 59. 1 occurrence.

Now:

```text
Nectovia's model service isn't available right now. Nothing was charged.
```

New:

```text
Nectovia's AI service isn't available right now.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S084. Source: `server/engines/nectovia.ts:148` at base; candidate lines 148. 1 occurrence.

Now:

```text
Your Individual billing period could not be confirmed. Nothing was sent.
```

New:

```text
Your Individual billing period couldn't be confirmed.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S085. Source: `server/engines/nectovia.ts:225` at base; candidate lines 225. 1 occurrence.

Now:

```text
Nectovia published a model this version of the app has no price for. Nothing was sent. Update Nectovia to use it.
```

New:

```text
Nectovia changed its AI, and this app needs updated pricing. Update Nectovia to continue.
```

Reason: VOICE 6 and 7: keep the pricing/update requirement without model jargon or a tail.

S086. Source: `server/engines/nectovia.ts:291` at base; candidate lines 291. 1 occurrence.

Now:

```text
This business does not include the Nectovia Agent. Nothing was charged.
```

New:

```text
This business doesn't include the Nectovia Agent.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S087. Source: `server/engines/nectovia.ts:296` at base; candidate lines 296. 1 occurrence.

Now:

```text
Nectovia could not confirm this message was admitted. Nothing was charged. Send it again.
```

New:

```text
Nectovia couldn't confirm this message started. Send it again to check.
```

Reason: VOICE 5 and 6: distinguish uncertain admission from human approval; preserve check of the same request before retry.

S088. Source: `server/engines/nectovia.ts:309` at base; candidate lines 309. 1 occurrence.

Now:

```text
This job has reached the ${tierName(tier)} cap. Nothing was charged.
```

New:

```text
This job has reached the ${tierName(tier)} cap.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S089. Source: `server/engines/nectovia.ts:322` at base; candidate lines 322. 1 occurrence.

Now:

```text
Nectovia changed the model ${tierName(tier)} runs on. Nothing was charged. Send your message again.
```

New:

```text
Nectovia changed the AI used for ${tierName(tier)}. Send your message again.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S090. Source: `server/engines/nectovia.ts:327,335` at base; candidate lines 327,335. 2 occurrences.

Now:

```text
${tierName(tier)} has no Nectovia model right now. Nothing was charged. Choose another tier.
```

New:

```text
${tierName(tier)} is unavailable right now. Choose another tier.
```

Reason: VOICE 6 and 7: retain unavailable tier and existing action without model jargon and a tail.

S091. Source: `server/engines/nectovia.ts:341` at base; candidate lines 341. 1 occurrence.

Now:

```text
This message and its sources are longer than Nectovia accepts. Nothing was charged. Choose fewer or shorter sources.
```

New:

```text
This message and its sources are longer than Nectovia accepts. Choose fewer or shorter sources.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S092. Source: `server/engines/nectovia.ts:346` at base; candidate lines 346. 1 occurrence.

Now:

```text
Nectovia's model service is busy. Nothing was charged. Try again in a minute.
```

New:

```text
Nectovia's AI service is busy. Try again in a minute.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S093. Source: `server/engines/nectovia.ts:363` at base; candidate lines 363. 1 occurrence.

Now:

```text
Nectovia refused this message${said ? `: ${said}` : '.'} Nothing was charged.
```

New:

```text
Nectovia refused this message${said ? `: ${said}` : '.'}
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S094. Source: `server/engines/nectovia.ts:421` at base; candidate lines 421. 1 occurrence.

Now:

```text
These sources need a versioned routing policy with verified privacy evidence. Nothing was sent.
```

New:

```text
These sources need a versioned routing policy with verified privacy evidence.
```

Reason: VOICE 6: cut only the redundant tail; retain precise source-policy refusal.

S095. Source: `server/engines/nectovia.ts:607` at base; candidate lines 607. 1 occurrence.

Now:

```text
Nectovia now runs ${tierName(managed.tier)} on ${now.label}. Nothing was charged. Send your message again to use it.
```

New:

```text
Nectovia now runs ${tierName(managed.tier)} on ${now.label}. Send your message again to use it.
```

Reason: VOICE 6: retain recorded AI attribution change and resend action; cut the tail.

S096. Source: `server/engines/nectovia.ts:608` at base; candidate lines 608. 1 occurrence.

Now:

```text
${tierName(managed.tier)} has no Nectovia model right now. Nothing was charged. Choose another tier.
```

New:

```text
${tierName(managed.tier)} is unavailable right now. Choose another tier.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S097. Source: `server/engines/nectovia.ts:642` at base; candidate lines 642. 1 occurrence.

Now:

```text
${tierName(style)} has no Nectovia model right now. Nothing was sent. Choose another tier.
```

New:

```text
${tierName(style)} is unavailable right now. Choose another tier.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S098. Source: `server/engines/nectovia.ts:657` at base; candidate lines 657. 1 occurrence.

Now:

```text
The Nectovia Agent answers in the conversation. Build and Fix are not on it yet, so nothing was sent.
```

New:

```text
Build and Fix aren't available for the Nectovia Agent in this conversation.
```

Reason: VOICE 5 and 6: state the unsupported modes without yet or a tail.

S099. Source: `server/engines/nectovia.ts:663` at base; candidate lines 663. 1 occurrence.

Now:

```text
This Nectovia loop needs its own managed job. Delegates and teams are unavailable on this route. Nothing was sent.
```

New:

```text
This Nectovia loop needs its own managed job. Delegates and teams are unavailable on this route.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

### server/software-pack/service.ts

S100. Source: `server/software-pack/service.ts:157` at base; candidate lines 157. 1 occurrence.

Now:

```text
Diomedes stopped while this was running, so what it did is not confirmed. It will not run it again on its own.
```

New:

```text
Nectovia stopped during this action. Its result isn't confirmed. Check what happened before trying again.
```

Reason: VOICE 6: keep uncertain external effects and check-before-retry, using the current product name.

S101. Source: `server/software-pack/service.ts:308` at base; candidate lines 4,7,10,12,16,17,19,20,23,24,25,46,47,48,49,50,51,52,53,54,55,56,64,76,84,87,88,89,94,98,100,111,118,119,120,126,129,131,132,137,139,144,145,148,149,153,154,155,156,157,158,161,165,166,169,171,173,178,185,186,189,191,193,197,198,199,200,201,202,203,204,205,207,208,211,212,213,214,215,216,217,218,220,222,224,226,227,235,236,237,238,239,243,244,245,246,252,253,256,257,258,259,260,264,265,266,269,271,272,276,277,278,279,282,284,285,286,287,292,299,300,301,305,306,307,308,309,311,315,318,323,327,329,330,331,340,344,345,346,347,350,352,353,354,355,356,357,360,366,369,370,372,379,384,385,387,388,393,395,396,397,398,399,400,401,402,406,409,410,411,412,413,416,417,418,419,420,435,437,438,439,440,445,448,449,450,451,452,453,454,457,458,459,460,461,462,463,464,465,466,467,469,470,471,472,473,475,480,481,482,484,487,488,496,497,498,501,502,506,508,509,510,511,514,515,516,517,518,519,520,521,522,524,525,526,527,529,533,534,535,536,537,538,541,547,550,551,552,553,554,555,556,557,558,559,560,561,562,563,564,565,567,568,569,570,576,577,580,586,587,603,604,606,607,614,615,616,617,618,619,622,623,624,625,626,627,628,629,630,631,633,634,635,637,641,642,644,647,655,656,657,659,660,661,662,667,669,670,671,672,673,675,677,678,680,681,682,683,685,686,687,688,689,690,694,695,697,698,702,706,707,709,715,717,718,720,722,729,730,731,734,735,736,737,738,739,740,741,742,743,744,745,747,748,750,760,761,763,766,767,770,771,772,774,775,776,777,778,783,785,786,787,788,789,794,796,797,798,801,804,805,806,807,808,811,814,820,821,822,823. 1 occurrence.

Now:

```text
. Declaring runs nothing; each run asks first.
```

New:

```text
.
```

Reason: VOICE 6: command declaration recorded once; approval remains explicit when a command is run.

S102. Source: `server/software-pack/service.ts:346` at base; candidate lines 346. 1 occurrence.

Now:

```text
The request did not stop for its approval, so nothing was run.
```

New:

```text
The request couldn't reach its approval step.
```

Reason: VOICE 5 and 6: direct approval-preparation failure.

S103. Source: `server/software-pack/service.ts:435` at base; candidate lines 435. 1 occurrence.

Now:

```text
Waiting for your OK to run ${command.command}${command.cwd ? ` in ${command.cwd}` : ''}. Nothing runs until you say go ahead.
```

New:

```text
Approve to run ${command.command}${command.cwd ? ` in ${command.cwd}` : ''}.
```

Reason: VOICE 6: name exact command and destination with the approval action.

S104. Source: `server/software-pack/service.ts:527` at base; candidate lines 527. 1 occurrence.

Now:

```text
Diomedes could not confirm how this ended (${failure}). It will not run it again on its own.
```

New:

```text
Nectovia couldn't confirm the result (${failure}). Check what happened before trying again.
```

Reason: VOICE 5 and 6: preserve uncertain result and require outcome check before retry.

S105. Source: `server/software-pack/service.ts:603` at base; candidate lines 603. 1 occurrence.

Now:

```text
Waiting for your OK to add ${WORKTREE_FOLDER}/${name} on a new branch ${branch}.
```

New:

```text
Approve to add ${WORKTREE_FOLDER}/${name} on a new branch ${branch}.
```

Reason: VOICE 6: direct exact worktree-add approval.

S106. Source: `server/software-pack/service.ts:604` at base; candidate lines 604. 1 occurrence.

Now:

```text
Waiting for your OK to remove ${WORKTREE_FOLDER}/${name}. It is removed only if nothing in it is uncommitted.
```

New:

```text
Approve to remove ${WORKTREE_FOLDER}/${name}. Commit or discard any uncommitted changes first.
```

Reason: VOICE 6: keep dirty-work protection and exact removal approval.

S107. Source: `server/software-pack/service.ts:631` at base; candidate lines 467,631. 1 occurrence.

Now:

```text
You declined. Nothing changed.
```

New:

```text
You declined.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S108. Source: `server/software-pack/service.ts:642` at base; candidate lines 642. 1 occurrence.

Now:

```text
You declined ${what}. Nothing changed.
```

New:

```text
You declined ${what}.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S109. Source: `server/software-pack/service.ts:678` at base; candidate lines 678. 1 occurrence.

Now:

```text
Diomedes could not confirm what happened (${failure}). Check ${found.path} before trying again.
```

New:

```text
Nectovia couldn't confirm what happened (${failure}). Check ${found.path} before trying again.
```

Reason: VOICE 5: current product name and contraction; keep uncertainty action.

### server/software-pack/tools.ts

S110. Source: `server/software-pack/tools.ts:249,307` at base; candidate lines 249,307. 2 occurrences.

Now:

```text
${error.message} Nothing was changed.
```

New:

```text
${error.message}
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S111. Source: `server/software-pack/tools.ts:253` at base; candidate lines 253. 1 occurrence.

Now:

```text
${relative} already exists. Nothing was changed.
```

New:

```text
${relative} already exists.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S112. Source: `server/software-pack/tools.ts:260` at base; candidate lines 260. 1 occurrence.

Now:

```text
A branch called ${input.branch} already exists. Choose a new name; nothing was changed.
```

New:

```text
A branch called ${input.branch} already exists. Choose a new name.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S113. Source: `server/software-pack/tools.ts:311` at base; candidate lines 311. 1 occurrence.

Now:

```text
${relative} is not there. Nothing was changed.
```

New:

```text
${relative} isn't there.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S114. Source: `server/software-pack/tools.ts:316` at base; candidate lines 316. 1 occurrence.

Now:

```text
${relative} is not a worktree of this repository. Nothing was changed.
```

New:

```text
${relative} isn't a worktree of this repository.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S115. Source: `server/software-pack/tools.ts:323` at base; candidate lines 323. 1 occurrence.

Now:

```text
Commit or discard them yourself first; Diomedes never force-removes a worktree. Nothing was removed.
```

New:

```text
Commit or discard them yourself first.
```

Reason: VOICE 6: keep dirty-work protection and required human action; remove redundant no-force/removal tails.

### server/pack-lifecycle.ts

S116. Source: `server/pack-lifecycle.ts:253` at base; candidate lines 253. 1 occurrence.

Now:

```text
The pack store is not readable JSON. Nothing in it was changed.
```

New:

```text
The pack store isn't readable JSON.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S117. Source: `server/pack-lifecycle.ts:266` at base; candidate lines 266. 1 occurrence.

Now:

```text
The pack store was written with schema ${String(raw.schemaVersion)}, which this Diomedes does not read. Nothing in it was changed.
```

New:

```text
The pack store uses version ${String(raw.schemaVersion)}, which this Nectovia can't read.
```

Reason: VOICE 5 to 7: keep exact incompatible store version with current product name and direct wording.

S118. Source: `server/pack-lifecycle.ts:273` at base; candidate lines 273. 1 occurrence.

Now:

```text
The pack store does not have the shape this Diomedes writes. Nothing in it was changed.
```

New:

```text
Nectovia can't read the pack store's format.
```

Reason: VOICE 5 to 7: direct incompatible-format error.

S119. Source: `server/pack-lifecycle.ts:318` at base; candidate lines 318. 1 occurrence.

Now:

```text
Diomedes stopped before this finished. The store still says what it said before it started, and nothing from it was turned on.
```

New:

```text
Nectovia stopped before the pack change finished. Try the change again.
```

Reason: VOICE 6: direct interrupted pre-commit operation and recovery action.

S120. Source: `server/pack-lifecycle.ts:626` at base; candidate lines 626. 1 occurrence.

Now:

```text
The pack's digest does not match its contents. Nothing was installed.
```

New:

```text
The pack doesn't match its recorded checksum.
```

Reason: VOICE 5 to 7: keep integrity mismatch without a redundant installation tail.

S121. Source: `server/pack-lifecycle.ts:637` at base; candidate lines 637. 1 occurrence.

Now:

```text
That pack does not ship with this Diomedes.
```

New:

```text
That pack isn't included with this Nectovia.
```

Reason: VOICE 5: current product name and contraction.

### server/automations.ts

S122. Source: `server/automations.ts:276` at base; candidate lines 276. 1 occurrence.

Now:

```text
Diomedes stopped before this run started, so nothing was written.
```

New:

```text
Nectovia stopped before this job started.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S123. Source: `server/automations.ts:457` at base; candidate lines 457. 1 occurrence.

Now:

```text
This setup names nowhere to put the brief, so nothing was prepared.
```

New:

```text
Choose a destination for this brief in the business setup.
```

Reason: VOICE 6: name required destination and action.

S124. Source: `server/automations.ts:845` at base; candidate lines 845. 1 occurrence.

Now:

```text
It starts on its own only while this computer is on and Diomedes is running. Nobody is alerted while it is off: a missed run is recorded when it starts again.
```

New:

```text
The schedule runs while this computer is on and Nectovia is open. Missed jobs are recorded when it restarts; alerts need this computer running.
```

Reason: VOICE 6: keep schedule host and alert availability requirements without old product name or colon narration.

S125. Source: `server/automations.ts:846` at base; candidate lines 846. 1 occurrence.

Now:

```text
Someone presses Run once. Nothing starts on a schedule.
```

New:

```text
Press Run once to start it.
```

Reason: VOICE 6: state the manual action once.

S126. Source: `server/automations.ts:1077` at base; candidate lines 1077. 1 occurrence.

Now:

```text
The person signed in on this computer is not a member of this business, so nothing ran.
```

New:

```text
The person signed in on this computer isn't a member of this business.
```

Reason: VOICE 5 and 6: membership refusal without a tail.

S127. Source: `server/automations.ts:1577` at base; candidate lines 1577. 1 occurrence.

Now:

```text
Diomedes stopped before the run started, so nothing was written. It is not run again on its own.
```

New:

```text
Nectovia stopped before the job started. Start it again when this computer is ready.
```

Reason: VOICE 6: direct interrupted start and manual recovery.

S128. Source: `server/automations.ts:1604` at base; candidate lines 1604. 1 occurrence.

Now:

```text
${run.failure?.message ?? 'A source could not be read'} Nothing was written.
```

New:

```text
${run.failure?.message ?? 'A required source could not be read'}
```

Reason: VOICE 6: keep the recorded missing-input error without a tail.

S129. Source: `server/automations.ts:1606` at base; candidate lines 1606. 1 occurrence.

Now:

```text
It may have done something it could not confirm. Check it before it runs again.
```

New:

```text
The job has an unconfirmed action. Check what happened before starting again.
```

Reason: VOICE 6: preserve uncertain effects and check-before-retry.

S130. Source: `server/automations.ts:1607` at base; candidate lines 1607. 1 occurrence.

Now:

```text
It stopped because something went wrong.
```

New:

```text
The job failed. Check its error before starting again.
```

Reason: VOICE 6: direct failure and action.

### server/organization-export.ts

S131. Source: `server/organization-export.ts:101` at base; candidate lines 101. 1 occurrence.

Now:

```text
One of the business's ${what} is too large to write to a file, so the export stopped. Nothing was written.
```

New:

```text
One of the business's ${what} is too large to write to a file, so the export stopped.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S132. Source: `server/organization-export.ts:151` at base; candidate lines 151. 1 occurrence.

Now:

```text
The business's ${name} records are too large to write to one file, so the export stopped. Nothing was written.
```

New:

```text
The business's ${name} records are too large to write to one file, so the export stopped.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

### server/relay/ports.ts

S133. Source: `server/relay/ports.ts:53` at base; candidate lines 53. 1 occurrence.

Now:

```text
You went ahead from your phone
```

New:

```text
You approved from your phone
```

Reason: VOICE 6: direct approval provenance.

### server/relay/messages.ts

S134. Source: `server/relay/messages.ts:103` at base; candidate lines 103. 1 occurrence.

Now:

```text
Nothing is waiting for this Team member.
```

New:

```text
This Team member has no pending work.
```

Reason: VOICE 6: describe actual queue state.

### server/change-review/render.ts

S135. Source: `server/change-review/render.ts:93` at base; candidate lines 93. 1 occurrence.

Now:

```text
The proposed change was declined. Nothing was written.
```

New:

```text
The proposed change was declined.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

### server/change-review/partial-keep.ts

S136. Source: `server/change-review/partial-keep.ts:143` at base; candidate lines 143. 1 occurrence.

Now:

```text
${change.path} was changed by ${by} after this change was made, so nothing was written. Review it again against the current file.
```

New:

```text
${change.path} was changed by ${by} after this change was made. Review it again against the current file.
```

Reason: VOICE 6: retain outside-edit conflict and current-file review action.

### server/interaction-turn.ts

S137. Source: `server/interaction-turn.ts:253` at base; candidate lines 253. 1 occurrence.

Now:

```text
This conversation is limited, so nothing was started.
```

New:

```text
This work exceeds the conversation’s permission limit.
```

Reason: VOICE 6: name the permission limit rather than a vague limitation plus tail.

S138. Source: `server/interaction-turn.ts:254` at base; candidate lines 254. 1 occurrence.

Now:

```text
Say which project this is for, and Diomedes can propose it there.
```

New:

```text
Choose a project for this proposal.
```

Reason: VOICE 6: direct required action.

S139. Source: `server/interaction-turn.ts:261` at base; candidate lines 261. 1 occurrence.

Now:

```text
That choice was for a different proposal. Nothing was started.
```

New:

```text
That choice was for a different proposal.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S140. Source: `server/interaction-turn.ts:262` at base; candidate lines 262. 1 occurrence.

Now:

```text
The original request no longer matches this work. Nothing was started.
```

New:

```text
The original request no longer matches this work.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S141. Source: `server/interaction-turn.ts:263` at base; candidate lines 263. 1 occurrence.

Now:

```text
This work exceeds the original request. Nothing was started.
```

New:

```text
This work exceeds the original request.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

### server/interaction-service.ts

S142. Source: `server/interaction-service.ts:524` at base; candidate lines 524. 1 occurrence.

Now:

```text
That choice does not match what was proposed. Nothing was started.
```

New:

```text
That choice doesn't match the proposal.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

### server/engines/install.ts

S143. Source: `server/engines/install.ts:227` at base; candidate lines 227. 1 occurrence.

Now:

```text
Install Cursor from cursor.com, then check this computer again. Diomedes does not install Cursor.
```

New:

```text
Install Cursor from cursor.com, then check this computer again.
```

Reason: VOICE 6: retain vendor-specific installation action without restating that Nectovia cannot install it.

S144. Source: `server/engines/install.ts:242` at base; candidate lines 242. 1 occurrence.

Now:

```text
Install Devin Desktop or the Devin CLI, then check this computer again. Diomedes does not install Devin.
```

New:

```text
Install Devin Desktop or the Devin CLI, then check this computer again.
```

Reason: VOICE 6: retain vendor-specific installation action without redundant caveat.

S145. Source: `server/engines/install.ts:321` at base; candidate lines 321. 1 occurrence.

Now:

```text
The private copy could not be read just now, so nothing was changed. Close anything using it and try again.
```

New:

```text
The Nectovia copy couldn't be read. Close anything using it and try again.
```

Reason: VOICE 5 and 6: direct installed-copy error and recovery action.

S146. Source: `server/engines/install.ts:362` at base; candidate lines 362. 1 occurrence.

Now:

```text
The release exceeded its download limit. Nothing was activated.
```

New:

```text
The release exceeded its download limit.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S147. Source: `server/engines/install.ts:374` at base; candidate lines 374. 1 occurrence.

Now:

```text
The official release checksum did not match. Nothing was activated.
```

New:

```text
The download doesn't match the official release checksum.
```

Reason: VOICE 5 and 6: direct integrity mismatch without activation tail.

S148. Source: `server/engines/install.ts:389` at base; candidate lines 389. 1 occurrence.

Now:

```text
The executable does not match the reviewed release. Nothing was activated.
```

New:

```text
The executable doesn't match the reviewed release.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S149. Source: `server/engines/install.ts:397` at base; candidate lines 397. 1 occurrence.

Now:

```text
The destination differs from the current official release. Nothing was activated.
```

New:

```text
The destination differs from the current official release.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

### server/engines/codex-session.ts

S150. Source: `server/engines/codex-session.ts:92` at base; candidate lines 92. 1 occurrence.

Now:

```text
Codex is signed in to a different ChatGPT account than this conversation started with, so it can't continue here. Nothing was sent. Sign in to the earlier account, or start a new conversation.
```

New:

```text
Codex is signed in to a different ChatGPT account than this conversation started with, so it can't continue here. Sign in to the earlier account, or start a new conversation.
```

Reason: VOICE 6: preserve account identity mismatch and safe recovery choices without a send tail.

S151. Source: `server/engines/codex-session.ts:96` at base; candidate lines 96. 1 occurrence.

Now:

```text
Diomedes restarted while an earlier message was being answered. That message wasn't completed or sent again.\u0020
```

New:

```text
Nectovia restarted while an earlier message was being answered. That message wasn't completed or sent again.\u0020
```

Reason: Current product name; retain interrupted-send/replay truth. The final \u0020 records the space before the concatenated continuation.

S152. Source: `server/engines/codex-session.ts:512` at base; candidate lines 512. 1 occurrence.

Now:

```text
Diomedes restarted while Codex was answering, and no Codex thread was confirmed to continue, so this conversation couldn't resume. Start again.
```

New:

```text
Nectovia restarted while Codex was answering. The saved thread couldn't be confirmed, so this conversation couldn't resume. Start again.
```

Reason: VOICE 5 and 6: current product name and shorter continuity error; preserve resume limit.

### server/engines/acp-session.ts

S153. Source: `server/engines/acp-session.ts:147` at base; candidate lines 147. 1 occurrence.

Now:

```text
Diomedes restarted while an earlier message was being answered; that message was not completed or resent.\u0020
```

New:

```text
Nectovia restarted while an earlier message was being answered. That message wasn't completed or resent.\u0020
```

Reason: VOICE 5: product name and contraction; preserve interrupted-send/replay truth. The final \u0020 records the space before the concatenated continuation.

S154. Source: `server/engines/acp-session.ts:361` at base; candidate lines 361. 1 occurrence.

Now:

```text
${profile.name} asked for approval and nobody answered in time, so the request was stopped. Nothing was approved.
```

New:

```text
${profile.name}'s approval request expired, so the request stopped.
```

Reason: VOICE 6: name expiry of the unanswered approval request, retaining the profile identity and the stopped request.

S155. Source: `server/engines/acp-session.ts:530` at base; candidate lines 530. 1 occurrence.

Now:

```text
Diomedes restarted while ${name} was answering, and ${name} cannot continue a saved session, so this conversation couldn't resume. Start again.
```

New:

```text
Nectovia restarted while ${name} was answering. ${name} can't continue a saved session, so this conversation couldn't resume. Start again.
```

Reason: VOICE 5 and 6: shorter continuity error with current product name; preserve engine resume limit.

S156. Source: `server/engines/acp-session.ts:531` at base; candidate lines 531. 1 occurrence.

Now:

```text
Diomedes restarted while ${name} was answering, and no ${name} session was confirmed to continue, so this conversation couldn't resume. Start again.
```

New:

```text
Nectovia restarted while ${name} was answering. The saved ${name} session couldn't be confirmed, so this conversation couldn't resume. Start again.
```

Reason: VOICE 5 and 6: shorter continuity error with current product name; preserve unknown saved session.

### server/engines/engine-asks.ts

S157. Source: `server/engines/engine-asks.ts:66` at base; candidate lines 66. 1 occurrence.

Now:

```text
${name} presented this plan in the conversation and waits for your answer before it continues.
```

New:

```text
Approve ${name}'s plan in this conversation to continue.
```

Reason: VOICE 6: direct plan approval with the actual engine identity retained.

S158. Source: `server/engines/engine-asks.ts:67` at base; candidate lines 67. 1 occurrence.

Now:

```text
${name} needs your permission for this one ${ask.toolKind ?? 'tool'} call, which the conversation's read access does not cover.
```

New:

```text
${name} needs separate approval for this ${ask.toolKind ?? 'tool'} action. The conversation's read access doesn't cover it.
```

Reason: VOICE 6: preserve one-action approval, engine identity and read-access boundary directly.

### shared/permissions.ts

S159. Source: `shared/permissions.ts:305` at base; candidate lines 305. 1 occurrence.

Now:

```text
You see each change set and decide. Nothing is applied without your OK.
```

New:

```text
Review each change set before applying it.
```

Reason: VOICE 6: state exact review-and-apply requirement once.

S160. Source: `shared/permissions.ts:308` at base; candidate lines 308. 1 occurrence.

Now:

```text
Every write waits for your exact decision.
```

New:

```text
Approve each exact change before it’s written.
```

Reason: VOICE 6: preserve exact-change approval without waiting voice.

S161. Source: `shared/permissions.ts:338` at base; candidate lines 338. 1 occurrence.

Now:

```text
A separate reviewer looks at each eligible change set. It can only hold a change back, never widen what is allowed.
```

New:

```text
A separate reviewer can approve or block eligible changes within your existing scope.
```

Reason: VOICE 6: preserve reviewer gate and scope ceiling in direct wording.

S162. Source: `shared/permissions.ts:339` at base; candidate lines 339. 1 occurrence.

Now:

```text
This does not increase file, tool, command or network permission by one byte.
```

New:

```text
Your file, tool, command and network permissions remain the limit.
```

Reason: VOICE 6: preserve every named permission boundary without a flourish.

S163. Source: `shared/permissions.ts:341` at base; candidate lines 341. 1 occurrence.

Now:

```text
If the reviewer times out, fails or is unclear, the change set waits for you.
```

New:

```text
Review the change yourself if the reviewer fails, times out or gives an unclear answer.
```

Reason: VOICE 6: preserve reviewer-failure fallback to human review.

S164. Source: `shared/permissions.ts:342` at base; candidate lines 342. 1 occurrence.

Now:

```text
A reviewer decision is recorded as a model decision. It is never recorded as your approval.
```

New:

```text
History attributes the decision to the AI reviewer. Human approval requires your own decision.
```

Reason: VOICE 6: preserve truthful approval provenance without contrast.

S165. Source: `shared/permissions.ts:351` at base; candidate lines 351. 1 occurrence.

Now:

```text
Unrestricted execution needs an isolated environment Diomedes can name, restore and revoke.
```

New:

```text
Unrestricted execution needs an isolated environment Nectovia can name, restore and revoke.
```

Reason: Current product name; preserve owned environment requirements.

S166. Source: `shared/permissions.ts:356` at base; candidate lines 356. 1 occurrence.

Now:

```text
Not offered: no environment on this installation has an operating-system, process or virtual-machine boundary that Diomedes owns.
```

New:

```text
This installation has no isolated environment with an operating-system, process or virtual-machine boundary owned by Nectovia.
```

Reason: VOICE 5 and 6: current product name and direct missing containment reason.

### shared/board-moves.ts

S167. Source: `shared/board-moves.ts:118` at base; candidate lines 118. 1 occurrence.

Now:

```text
It is already admitted. It shows Working once its run has started.
```

New:

```text
This task is already queued or working.
```

Reason: VOICE 6: actual combined target state without admission jargon.

S168. Source: `shared/board-moves.ts:121` at base; candidate lines 121. 1 occurrence.

Now:

```text
It has a run waiting on you. Open it to see what it needs.
```

New:

```text
Open this task to resolve its pending decision.
```

Reason: VOICE 6: direct pending-decision action.

S169. Source: `shared/board-moves.ts:145` at base; candidate lines 145. 1 occurrence.

Now:

```text
Stop this run? The task goes back to Ready and waits for you. Nothing starts in its place.
```

New:

```text
Stop this job and return the task to Ready? Restart it manually when you’re ready.
```

Reason: VOICE 6: retain Ready transition and manual restart requirement without tails.

### shared/stream-rules.ts

S170. Source: `shared/stream-rules.ts:526` at base; candidate lines 526. 1 occurrence.

Now:

```text
Recorded. Nothing else was done.
```

New:

```text
Recorded.
```

Reason: VOICE 6: remove a reassurance tail already implied by the refusal.

S171. Source: `shared/stream-rules.ts:534` at base; candidate lines 534. 1 occurrence.

Now:

```text
Held before it ran; asking you.
```

New:

```text
Approval request pending.
```

Reason: VOICE 6: describe actual pending Need state.

S172. Source: `shared/stream-rules.ts:536` at base; candidate lines 536. 1 occurrence.

Now:

```text
Held before it ran. It waits for your answer.
```

New:

```text
Approve this step to continue.
```

Reason: VOICE 6: direct required step approval.

S173. Source: `shared/stream-rules.ts:538` at base; candidate lines 538. 1 occurrence.

Now:

```text
Held before it ran, then you said go ahead.
```

New:

```text
You approved this step.
```

Reason: VOICE 6: record actual human approval directly.

S174. Source: `shared/stream-rules.ts:540` at base; candidate lines 540. 1 occurrence.

Now:

```text
Held before it ran; you declined, so it never ran.
```

New:

```text
You declined this step.
```

Reason: VOICE 6: record actual decline once.

S175. Source: `shared/stream-rules.ts:541` at base; candidate lines 541. 1 occurrence.

Now:

```text
Held before it ran; the run ended before you answered, so it never ran.
```

New:

```text
The job ended before this step was approved.
```

Reason: VOICE 6: retain ended-without-approval outcome once.

### shared/business-setup.ts

S176. Source: `shared/business-setup.ts:175` at base; candidate lines 175. 1 occurrence.

Now:

```text
Names this workspace and picks which examples you are shown. It selects examples, not authority.
```

New:

```text
Use the name your team recognizes.
```

Reason: VOICE 6: replace label narration with useful input guidance; questionnaire facts remain separate from authorization.

S177. Source: `shared/business-setup.ts:183` at base; candidate lines 183. 1 occurrence.

Now:

```text
Optional. Chooses starting examples only; leave it blank if none fit.
```

New:

```text
Leave this blank if no description fits.
```

Reason: VOICE 6: useful optional-question action.

S178. Source: `shared/business-setup.ts:192` at base; candidate lines 192. 1 occurrence.

Now:

```text
One concrete outcome to start from. Anything unsupported is explained rather than promised.
```

New:

```text
Choose one job your team repeats.
```

Reason: VOICE 6 and AMD-1: direct job input guidance.

S179. Source: `shared/business-setup.ts:203` at base; candidate lines 203. 1 occurrence.

Now:

```text
Records the output and who checks it now. It is a baseline to compare against, not a saving Nectovia claims.
```

New:

```text
Describe the result your team uses today.
```

Reason: VOICE 6: ask for current observable output without policy narration.

S180. Source: `shared/business-setup.ts:211` at base; candidate lines 211. 1 occurrence.

Now:

```text
Describes the sources. Naming one does not connect it or grant access to it.
```

New:

```text
Listing a source describes the job. Connecting it needs separate approval.
```

Reason: VOICE 6: preserve questionnaire-data versus connection authority without implying an unavailable connection step.

S181. Source: `shared/business-setup.ts:230` at base; candidate lines 230. 1 occurrence.

Now:

```text
A proposal about people and approvers. It is confirmed separately; it does not invite anyone or grant a role.
```

New:

```text
These answers identify the people involved. Invitations and roles need separate confirmation.
```

Reason: VOICE 6: preserve questionnaire-data versus invitation and role authority without promising a later UI step.

S182. Source: `shared/business-setup.ts:243` at base; candidate lines 243. 1 occurrence.

Now:

```text
Records labels and what must stay separate. It does not grant anyone access to either.
```

New:

```text
Describe which work needs to stay separate. Access is approved separately.
```

Reason: VOICE 6: keep separation and access approval meanings.

S183. Source: `shared/business-setup.ts:260` at base; candidate lines 260. 1 occurrence.

Now:

```text
Sets where a draft stops and waits. Anything consequential stays conservative by default.
```

New:

```text
Choose the actions that need human approval.
```

Reason: VOICE 6: direct required input without waiting language.

S184. Source: `shared/business-setup.ts:275` at base; candidate lines 275. 1 occurrence.

Now:

```text
Decides which processing routes are allowed. If this is unknown, the risky ones stay closed.
```

New:

```text
If you don’t know, keep the information on this computer.
```

Reason: VOICE 6: preserve conservative data-sharing default as a direct action.

S185. Source: `shared/business-setup.ts:288` at base; candidate lines 288. 1 occurrence.

Now:

```text
Records the host and its hours. Nothing is discovered or scheduled without a separate confirmation.
```

New:

```text
These answers describe computer availability. Starting scheduled work needs separate confirmation.
```

Reason: VOICE 6: preserve questionnaire-data versus schedule activation without instructing an unavailable step.

S186. Source: `shared/business-setup.ts:297` at base; candidate lines 297. 1 occurrence.

Now:

```text
A proposed upper bound in US dollars. It cannot authorise spending, and it is never consent to go over.
```

New:

```text
Enter a proposed limit in US dollars. Spending needs separate authorization.
```

Reason: VOICE 6: retain currency and proposed-limit versus actual spending authority.

### server/software-pack/service.ts

S187. Source: `server/software-pack/service.ts:467` at base; candidate lines 467,631. 1 occurrence.

Now:

```text
You declined. Nothing ran.
```

New:

```text
You declined.
```

Reason: VOICE 6: record the declined command once.

S188. Source: `server/software-pack/service.ts:482` at base; candidate lines 482. 1 occurrence.

Now:

```text
You declined running ${found.command}${where}. Nothing ran.
```

New:

```text
You declined running ${found.command}${where}.
```

Reason: VOICE 6: record the exact declined command once.

### server/engines/model-api-core.ts

S189. Source: `server/engines/model-api-core.ts:174` at base; candidate lines 174. 1 occurrence.

Now:

```text
The model request was addressed somewhere other than the approved ${label} endpoint. Nothing was sent.
```

New:

```text
The request was addressed outside the approved ${label} destination.
```

Reason: Keep the destination restriction; remove redundant pre-dispatch reassurance.

S190. Source: `server/engines/model-api-core.ts:182` at base; candidate lines 182. 1 occurrence.

Now:

```text
This request is larger than the route allows. Nothing was sent.
```

New:

```text
This request exceeds the connection's size limit.
```

Reason: State the size refusal directly; dispatch guard is unchanged.

S191. Source: `server/engines/model-api-core.ts:196` at base; candidate lines 196. 1 occurrence.

Now:

```text
${error instanceof Error ? error.message : 'The payer refused this call.'} Nothing was sent.
```

New:

```text
${error instanceof Error ? error.message : 'The payer refused this call.'}
```

Reason: Keep the exact payer refusal without appending a blanket tail.

S192. Source: `server/engines/model-api-core.ts:538` at base; candidate lines 538. 1 occurrence.

Now:

```text
The conversation and its sources are larger than this route allows. Nothing was sent.
```

New:

```text
The conversation and its sources exceed this connection's size limit.
```

Reason: State the size limit directly.

S193. Source: `server/engines/model-api-core.ts:767` at base; candidate lines 767. 1 occurrence.

Now:

```text
This call’s cache setting is not one Diomedes can send.
```

New:

```text
Nectovia can't use this cache setting.
```

Reason: Use the product name and a direct contraction; keep the cache refusal.

S194. Source: `server/engines/model-api-core.ts:992` at base; candidate lines 992. 1 occurrence.

Now:

```text
${message} Nothing was sent.
```

New:

```text
${message}
```

Reason: Keep the spend refusal exactly; the unknown prior-attempt branch remains distinct.

S195. Source: `server/engines/model-api-core.ts:1188` at base; candidate lines 1188. 1 occurrence.

Now:

```text
The model request could not be prepared. Nothing was sent.
```

New:

```text
The AI request couldn't be prepared.
```

Reason: Contraction and direct failure; preserve no-dispatch branch.

S196. Source: `server/engines/model-api-core.ts:1215` at base; candidate lines 1215. 1 occurrence.

Now:

```text
${label} returned a response Diomedes could not read. Nothing from it was used.
```

New:

```text
${label} returned a response Nectovia couldn't read.
```

Reason: Keep provider response failure; invalid answer isn't rendered and cost outcome remains separate.

S197. Source: `server/engines/model-api-core.ts:1247` at base; candidate lines 1247. 1 occurrence.

Now:

```text
${label} returned output this route does not accept. Nothing from it was used.
```

New:

```text
${label} returned output this connection doesn't accept.
```

Reason: Keep unsupported-output refusal without a repeated tail.

S198. Source: `server/engines/model-api-core.ts:1267` at base; candidate lines 1267. 1 occurrence.

Now:

```text
The ${label} answer did not pass the SDK’s own validation. Nothing from it was used.
```

New:

```text
The ${label} answer failed validation.
```

Reason: Keep validation failure; internal SDK name adds no reader action.

S199. Source: `server/engines/model-api-core.ts:1304` at base; candidate lines 1304. 1 occurrence.

Now:

```text
The SDK’s reading of the answer differs from ${label}’s response. Nothing was used.
```

New:

```text
The checked answer differs from ${label}'s response.
```

Reason: Keep mismatch reason and attribution; the refused answer path is unchanged.

S200. Source: `server/engines/model-api-core.ts:1315` at base; candidate lines 1315. 1 occurrence.

Now:

```text
${label} answered, but Diomedes could not record what it cost. The answer was not used; the call is held as uncertain.
```

New:

```text
${label} answered, but Nectovia couldn't record its cost. The answer wasn't used, and the call's cost remains unconfirmed.
```

Reason: Keep noninferable uncertain paid outcome and unused-answer fact while naming the product correctly.

### server/engines/service.ts

S201. Source: `server/engines/service.ts:383` at base; candidate lines 383. 1 occurrence.

Now:

```text
Diomedes cannot read which installation you chose for this service. Choose one again to continue; the record it could not read is kept.
```

New:

```text
Nectovia can't read your choice of installation. Choose one again to continue.
```

Reason: Remove record-kept tail and use the product name.

S202. Source: `server/engines/service.ts:391` at base; candidate lines 391. 1 occurrence.

Now:

```text
The private copy Diomedes installed no longer matches its reviewed release. It was not run. Repair it to continue.
```

New:

```text
The copy Nectovia installed no longer matches its checked release. Repair it to continue.
```

Reason: Keep integrity mismatch and repair action; don't restate preflight refusal.

S203. Source: `server/engines/service.ts:393` at base; candidate lines 393. 1 occurrence.

Now:

```text
${ENGINE_NAMES[engine]} is installed, but it did not answer when Diomedes checked it. Reinstall or update it, or choose another installation.
```

New:

```text
${ENGINE_NAMES[engine]} is installed, but didn't answer when Nectovia checked it. Update it or choose another installation.
```

Reason: Use product name and concise action without changing discovery truth.

S204. Source: `server/engines/service.ts:1340` at base; candidate lines 1340. 1 occurrence.

Now:

```text
This installation is signed in to a different account. Diomedes uses ${state.routeIssue.required} for this route.
```

New:

```text
This installation is signed in to a different account. Nectovia needs ${state.routeIssue.required} for this connection.
```

Reason: Preserve exact required account identity and correct product name.

S205. Source: `server/engines/service.ts:1431` at base; candidate lines 1431. 1 occurrence.

Now:

```text
That installation did not answer when Diomedes checked it.
```

New:

```text
That installation didn't answer when Nectovia checked it.
```

Reason: Contraction and correct product name.

S206. Source: `server/engines/service.ts:1525` at base; candidate lines 1525. 1 occurrence.

Now:

```text
The service accepted the request and returned nothing. Nothing was verified.
```

New:

```text
The service accepted the request but returned an empty answer. The connection check failed.
```

Reason: Keep accepted request fact and failed verification, without a vague tail.

S207. Source: `server/engines/service.ts:1544` at base; candidate lines 1544. 1 occurrence.

Now:

```text
The service answered, but Diomedes could not record the proof. Nothing was verified.
```

New:

```text
The service answered, but Nectovia couldn't save the connection check.
```

Reason: Keep record failure and verification limitation; retry action is a check, charged-check disclosure stays on screen. Avoid suggesting a repeat paid check when the preceding request was accepted.

S208. Source: `server/engines/service.ts:2358` at base; candidate lines 2358. 1 occurrence.

Now:

```text
The approved ${short} spend limit has no room left. Nothing was sent. The owner can review usage and approve more in AI setup.
```

New:

```text
The approved ${short} spending limit has been reached. The owner can review usage and approve more in AI setup.
```

Reason: Keep owner spending authorization and next action without a preflight tail.

S209. Source: `server/engines/service.ts:2413` at base; candidate lines 2413. 1 occurrence.

Now:

```text
Nectovia is checked by sending it a message. Nothing was sent.
```

New:

```text
Send Nectovia a message to check the connection.
```

Reason: Direct real check action; no synthetic check is implied.

S210. Source: `server/engines/service.ts:2419` at base; candidate lines 2419. 1 occurrence.

Now:

```text
This work has no job Nectovia can meter it under. Nothing was sent.
```

New:

```text
This work has no job Nectovia can charge usage to.
```

Reason: Keep missing billing job refusal; remove preflight tail.

S211. Source: `server/engines/service.ts:2431` at base; candidate lines 2431. 1 occurrence.

Now:

```text
${label} has no Nectovia model right now. Nothing was sent. Choose another tier.
```

New:

```text
${label} is unavailable right now. Choose another tier.
```

Reason: Align confirmed tier failure with the managed service error.

S212. Source: `server/engines/service.ts:2435` at base; candidate lines 2435. 1 occurrence.

Now:

```text
Nectovia now runs ${label} on ${published.label}. Nothing was sent. Send your message again to use it.
```

New:

```text
Nectovia now runs ${label} on ${published.label}. Send your message again to use it.
```

Reason: Keep selected tier/model change and required resend; remove tail.

S213. Source: `server/engines/service.ts:2527` at base; candidate lines 2527. 1 occurrence.

Now:

```text
The ${handle.names.short} connection changed after this message was admitted. Nothing was sent.
```

New:

```text
The ${handle.names.short} connection changed before this message could start.
```

Reason: Keep stale admission connection boundary without jargon or tail.

S214. Source: `server/engines/service.ts:2871,2912` at base; candidate lines 2871,2912. 2 occurrences.

Now:

```text
The selected route changed after this role was admitted. Nothing was sent.
```

New:

```text
The selected connection changed before this worker could start.
```

Reason: Keep stale role admission boundary without technical narration.

S215. Source: `server/engines/service.ts:3408` at base; candidate lines 3408. 1 occurrence.

Now:

```text
The saved Google Vertex AI key is missing or not the one connected. Connect it again in AI setup. Nothing was sent.
```

New:

```text
The saved Google Vertex AI key is missing or doesn't match the connection. Connect it again in AI setup.
```

Reason: Preserve credential identity mismatch and owner action.

S216. Source: `server/engines/service.ts:3412` at base; candidate lines 3412. 1 occurrence.

Now:

```text
No Google Application Default Credentials were found on this computer. Run `gcloud auth application-default login`, then verify Google Vertex AI in AI setup. Nothing was sent.
```

New:

```text
No Google Application Default Credentials were found on this computer. Run `gcloud auth application-default login`, then verify Google Vertex AI in AI setup.
```

Reason: Keep exact owner setup command and credential requirement without tail.

S217. Source: `server/engines/service.ts:3414` at base; candidate lines 3414. 1 occurrence.

Now:

```text
The Google credential on this computer is not the one Google Vertex AI was verified with. Verify it again in AI setup. Nothing was sent.
```

New:

```text
The Google credential on this computer doesn't match the one checked for Google Vertex AI. Verify it again in AI setup.
```

Reason: Preserve credential mismatch and required verification.

### server/organization-setup.ts

S218. Source: `server/organization-setup.ts:69` at base; candidate lines 69. 1 occurrence.

Now:

```text
This computer couldn't open its copy of this business's setup. Nothing was reset. Try again.
```

New:

```text
This computer couldn't open its copy of this business's setup. Try again.
```

Reason: Direct load failure; remove reset reassurance.

### server/spend-exposure.ts

S219. Source: `server/spend-exposure.ts:219` at base; candidate lines 219. 1 occurrence.

Now:

```text
This job has used or holds ${formatMoney(usedMicroUsd)} of its ${formatMoney(capMicroUsd)} cap, and its next step could take it to ${formatMoney(neededMicroUsd)}. It stopped before that step; nothing more was sent.
```

New:

```text
This job has used or holds ${formatMoney(usedMicroUsd)} of its ${formatMoney(capMicroUsd)} cap. Its next step could take it to ${formatMoney(neededMicroUsd)}, so it stopped before that step.
```

Reason: Preserve precise used-plus-held exposure and blocked next step, with one consequence.

S220. Source: `server/spend-exposure.ts:236` at base; candidate lines 236. 1 occurrence.

Now:

```text
This run has used or holds ${formatMoney(usedMicroUsd)} of its ${formatMoney(capMicroUsd)} allocation, and its next step could take it to ${formatMoney(neededMicroUsd)}. Nothing more was held or sent.
```

New:

```text
This run has used or holds ${formatMoney(usedMicroUsd)} of its ${formatMoney(capMicroUsd)} allocation. Its next step could take it to ${formatMoney(neededMicroUsd)}, so it stopped before that step.
```

Reason: Preserve allocation/exposure truth and clarify refusal, without blanket no-effect tail.

### server/engines/read-connector-routes.ts

S221. Source: `server/engines/read-connector-routes.ts:148` at base; candidate lines 148. 1 occurrence.

Now:

```text
${READ_CONNECTORS_FILE} in the data folder cannot be read. Fix or remove it; nothing here will write over it.
```

New:

```text
${READ_CONNECTORS_FILE} in the data folder can't be read. Fix or remove it.
```

Reason: Keep exact repair action and filename; remove tail.

S222. Source: `server/engines/read-connector-routes.ts:183` at base; candidate lines 183. 1 occurrence.

Now:

```text
${READ_CONNECTORS_FILE} in the data folder cannot be read. Fix or remove it first; nothing was changed.
```

New:

```text
${READ_CONNECTORS_FILE} in the data folder can't be read. Fix or remove it first.
```

Reason: Keep malformed-configuration refusal and prerequisite.

### shared/configuration.ts

S223. Source: `shared/configuration.ts:161` at base; candidate lines 161. 1 occurrence.

Now:

```text
Waiting for you to allow it
```

New:

```text
Needs your approval
```

Reason: Use a direct authorization state, not assistant waiting voice.

S224. Source: `shared/configuration.ts:738` at base; candidate lines 738. 1 occurrence.

Now:

```text
Nothing was named as needing a person first, so everything keeps stopping for review.
```

New:

```text
No actions were assigned an approver. All actions need review.
```

Reason: Preserve fail-closed questionnaire approval meaning.

S225. Source: `shared/configuration.ts:967` at base; candidate lines 967. 1 occurrence.

Now:

```text
What waits for a person
```

New:

```text
What needs approval
```

Reason: Name approval requirement directly.

S226. Source: `shared/configuration.ts:1084` at base; candidate lines 1084. 1 occurrence.

Now:

```text
Going back restores the previous setup on this computer. It cannot undo invitations, connections or anything already sent, and it cannot bring back access that was taken away.
```

New:

```text
Going back restores the previous setup on this computer. Invitations, connections, sent items and revoked access remain as they are.
```

Reason: Keep all irreversible rollback boundaries; remove stacked negative framing.

### shared/execution.ts

S227. Source: `shared/execution.ts:83` at base; candidate lines 83. 1 occurrence.

Now:

```text
Nothing checked ${gate} for this work.
```

New:

```text
The ${gate} check is missing for this work.
```

Reason: Keep exact required missing gate, with a direct absence.

S228. Source: `shared/execution.ts:138` at base; candidate lines 138. 1 occurrence.

Now:

```text
This work runs on your machine and is not billed to anyone.
```

New:

```text
This work runs on this computer without a usage charge.
```

Reason: Keep local payer classification and actual charge boundary.

S229. Source: `shared/execution.ts:153` at base; candidate lines 153. 1 occurrence.

Now:

```text
This runs through the account signed in on this computer, not through business usage. What it costs appears on that account.
```

New:

```text
The account signed in on this computer pays for this work.
```

Reason: Keep BYO versus included business payer distinction positively.

S230. Source: `shared/execution.ts:192` at base; candidate lines 192. 1 occurrence.

Now:

```text
This setup does not allow a different model to pick the work up. Nothing was changed.
```

New:

```text
This setup doesn't allow another AI to continue the work.
```

Reason: Keep fallback prohibition without idiom/tail.

S231. Source: `shared/execution.ts:205` at base; candidate lines 205. 1 occurrence.

Now:

```text
This work has to stay on this computer, and no local model is available. It was stopped rather than sent to a cloud service.
```

New:

```text
This work must stay on this computer. It stopped because no local AI is available.
```

Reason: Preserve local-only policy and refusal; no cloud fallback implied.

S232. Source: `shared/execution.ts:210` at base; candidate lines 210. 1 occurrence.

Now:

```text
There is no allowance left, so no other model was started.
```

New:

```text
There is no usage allowance left to continue this work.
```

Reason: Keep lack of funded allowance as refusal cause.

S233. Source: `shared/execution.ts:214` at base; candidate lines 214. 1 occurrence.

Now:

```text
No other available model can do this work. Nothing was changed.
```

New:

```text
No other available AI can do this work.
```

Reason: Direct unavailable fallback without tail.

S234. Source: `shared/execution.ts:358` at base; candidate lines 358. 1 occurrence.

Now:

```text
${sentenceFor(stopping)} Nothing was changed. Start the work again to continue under what is true now.
```

New:

```text
${sentenceFor(stopping)} Start the work again to use the current setup.
```

Reason: Keep authoritative stop reason and restart requirement.

S235. Source: `shared/execution.ts:473` at base; candidate lines 473. 1 occurrence.

Now:

```text
The runtime did not report which model answered, so it is not recorded.
```

New:

```text
The answering model wasn't reported.
```

Reason: Keep truthful absent attribution; do not infer the requested model answered.

S236. Source: `shared/execution.ts:492` at base; candidate lines 492. 1 occurrence.

Now:

```text
Nothing was changed yet.
```

New:

```text
No change recorded.
```

Reason: Do not infer no physical change from missing effect evidence.

S237. Source: `shared/execution.ts:493` at base; candidate lines 493. 1 occurrence.

Now:

```text
This has not been checked yet.
```

New:

```text
No check recorded.
```

Reason: State missing evidence, without version/time status.

S238. Source: `shared/execution.ts:496` at base; candidate lines 496. 1 occurrence.

Now:

```text
Nobody reviewed this.
```

New:

```text
No reviewer recorded.
```

Reason: State missing evidence, without claiming absent real review.

S239. Source: `shared/execution.ts:497` at base; candidate lines 497. 1 occurrence.

Now:

```text
Nothing has been written.
```

New:

```text
No writer recorded.
```

Reason: State missing evidence, without claiming absent physical effects.

S240. Source: `shared/execution.ts:498` at base; candidate lines 498. 1 occurrence.

Now:

```text
Nobody has checked the result.
```

New:

```text
No verifier recorded.
```

Reason: State missing evidence, without claiming absent real verification.

### shared/handoff.ts

S241. Source: `shared/handoff.ts:115` at base; candidate lines 115. 1 occurrence.

Now:

```text
This work has already been passed on far enough. Diomedes stops after ${MAX_DELEGATION_DEPTH} steps so a job cannot keep starting more of itself.
```

New:

```text
This work has reached Nectovia's limit of ${MAX_DELEGATION_DEPTH} delegation steps.
```

Reason: Keep exact bounded delegation limit; remove explanation of recursive mechanism.

S242. Source: `shared/handoff.ts:120` at base; candidate lines 120. 1 occurrence.

Now:

```text
This step already has ${MAX_CHILDREN_PER_HANDOFF} workers, which is as many as Diomedes runs at once.
```

New:

```text
This step has reached Nectovia's limit of ${MAX_CHILDREN_PER_HANDOFF} workers.
```

Reason: Keep exact concurrent worker limit and product name.

S243. Source: `shared/handoff.ts:185` at base; candidate lines 185. 1 occurrence.

Now:

```text
This work belongs to a different business than the worker being asked to continue it. Nothing was shared.
```

New:

```text
This work and the worker asked to continue it belong to different businesses.
```

Reason: Keep exact tenant mismatch; remove tail.

S244. Source: `shared/handoff.ts:198` at base; candidate lines 198. 1 occurrence.

Now:

```text
This step needs ${missing.join(', ')}, which that worker does not hold. Being on the team is not permission.
```

New:

```text
This step needs ${missing.join(', ')}, which this worker isn't allowed to use.
```

Reason: Preserve missing worker authority; the team membership slogan adds no permission meaning.

### shared/organization-setup.ts

S245. Source: `shared/organization-setup.ts:195` at base; candidate lines 195. 1 occurrence.

Now:

```text
The account service can't be reached, so this business's saved setup couldn't be loaded. Nothing was reset. Try again when the connection is back.
```

New:

```text
The account service can't be reached, so this business's saved setup couldn't be loaded. Try again when the connection is back.
```

Reason: Keep unavailable saved setup, no reset inference needed.

S246. Source: `shared/organization-setup.ts:237` at base; candidate lines 237. 1 occurrence.

Now:

```text
The account service answered for a different business. Nothing was loaded.
```

New:

```text
The account service answered for a different business.
```

Reason: Keep tenant mismatch refusal.

### shared/setup-question-changes.ts

S247. Source: `shared/setup-question-changes.ts:61` at base; candidate lines 61. 1 occurrence.

Now:

```text
This setup was saved by a newer version of Nectovia, which asks different questions. Update Nectovia on this computer to continue it. Nothing in it was changed.
```

New:

```text
This setup was saved by a newer version of Nectovia, which asks different questions. Update Nectovia on this computer to continue it.
```

Reason: Keep version compatibility and explicit update action.

S248. Source: `shared/setup-question-changes.ts:65` at base; candidate lines 65. 1 occurrence.

Now:

```text
This setup was saved in a form this version of Nectovia can't read, so it can't be continued here. Nothing in it was changed.
```

New:

```text
This version of Nectovia can't read or continue the saved setup.
```

Reason: Direct unsupported setup form without reassurance tail. Do not promise that updating repairs an unknown saved format.

### shared/session-controls.ts

S249. Source: `shared/session-controls.ts:111` at base; candidate lines 111. 1 occurrence.

Now:

```text
Held, then sent through ordinary Work admission after this turn or the task.
```

New:

```text
Sent after the current answer or task finishes, with the usual permission and spending checks.
```

Reason: Preserve actual host queue and admission checks, avoid implying live steering.

S250. Source: `shared/session-controls.ts:126,129,130,131` at base; candidate lines 126,129,130,131. 4 occurrences.

Now:

```text
No route contract is registered for this route.
```

New:

```text
This connection doesn't support this control.
```

Reason: Keep unsupported control outcome; registered contract is implementation detail.

### shared/workspaces.ts

S251. Source: `shared/workspaces.ts:386` at base; candidate lines 386. 1 occurrence.

Now:

```text
Choose the project ${organization.name} writes into. Its work is saved there for review, and nothing is written anywhere else.
```

New:

```text
Choose the project where ${organization.name} saves its work for review.
```

Reason: Keep required business output project selection; remove tail.

### shared/agent-profiles.ts

S252. Source: `shared/agent-profiles.ts:170` at base; candidate lines 170. 1 occurrence.

Now:

```text
${first.name} cannot run: ${first.reason} Fallback is off for this ${
```

New:

```text
${first.name} can't run. ${first.reason} Fallback is off for this ${
```

Reason: Preserve exact first-profile refusal and fallback prohibition.

S253. Source: `shared/agent-profiles.ts:172` at base; candidate lines 172. 1 occurrence.

Now:

```text
}, so no other profile was tried.
```

New:

```text
}.
```

Reason: The preceding fallback-is-off clause already states the no-fallback fact.

### server/managed-usage-routes.ts

S254. Source: `server/managed-usage-routes.ts:84` at base; candidate lines 84. 1 occurrence.

Now:

```text
This app is not signed in to a Nectovia account, so it cannot read this business’s credit usage. Nothing is estimated in its place.
```

New:

```text
Sign in to Nectovia to read this business's credit usage.
```

Reason: Action replaces missing-sign-in explanation and reassurance.

S255. Source: `server/managed-usage-routes.ts:313` at base; candidate lines 313. 1 occurrence.

Now:

```text
The account service couldn’t say what this business has bought, so nothing is shown. Nothing is estimated in its place.
```

New:

```text
The account service couldn't confirm this business's purchases.
```

Reason: Keep unavailable purchase evidence; don't present a guessed balance.

S256. Source: `server/managed-usage-routes.ts:479` at base; candidate lines 479. 1 occurrence.

Now:

```text
The account service couldn’t say what this business has used, so nothing is shown. Nothing is estimated in its place.
```

New:

```text
The account service couldn't confirm this business's usage.
```

Reason: Keep unknown usage evidence; remove doubled no-estimate tail.

### server/managed-usage.ts

S257. Source: `server/managed-usage.ts:404` at base; candidate lines 404. 1 occurrence.

Now:

```text
That call settled at ${formatMoney(input.allowanceDebitMicroUsd)}, past its ${formatMoney(reservation.maxMicroUsd)} ceiling. This is a reconciliation problem, not a rounding one.
```

New:

```text
That call settled at ${formatMoney(input.allowanceDebitMicroUsd)}, past its ${formatMoney(reservation.maxMicroUsd)} ceiling. Check the usage record.
```

Reason: Keep exact settlement-over-ceiling discrepancy, remove slogan-like rounding contrast.

S258. Source: `server/managed-usage.ts:360` at base; candidate lines 360. 1 occurrence.

Now:

```text
The parent task cannot afford a ${formatMoney(input.maxMicroUsd)} hold inside its ${formatMoney(input.parentEnvelopeMicroUsd)} envelope with ${formatMoney(used)} already held. Settle work under it first, or raise the envelope.
```

New:

```text
The parent task can't cover a ${formatMoney(input.maxMicroUsd)} hold within its ${formatMoney(input.parentEnvelopeMicroUsd)} spending limit while ${formatMoney(used)} is already held. Settle its work first, or raise its spending limit.
```

Reason: Keep requested hold, cap, existing hold and authorized corrective actions. Keep original interpolation order as well as requested hold, parent cap and held amount.

### server/engines/acp-client.ts

S259. Source: `server/engines/acp-client.ts:1117` at base; candidate lines 1117. 1 occurrence.

Now:

```text
${name} reported a service limit. No model or account was substituted.
```

New:

```text
${name} reported a service limit.
```

Reason: Keep upstream limit; no fallback detail is already enforced by selected connection.

### server/engines/claude.ts

S260. Source: `server/engines/claude.ts:157` at base; candidate lines 157. 1 occurrence.

Now:

```text
Team tools ride only on a single Work turn, never with a read scope or a native session.
```

New:

```text
Team tools are available only in a single Work turn without a read scope or native session.
```

Reason: Preserve actual unsupported scopes; replace 'ride' idiom. Keep these unsupported contexts prohibited; separate approval cannot make them available.

### server/engines/cursor.ts

S261. Source: `server/engines/cursor.ts:461` at base; candidate lines 461. 1 occurrence.

Now:

```text
Cursor no longer offers the requested model. No substitute was selected.
```

New:

```text
Cursor no longer offers the requested model. Choose another model.
```

Reason: Keep exact unavailable selection and human choice.

### server/engines/devin.ts

S262. Source: `server/engines/devin.ts:429` at base; candidate lines 429. 1 occurrence.

Now:

```text
Devin no longer offers the requested model. No substitute was selected.
```

New:

```text
Devin no longer offers the requested model. Choose another model.
```

Reason: Keep exact unavailable selection and human choice.

### server/engines/opencode.ts

S263. Source: `server/engines/opencode.ts:381` at base; candidate lines 381. 1 occurrence.

Now:

```text
Diomedes could not authenticate to the OpenCode server it started. No account was reached, so nothing here is known about its sign-in.
```

New:

```text
Nectovia couldn't connect to its OpenCode server, so it couldn't check the account's sign-in.
```

Reason: Keep failed local authentication and unknown native account state.

S264. Source: `server/engines/opencode.ts:390,436,489` at base; candidate lines 390,436,489. 3 occurrences.

Now:

```text
OpenCode reported a service limit. No provider or model was substituted.
```

New:

```text
OpenCode reported a service limit.
```

Reason: State upstream limit without repeating selected-service guarantees.

S265. Source: `server/engines/opencode.ts:1050` at base; candidate lines 1050. 1 occurrence.

Now:

```text
OpenCode reported an assistant error.
```

New:

```text
OpenCode couldn't complete the answer.
```

Reason: Product error clarity without calling Nectovia an assistant.

### server/engines/model-api-routes.ts

S266. Source: `server/engines/model-api-routes.ts:123` at base; candidate lines 123. 1 occurrence.

Now:

```text
Open the Diomedes desktop app to connect AWS: this process has no protected credential storage.
```

New:

```text
Open the Nectovia desktop app to connect AWS and save its credentials securely.
```

Reason: Keep real desktop protected-storage requirement and correct product name.

S267. Source: `server/engines/model-api-routes.ts:198` at base; candidate lines 198. 1 occurrence.

Now:

```text
Protected credential storage is available only in the Diomedes desktop app. Nothing was saved.
```

New:

```text
Open the Nectovia desktop app to save credentials securely.
```

Reason: Keep required secure desktop action; no preflight tail.

S268. Source: `server/engines/model-api-routes.ts:166` at base; candidate lines 166. 1 occurrence.

Now:

```text
Estimated from AWS list prices and the usage AWS reports for each call. It is Diomedes’ own limit, not an AWS billing cap, and not your invoice.
```

New:

```text
Estimated from AWS list prices and reported usage. This Nectovia spending limit applies separately from AWS billing; your invoice comes from AWS.
```

Reason: Keep estimate versus actual provider bill and actual separate cap ownership.

### server/engines/provider-routes.ts

S269. Source: `server/engines/provider-routes.ts:221` at base; candidate lines 221. 1 occurrence.

Now:

```text
Open the Diomedes desktop app to connect ${spec.label}: this process has no protected credential storage.
```

New:

```text
Open the Nectovia desktop app to connect ${spec.label} and save its credentials securely.
```

Reason: Preserve required secure desktop setup.

S270. Source: `server/engines/provider-routes.ts:278,673` at base; candidate lines 278,673. 2 occurrences.

Now:

```text
Protected credential storage is available only in the Diomedes desktop app. Nothing was saved.
```

New:

```text
Open the Nectovia desktop app to save credentials securely.
```

Reason: Keep secure storage prerequisite without tail.

S271. Source: `server/engines/provider-routes.ts:241` at base; candidate lines 241. 1 occurrence.

Now:

```text
Estimated from the prices you declared and the usage ${spec.label} reports for each call. It is Diomedes’ own limit, not a ${spec.label} billing cap, and not your invoice.
```

New:

```text
Estimated from the prices you entered and the usage ${spec.label} reports. This Nectovia spending limit applies separately from ${spec.label} billing; your invoice comes from that service.
```

Reason: Keep owner-declared rate estimate and separate upstream billing. Keep both provider-label interpolations and explicit provider-reported usage attribution.

S272. Source: `server/engines/provider-routes.ts:121` at base; candidate lines 121. 1 occurrence.

Now:

```text
Name the model, for example gpt-6-luna.
```

New:

```text
Enter the model name exactly as Azure shows it.
```

Reason: Remove stale model codename example; preserve technical owner-input precision.

S273. Source: `server/engines/provider-routes.ts:337` at base; candidate lines 337. 1 occurrence.

Now:

```text
No request was sent to ${spec.label}. This checks the saved connection, key and spend limit only; whether ${spec.label} accepts the key is known only from a real call.
```

New:

```text
No request was sent to ${spec.label}. These checks cover the saved connection, key and spending limit. A real request confirms whether ${spec.label} accepts the key.
```

Reason: Keep noninferable local-check versus real accepted request boundary; split dense sentence.

S274. Source: `server/engines/provider-routes.ts:677` at base; candidate lines 677. 1 occurrence.

Now:

```text
No Google Application Default Credentials were found on this computer. Enter an API key from the project, or run `gcloud auth application-default login` first. Nothing was saved.
```

New:

```text
No Google Application Default Credentials were found on this computer. Enter an API key from the project, or run `gcloud auth application-default login` first.
```

Reason: Keep exact owner credential setup choices.

### server/harness/bridge.ts

S275. Source: `server/harness/bridge.ts:658` at base; candidate lines 658,680. 1 occurrence.

Now:

```text
This approval window expired. The run is still waiting.
```

New:

```text
This approval window expired.
```

Reason: Actual expiry is the refusal; no assistant waiting narration.

S276. Source: `server/harness/bridge.ts:284` at base; candidate lines 284. 1 occurrence.

Now:

```text
The native run could not start. No report was written.
```

New:

```text
The native job couldn't start.
```

Reason: Keep start failure; report absence is inferred and record remains unchanged.

### server/harness/host.ts

S277. Source: `server/harness/host.ts:331` at base; candidate lines 331. 1 occurrence.

Now:

```text
This run id appears in more than one project. Its files were left unchanged.
```

New:

```text
This run id appears in more than one project.
```

Reason: Keep duplicate identity refusal; remove refusal-state reassurance. Retain exact run identity and don't imply an unsupported user repair control.

### server/supervision/ladder.ts

S278. Source: `server/supervision/ladder.ts:110,114` at base; candidate lines 110,114. 2 occurrences.

Now:

```text
An escalation about this is already waiting for you.
```

New:

```text
This issue already needs your decision.
```

Reason: Direct existing escalation requirement, no waiting voice.

S279. Source: `server/supervision/ladder.ts:113` at base; candidate lines 113. 1 occurrence.

Now:

```text
An escalation about this is already waiting for you on an earlier run, so it is noted here, not raised again.
```

New:

```text
This issue already needs your decision on an earlier job. It was noted on this job.
```

Reason: Keep duplicate escalation semantics without repeated issue raising.

S280. Source: `server/supervision/ladder.ts:204` at base; candidate lines 204. 1 occurrence.

Now:

```text
Worth recording; not yet something to act on.
```

New:

```text
Recorded for review.
```

Reason: Keep note rung without 'worth' language.

S281. Source: `server/supervision/ladder.ts:174` at base; candidate lines 174. 1 occurrence.

Now:

```text
This detector declares no correction, so the run is paused for you.
```

New:

```text
No automatic correction is available. Review the paused job.
```

Reason: Keep lack of authorized correction and human intervention.

### server/sandbox/change-sets.ts

S282. Source: `server/sandbox/change-sets.ts:350` at base; candidate lines 350. 1 occurrence.

Now:

```text
Keep writes a change to the project as yours, checked against the version the sub-task started from. Discard leaves the project as it is. Nothing changes until you decide.
```

New:

```text
Keep saves a change as yours after checking against the file version the sub-task started from. Discard declines the proposed change.
```

Reason: VOICE 6: keep human authorship and original-version checking. Discard records a decline and preserves the proposal; it does not remove it.

### server/team/board.ts

S283. Source: `server/team/board.ts:104` at base; candidate lines 104. 1 occurrence.

Now:

```text
Cannot complete '${subject}': an open Need (${openNeed.id}) is waiting for the owner.
```

New:

```text
Can't complete '${subject}'. The owner must answer Need ${openNeed.id}.
```

Reason: Keep exact open Need id and required owner decision.

### server/team/service.ts

S284. Source: `server/team/service.ts:431` at base; candidate lines 431. 1 occurrence.

Now:

```text
Nothing is waiting for this helper.
```

New:

```text
This helper has no pending work.
```

Reason: Actual absence of pending work, not assistant waiting prose.

### server/verification/service.ts

S285. Source: `server/verification/service.ts:545` at base; candidate lines 545. 1 occurrence.

Now:

```text
The reviewer answered without a readable verdict; prose is never a verdict.
```

New:

```text
The reviewer answered without a readable verdict.
```

Reason: Keep unverified result; remove aphoristic tail.

### server/native-loop-routes.ts

S286. Source: `server/native-loop-routes.ts:312` at base; candidate lines 312. 1 occurrence.

Now:

```text
A Nectovia loop can’t take a delegate or a team you name. Nothing was sent.
```

New:

```text
A Nectovia job can't use a delegate or team you name.
```

Reason: Keep exact managed-delegation limit without sending tail.

S287. Source: `server/native-loop-routes.ts:395,549` at base; candidate lines 395,549. 2 occurrences.

Now:

```text
The Nectovia model is managed. Send without choosing one.
```

New:

```text
Nectovia chooses the AI for this job. Send without choosing a model.
```

Reason: Keep managed model-selection refusal and clear action.

### server/workspaces.ts

S288. Source: `server/workspaces.ts:1353` at base; candidate lines 1353. 1 occurrence.

Now:

```text
This workspace already has a saved setup. Resume it rather than starting a second one.
```

New:

```text
This workspace already has a saved setup. Resume it to continue.
```

Reason: Keep existing setup reuse requirement; remove rhetorical contrast.

S289. Source: `server/workspaces.ts:1088` at base; candidate lines 1088. 1 occurrence.

Now:

```text
An owner or administrator sets this workspace up. You join the configuration they have already made.
```

New:

```text
An owner or administrator sets up this business.
```

Reason: Keep actual configurator requirement; remove narration of joining.

### server/review-comments.ts

S290. Source: `server/review-comments.ts:155` at base; candidate lines 155. 1 occurrence.

Now:

```text
A comment on a file version is about a line of that version.
```

New:

```text
Choose a line in this file version to comment on.
```

Reason: Direct required selected-version action.

### server/ready-scheduler.ts

S291. Source: `server/ready-scheduler.ts:104` at base; candidate lines 104. 1 occurrence.

Now:

```text
The saved Ready queue pause is unreadable. Nothing was rewritten.
```

New:

```text
The saved Ready queue pause couldn't be read.
```

Reason: Keep persisted state load failure without tail.

### server/models.ts

S292. Source: `server/models.ts:98` at base; candidate lines 98. 1 occurrence.

Now:

```text
Codex has not written its list yet. It appears after the next Codex run.
```

New:

```text
Codex hasn't reported its models. Send a message to refresh the list.
```

Reason: Keep source-reported model absence and actual refresh trigger.

### services/control-plane/src/commercial.ts

S293. Source: `services/control-plane/src/commercial.ts:831` at base; candidate lines 831. 1 occurrence.

Now:

```text
Managed Personal work requires a current Nectovia client and scoped admission. Nothing was sent.
```

New:

```text
Managed Personal work requires a current Nectovia app and scoped admission.
```

Reason: Keep account-bound admission requirement; do not imply UI approval replaces it. Retain exact scoped admission requirement; user approval cannot replace service admission.

### services/control-plane/src/funding.ts

S294. Source: `services/control-plane/src/funding.ts:1100` at base; candidate lines 1100. 1 occurrence.

Now:

```text
This billing period has ended, so its credits fund nothing new. Nothing was reserved.
```

New:

```text
This billing period has ended. Its credits can't fund new work.
```

Reason: Preserve expiration/refusal without redundant hold tail.

S295. Source: `services/control-plane/src/funding.ts:1218` at base; candidate lines 1218. 1 occurrence.

Now:

```text
This billing period ended before the request was sent. Nothing was sent, and its hold was released.
```

New:

```text
This billing period ended before the request could be sent. Its usage hold was released.
```

Reason: Keep timing and noninferable released hold; remove duplicate no-send sentence.

### services/control-plane/src/managed-inference.ts

S296. Source: `services/control-plane/src/managed-inference.ts:334` at base; candidate lines 334. 1 occurrence.

Now:

```text
Nectovia’s model service isn’t available right now. Nothing was charged.
```

New:

```text
Nectovia's AI service isn't available right now.
```

Reason: Match app preflight unavailable service copy; cost outcomes and releases remain unchanged.

S297. Source: `services/control-plane/src/managed-inference.ts:337` at base; candidate lines 337. 1 occurrence.

Now:

```text
${FEATURE_LABELS['managed-inference']} isn’t part of this business’s plan, so the Nectovia Agent can’t answer here. Nothing was charged.
```

New:

```text
${FEATURE_LABELS['managed-inference']} isn't part of this business's plan, so the Nectovia Agent can't answer here.
```

Reason: Keep plan entitlement refusal and label contract; remove no-charge tail.

S298. Source: `services/control-plane/src/managed-inference.ts:341` at base; candidate lines 341. 1 occurrence.

Now:

```text
No provider that meets Nectovia’s data policy can take this right now. Nothing was charged.
```

New:

```text
No AI service that meets Nectovia's data policy is available right now.
```

Reason: Preserve data policy refusal; no weaker fallback is implied.

S299. Source: `services/control-plane/src/managed-inference.ts:1453` at base; candidate lines 1453. 1 occurrence.

Now:

```text
Your Individual billing period could not be confirmed, so nothing was reserved. Nothing was sent.
```

New:

```text
Your Individual billing period couldn't be confirmed.
```

Reason: Keep unknown billing-period refusal and Individual boundary.

### services/control-plane/src/routing.ts

S300. Source: `services/control-plane/src/routing.ts:228` at base; candidate lines 228. 1 occurrence.

Now:

```text
This account does not include managed AI usage. Nothing was sent.
```

New:

```text
This account doesn't include managed AI usage.
```

Reason: Keep account entitlement refusal.

S301. Source: `services/control-plane/src/routing.ts:248` at base; candidate lines 248. 1 occurrence.

Now:

```text
Your Individual billing period could not be confirmed. Nothing was sent.
```

New:

```text
Your Individual billing period couldn't be confirmed.
```

Reason: Keep unknown current billing-period refusal.

### services/control-plane/src/managed-bindings.ts

S302. Source: `services/control-plane/src/managed-bindings.ts:262` at base; candidate lines 262. 1 occurrence.

Now:

```text
A native checkpoint requires its authenticated account scope. Nothing was sent.
```

New:

```text
A native checkpoint requires its authenticated account scope.
```

Reason: Preserve exact authenticated account requirement; remove tail.

### services/control-plane/src/organization-setup/service.ts

S303. Source: `services/control-plane/src/organization-setup/service.ts:66` at base; candidate lines 66. 1 occurrence.

Now:

```text
This business's setup was saved by a newer version of Nectovia, which asks different questions. Update Nectovia to continue it. Nothing was changed.
```

New:

```text
This business's setup was saved by a newer version of Nectovia, which asks different questions. Update Nectovia to continue it.
```

Reason: Keep persisted schema version safeguard and real update requirement.

### server/accounts/routing-session.ts

S304. Source: `server/accounts/routing-session.ts:61,70` at base; candidate lines 61,70. 2 occurrences.

Now:

```text
The signed-in account changed. Nothing was sent.
```

New:

```text
The signed-in account changed.
```

Reason: Keep the exact preflight account or plan refusal; remove redundant no-send tail. Account identity and admission logic remain unchanged.

S305. Source: `server/accounts/routing-session.ts:200,205` at base; candidate lines 92,200,205. 2 occurrences.

Now:

```text
The account owning this work changed. Nothing was sent.
```

New:

```text
The account owning this work changed.
```

Reason: Keep the exact preflight account or plan refusal; remove redundant no-send tail. Account identity and admission logic remain unchanged.

S306. Source: `server/accounts/routing-session.ts:227` at base; candidate lines 227. 1 occurrence.

Now:

```text
This work has no authorized account. Nothing was sent.
```

New:

```text
This work has no authorized account.
```

Reason: Keep the exact preflight account or plan refusal; remove redundant no-send tail. Account identity and admission logic remain unchanged.

S307. Source: `server/accounts/routing-session.ts:256` at base; candidate lines 256. 1 occurrence.

Now:

```text
The account service could not be reached, so the Nectovia Agent could not confirm your plan includes it. Nothing was sent.
```

New:

```text
The account service couldn't be reached, so the Nectovia Agent couldn't confirm your plan includes it.
```

Reason: Keep the exact preflight account or plan refusal; remove redundant no-send tail. Account identity and admission logic remain unchanged.

S308. Source: `server/accounts/routing-session.ts:257` at base; candidate lines 257. 1 occurrence.

Now:

```text
The account service could not be reached, so the Nectovia Agent could not confirm this business includes it. Nothing was sent.
```

New:

```text
The account service couldn't be reached, so the Nectovia Agent couldn't confirm this business's plan includes it.
```

Reason: Keep the exact preflight account or plan refusal; remove redundant no-send tail. Account identity and admission logic remain unchanged.

S309. Source: `server/accounts/routing-session.ts:265` at base; candidate lines 265. 1 occurrence.

Now:

```text
The account service did not return a current admission for this work. Nothing was sent.
```

New:

```text
The account service didn't return a current admission for this work.
```

Reason: Keep the exact preflight account or plan refusal; remove redundant no-send tail. Account identity and admission logic remain unchanged.

S310. Source: `server/accounts/routing-session.ts:278` at base; candidate lines 278. 1 occurrence.

Now:

```text
The account service did not return a current Individual billing period for this work. Nothing was sent.
```

New:

```text
The account service didn't return a current Individual billing period for this work.
```

Reason: Keep the exact preflight account or plan refusal; remove redundant no-send tail. Account identity and admission logic remain unchanged.

### server/usage.ts

S311. Source: `server/usage.ts:22` at base; candidate lines 22. 1 occurrence.

Now:

```text
Codex has not reported its allowance yet. It appears after the next connection check or turn.
```

New:

```text
Codex hasn't reported its allowance. It refreshes after a connection check or answer.
```

Reason: Keep the exact source and refresh event; use a contraction and omit status-in-prose 'yet'.

S312. Source: `server/usage.ts:23` at base; candidate lines 23. 1 occurrence.

Now:

```text
Claude Code reports cost per answer; a plan window is not available yet.
```

New:

```text
Claude Code reports each answer's cost. Its remaining plan allowance isn't available here.
```

Reason: Keep actual reported cost versus unavailable allowance, without development-status prose.

S313. Source: `server/usage.ts:24` at base; candidate lines 24. 1 occurrence.

Now:

```text
OpenCode does not report what is left on the Go plan. See your OpenCode account.
```

New:

```text
OpenCode doesn't report the Go plan's remaining allowance. Check your OpenCode account.
```

Reason: Preserve owned account and plan boundary.

S314. Source: `server/usage.ts:25` at base; candidate lines 25. 1 occurrence.

Now:

```text
oh-my-pi keeps its own counts where it runs; nothing is reported here yet.
```

New:

```text
oh-my-pi keeps its usage counts in its own process. They aren't reported here.
```

Reason: Keep external process reporting boundary without 'yet'.

S315. Source: `server/usage.ts:26` at base; candidate lines 26. 1 occurrence.

Now:

```text
Cursor is reported as installed; no allowance is reported here yet.
```

New:

```text
Cursor hasn't reported its allowance.
```

Reason: The tool's installed status is already separate; keep missing usage evidence.

S316. Source: `server/usage.ts:27` at base; candidate lines 27. 1 occurrence.

Now:

```text
Devin is reported as installed; no allowance is reported here yet.
```

New:

```text
Devin hasn't reported its allowance.
```

Reason: The installed status is separate; keep missing usage evidence.

S317. Source: `server/usage.ts:28` at base; candidate lines 28. 1 occurrence.

Now:

```text
Hermes is reported as installed; no allowance is reported here yet.
```

New:

```text
Hermes hasn't reported its allowance.
```

Reason: The installed status is separate; keep missing usage evidence.

S318. Source: `server/usage.ts:29` at base; candidate lines 29. 1 occurrence.

Now:

```text
The loopback supervisor reports status only; no allowance is reported.
```

New:

```text
LocalAI reports status without usage figures.
```

Reason: Name the actual service and preserve status-only observation.

S319. Source: `server/usage.ts:30` at base; candidate lines 30. 1 occurrence.

Now:

```text
Ollama reports per-request counts only; no allowance is reported.
```

New:

```text
Ollama reports each request's counts. Its remaining allowance isn't available here.
```

Reason: Keep actual per-request reports and unavailable balance.

S320. Source: `server/usage.ts:31` at base; candidate lines 31. 1 occurrence.

Now:

```text
AionCore is not configured in this build.
```

New:

```text
AionCore isn't configured.
```

Reason: Preserve actual unavailable setup without build-state narration.

S321. Source: `server/usage.ts:33` at base; candidate lines 33. 1 occurrence.

Now:

```text
This helper does not report its allowance here yet.
```

New:

```text
This helper hasn't reported its allowance.
```

Reason: Keep unknown allowance, without 'yet'.

### server/engines/engine-asks.ts

S322. Source: `server/engines/engine-asks.ts:162` at base; candidate lines 162. 1 occurrence.

Now:

```text
The answer this question belonged to has ended, so nothing was sent. Ask again in the conversation.
```

New:

```text
This question has expired. Ask again in the conversation.
```

Reason: Reverified expiry/ended-turn guard: keep fresh question requirement and remove a pre-dispatch tail.

### server/harness/text-route.ts

S323. Source: `server/harness/text-route.ts:157,236` at base; candidate lines 157,236. 2 occurrences.

Now:

```text
This run was cancelled: the caller cancelled.
```

New:

```text
The caller canceled this job.
```

Reason: Keep caller provenance and cancellation; remove circular explanation.

### server/automations.ts

S324. Source: `server/automations.ts:1750` at base; candidate lines 1750. 1 occurrence.

Now:

```text
Slots from now on start on their own; the paused ones do not.
```

New:

```text
Future scheduled jobs start automatically; jobs skipped while paused stay skipped.
```

Reason: Preserve no catch-up/replay on resume; replace internal slot jargon.

### server/work.ts

S325. Source: `server/work.ts:316` at base; candidate lines 316. 1 occurrence.

Now:

```text
Sample work (Diomedes)
```

New:

```text
Sample work (Nectovia)
```

Reason: Correct product name in newly generated sample content; stored old files/history remain intact.

S326. Source: `server/work.ts:316` at base; candidate lines 316. 1 occurrence.

Now:

```text
This paragraph was added by a sample work session on ${now()}. It exists to show that a change to an existing file is recorded with a way back. Undo it in Review, or restore the file from History.
```

New:

```text
This sample paragraph was added on ${now()}. Undo it in Review, or restore the file from History.
```

Reason: Keep actual generated date and recovery actions; remove demonstration-purpose narration.

S327. Source: `server/work.ts:365` at base; candidate lines 365. 1 occurrence.

Now:

```text
Something went wrong in ${task.name}. ${count}
```

New:

```text
${task.name} failed. ${count}
```

Reason: State the known failure without inventing a cause; preserve changed-file count and History evidence.

### server/ready-scheduler.ts

S328. Source: `server/ready-scheduler.ts:347` at base; candidate lines 347. 1 occurrence.

Now:

```text
Diomedes started ${name} from the Ready queue.
```

New:

```text
Nectovia started ${name} automatically from Ready.
```

Reason: Keep actual scheduler actor/start receipt, with current product name.

S329. Source: `server/ready-scheduler.ts:357` at base; candidate lines 357. 1 occurrence.

Now:

```text
Diomedes did not start ${name} from the Ready queue: ${outcome.reason}
```

New:

```text
Nectovia couldn't start ${name} from Ready. ${outcome.reason}
```

Reason: Keep authoritative refusal reason and actual current actor.

S330. Source: `server/ready-scheduler.ts:410` at base; candidate lines 410. 1 occurrence.

Now:

```text
You turned on starting Ready work automatically.
```

New:

```text
You enabled automatic starts from Ready.
```

Reason: Shorten the actual recorded human setting change.

S331. Source: `server/ready-scheduler.ts:411` at base; candidate lines 411. 1 occurrence.

Now:

```text
You turned off starting Ready work automatically.
```

New:

```text
You disabled automatic starts from Ready.
```

Reason: Shorten the actual recorded human setting change.

S332. Source: `server/ready-scheduler.ts:420` at base; candidate lines 420. 1 occurrence.

Now:

```text
You paused the Ready queue: ${queue.paused.reason}.
```

New:

```text
You paused starts from Ready. ${queue.paused.reason}
```

Reason: Keep recorded pause reason without a colon reveal.

S333. Source: `server/ready-scheduler.ts:428` at base; candidate lines 428. 1 occurrence.

Now:

```text
You resumed the Ready queue.
```

New:

```text
You resumed starts from Ready.
```

Reason: Keep actual recorded resumption.

### shared/automations.ts

S334. Source: `shared/automations.ts:610` at base; candidate lines 610. 1 occurrence.

Now:

```text
Waiting for data, an approval, or a check, or a run was missed or blocked.
```

New:

```text
Needs data, approval or a check. Missed or blocked jobs also need attention.
```

Reason: Preserve every counted attention category without assistant waiting or internal run jargon.

### server/discovery.ts

S335. Source: `server/discovery.ts:577` at base; candidate lines 577,578. 1 occurrence.

Now:

```text
Ollama is running. Diomedes does not use it.
```

New:

```text
Nectovia doesn't use Ollama.
```

Reason: The separately recorded Running status already states process presence; keep unused-tool boundary.

S336. Source: `server/discovery.ts:578` at base; candidate lines 577,578. 1 occurrence.

Now:

```text
Ollama is installed but not running. Diomedes does not use it.
```

New:

```text
Nectovia doesn't use Ollama.
```

Reason: Keep unused-tool boundary; Installed status is separately recorded.

S337. Source: `server/discovery.ts:596` at base; candidate lines 596. 1 occurrence.

Now:

```text
${spec.name} is installed. Its version could not be read. Diomedes cannot run it yet.
```

New:

```text
${spec.name}'s version couldn't be read. Nectovia can't run this tool.
```

Reason: Keep unreadable version and unavailable adapter; do not imply future capability is already supported.

S338. Source: `server/discovery.ts:597` at base; candidate lines 597. 1 occurrence.

Now:

```text
${spec.name} is installed. Its version could not be read. Diomedes does not use it.
```

New:

```text
${spec.name}'s version couldn't be read. Nectovia doesn't use this tool.
```

Reason: Keep unreadable version and unused-tool facts; installation is separate.

S339. Source: `server/discovery.ts:665` at base; candidate lines 665. 1 occurrence.

Now:

```text
${spec.name} is installed. Diomedes does not use it.
```

New:

```text
Nectovia doesn't use ${spec.name}.
```

Reason: Keep actual unused tool identity, without repeating installed status.

S340. Source: `server/discovery.ts:681` at base; candidate lines 681. 1 occurrence.

Now:

```text
${spec.name} ${version} is installed. Diomedes cannot run it yet.
```

New:

```text
Nectovia can't run ${spec.name} ${version}.
```

Reason: Keep exact observed tool/version and unavailable adapter; omit 'yet'.

S341. Source: `server/discovery.ts:682` at base; candidate lines 682. 1 occurrence.

Now:

```text
${spec.name} ${version} is installed. Diomedes does not use it.
```

New:

```text
Nectovia doesn't use ${spec.name} ${version}.
```

Reason: Keep exact observed tool/version and unused-tool fact.

S342. Source: `server/discovery.ts:727` at base; candidate lines 727. 1 occurrence.

Now:

```text
Hermes is running on this computer. Diomedes does not use it.
```

New:

```text
Nectovia doesn't use Hermes.
```

Reason: Running status is already separate; keep unused-tool boundary.

S343. Source: `server/discovery.ts:776` at base; candidate lines 776,785. 1 occurrence.

Now:

```text
Ollama ${version} is running. Diomedes does not use it.
```

New:

```text
Nectovia doesn't use Ollama ${version}.
```

Reason: Keep exact observed version and unused-tool boundary; status is separate.

S344. Source: `server/discovery.ts:785` at base; candidate lines 776,785. 1 occurrence.

Now:

```text
Ollama ${version} is installed but not running. Diomedes does not use it.
```

New:

```text
Nectovia doesn't use Ollama ${version}.
```

Reason: Keep exact observed version and unused-tool boundary; status is separate.

## Reopened integrations and catalog-read copy

The integrator authorized a bounded reopened pass after confirming the stale integration claim was absent. Remote main, origin/main and HEAD matched bae249b before edits. The cited integration branches were reread before the exact source claim. This pass preserves account-kind checks, disabled API-key fallback, read-only policy, MCP inventories, status-only local observation, AionCore inactivity, native error redaction and fork outcomes. The remaining failed catalog-read sentence was contracted under its existing source claim.

These final 20 fragments and the two induced expectation changes were added after the Git-aware full-suite snapshot reported 10,283 passed, 2 failed and 5 skipped tests across 606 passed and 2 failed files. One failure was the missed catalog contraction; the other is the console lane's attachment assertion. Those snapshot results do not validate the reopened candidate. The integrator will refresh the exact mirror and run final gates.

S345. Source: `server/integrations.ts:674` at base; candidate lines 674. 1 occurrence.

Now:

```text
Sign in to the native Codex CLI with ChatGPT. Diomedes never substitutes an API key or another provider.
```

New:

```text
Sign in to Codex with your ChatGPT account.
```

Reason: VOICE 5 and 6: give the required account action once. The account/read type and authentication checks still reject other account kinds; the connection disclosure retains disabled API-key fallback.

S346. Source: `server/integrations.ts:924` at base; candidate lines 924. 1 occurrence.

Now:

```text
Selected document text and your message are sent to OpenAI using your native ChatGPT account.
```

New:

```text
OpenAI receives your message and selected document text through your ChatGPT account.
```

Reason: VOICE 6: keep the exact cloud recipient, shared content and owned account without native-mechanism phrasing. Owned-tool sign-in names are necessary here.

S347. Source: `server/integrations.ts:925` at base; candidate lines 925. 1 occurrence.

Now:

```text
Subscription usage applies. No API key fallback.
```

New:

```text
This uses your ChatGPT subscription, with API-key fallback disabled.
```

Reason: Keep subscription billing and the noninferable disabled API-key fallback boundary in one direct sentence.

S348. Source: `server/integrations.ts:993` at base; candidate lines 993. 1 occurrence.

Now:

```text
Only GET /localai/status on 127.0.0.1:8080 is used.
```

New:

```text
Nectovia reads LocalAI status on this computer.
```

Reason: VOICE 6 and 7: state the observation payoff in plain language. Exact GET, endpoint and address stay in the request and recorded location fields.

S349. Source: `server/integrations.ts:994` at base; candidate lines 994. 1 occurrence.

Now:

```text
Diomedes does not generate, load, unload, pin, or change any local model or Hermes service.
```

New:

```text
This connection doesn't generate responses or change local models or Hermes.
```

Reason: VOICE 5 and 6: retain the observation-only boundary and no response generation, avoiding a repeated list of model operations and the old product name.

S350. Source: `server/integrations.ts:1101` at base; candidate lines 1101. 1 occurrence.

Now:

```text
Deterministic sample work uses Diomedes approvals and history. It does not call an AI engine.
```

New:

```text
Sample work uses Nectovia's approvals and history.
```

Reason: VOICE 6 and 7: current product name and direct sample behavior. The paired disclosure states that this sample uses no AI.

S351. Source: `server/integrations.ts:1103` at base; candidate lines 1103. 1 occurrence.

Now:

```text
Sample output is labeled throughout the app.
```

New:

```text
Sample work runs on this computer without AI.
```

Reason: Keep the noninferable sample-versus-AI distinction without describing the app's labels. Sample kind/status and visible sample labels stay unchanged.

S352. Source: `server/integrations.ts:1125` at base; candidate lines 1125. 1 occurrence.

Now:

```text
The proposed engine host is not installed in Diomedes. The native Codex adapter implements the bounded fallback.
```

New:

```text
AionCore isn't connected to Nectovia.
```

Reason: VOICE 5 to 7: state the unsupported connection with current product name. Keep found=false, available=false and no adapter; remove developer host/adapter/fallback narration.

S353. Source: `server/integrations.ts:1127` at base; candidate lines 1127. 1 occurrence.

Now:

```text
No AionCore process is launched.
```

New:

```text
Nectovia doesn't start AionCore.
```

Reason: VOICE 5 and 6: retain the no-process-start observation boundary in direct product wording.

S354. Source: `server/integrations.ts:1324` at base; candidate lines 1324. 1 occurrence.

Now:

```text
Codex did not acknowledge the required read-only native ChatGPT policy. No turn was sent.
```

New:

```text
Codex didn't confirm the required read-only ChatGPT policy.
```

Reason: VOICE 5 and 6: keep the required read-only account policy refusal without a preflight no-send tail. Thread identity, sandbox, network and account-provider checks remain exact.

S355. Source: `server/integrations.ts:1353` at base; candidate lines 1353. 1 occurrence.

Now:

```text
The requested Diomedes team service is absent or disabled. No model turn was sent.
```

New:

```text
The requested Nectovia team service is missing or disabled.
```

Reason: VOICE 6: preserve missing/disabled team-service refusal and current product name; remove the preflight tail. The diomedes_team protocol id remains unchanged.

S356. Source: `server/integrations.ts:1395` at base; candidate lines 1395. 1 occurrence.

Now:

```text
Native MCP tools remain available. No model turn was sent.
```

New:

```text
Codex couldn't confirm the required tool restrictions.
```

Reason: Keep failure to verify the required native tool boundary. The branch covers unsafe, incomplete or not-ready inventories; avoid overstating known available tools and cut the preflight no-send tail.

S357. Source: `server/integrations.ts:1561` at base; candidate lines 1561. 1 occurrence.

Now:

```text
Codex did not complete the response. No fallback was used.
```

New:

```text
Codex couldn't finish the answer.
```

Reason: VOICE 5 and 6: name the failed response once. Preserve TURN_FAILED and the actual completion/interruption distinction; no retry or payer logic changes.

S358. Source: `server/integrations.ts:1572` at base; candidate lines 1572. 1 occurrence.

Now:

```text
${nativeMessage} No fallback was used.
```

New:

```text
${nativeMessage}
```

Reason: VOICE 6: retain the sanitized native failure exactly without a repeated no-fallback tail. Keep the interpolation and every endpoint/account/credential redaction.

S359. Source: `server/integrations.ts:1701,2112` at base; candidate lines 1701,2112. 2 occurrences.

Now:

```text
Codex cannot read the whole project folder, because its reads cannot be checked before they run. Choose the documents to include instead.
```

New:

```text
Codex can't read the whole project folder because Nectovia can't check each read first. Choose the documents to include.
```

Reason: VOICE 5 and 6: contractions and shorter recovery action. Preserve whole-project read refusal, its enforced-check rationale and the selected-document alternative in both callers.

S360. Source: `server/integrations.ts:1984` at base; candidate lines 1984. 1 occurrence.

Now:

```text
The ChatGPT account changed. No fork was made.
```

New:

```text
The ChatGPT account changed. Sign in with the original account before copying this conversation.
```

Reason: Keep original-account identity as a prerequisite before any thread copy; replace the preflight no-fork tail with the account correction.

S361. Source: `server/integrations.ts:1989` at base; candidate lines 1989. 1 occurrence.

Now:

```text
This Codex build does not offer thread fork, so no fork was made.
```

New:

```text
This Codex version doesn't support copying conversations.
```

Reason: VOICE 5 to 7: direct unsupported-copy capability, without a no-fork tail. Keep the actual capability check and refusal state.

S362. Source: `server/integrations.ts:1995` at base; candidate lines 1995. 1 occurrence.

Now:

```text
This Codex build does not offer thread resume, so a fork could not be continued and none was made.
```

New:

```text
This Codex version can't continue a copied conversation.
```

Reason: Keep resume support as a prerequisite for a usable conversation copy; remove repeated preflight outcome narration.

S363. Source: `server/integrations.ts:2028` at base; candidate lines 2028. 1 occurrence.

Now:

```text
Codex did not accept a fork of thread ${input.threadId} (it may no longer have it), so no fork was made.
```

New:

```text
Codex rejected the copy of conversation ${input.threadId}. The original may no longer be available.
```

Reason: Keep known protocol refusal, exact original conversation id and uncertain original availability. Unrecognized or uncertain failures still propagate; no retry is added.

S364. Source: `server/models.ts:120` at base; candidate lines 120. 1 occurrence.

Now:

```text
Codex list could not be read. It is rewritten after the next Codex run.
```

New:

```text
The Codex list couldn't be read. Codex rewrites it after its next run.
```

Reason: Reverified the failed catalog-read branch and existing refresh comment. Contract the negative and name the actor that rewrites the catalog, preserving that refresh happens after the next Codex run.

## Existing assertion changes

- `tests/codex-session-runtime.test.ts`: `Diomedes restarted while an earlier message was being answered. That message wasn't completed or sent again. ` becomes `Nectovia restarted while an earlier message was being answered. That message wasn't completed or sent again. `. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/h16-console.spec.ts`: `Held before it ran. It waits for your answer.` becomes `Approve this step to continue.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/h16-stream-triggers.spec.ts`: `Recorded. Nothing else was done.` becomes `Recorded.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/h16-stream-triggers.spec.ts`: `Held before it ran, then you said go ahead.` becomes `You approved this step.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/native-loop.test.ts`: `Waiting for your OK` becomes `Needs your OK`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/nectovia-bot-app.test.ts`: `Thorough has no Nectovia model right now. Nothing was sent. Choose another tier.` becomes `Thorough is unavailable right now. Choose another tier.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/nectovia-bot-app.test.ts`: `Nectovia's model service is busy. Nothing was charged. Try again in a minute.` becomes `Nectovia's AI service is busy. Try again in a minute.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/nectovia-route.test.ts`: `Nectovia could not confirm this message was admitted. Nothing was charged. Send it again.` becomes `Nectovia couldn't confirm this message started. Send it again to check.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/nectovia-route.test.ts`: `Efficient has no Nectovia model right now. Nothing was charged. Choose another tier.` becomes `Efficient is unavailable right now. Choose another tier.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (3 occurrences.)
- `tests/nectovia-route.test.ts`: `This message and its sources are longer than Nectovia accepts. Nothing was charged. Choose fewer or shorter sources.` becomes `This message and its sources are longer than Nectovia accepts. Choose fewer or shorter sources.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/nectovia-route.test.ts`: `Nectovia's model service is busy. Nothing was charged. Try again in a minute.` becomes `Nectovia's AI service is busy. Try again in a minute.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/nectovia-route.test.ts`: `Nectovia refused this message: The request field background is not accepted. Nothing was charged.` becomes `Nectovia refused this message: The request field background is not accepted.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/nectovia-route.test.ts`: `Nectovia now runs Efficient on GPT-5.6 Luna (2). Nothing was charged. Send your message again to use it.` becomes `Nectovia now runs Efficient on GPT-5.6 Luna (2). Send your message again to use it.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/conversation-engines.test.ts`: `Codex isn't signed in on this computer, so this conversation can't continue here. Nothing was sent.` becomes `Codex isn't signed in on this computer, so this conversation can't continue here.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/conversation-engines.test.ts`: `Cursor isn't signed in on this computer, so this conversation can't continue here. Nothing was sent.` becomes `Cursor isn't signed in on this computer, so this conversation can't continue here.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/found-engines.test.ts`: `Codex isn't signed in on this computer, so this conversation can't continue here. Nothing was sent.` becomes `Codex isn't signed in on this computer, so this conversation can't continue here.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/found-engines.test.ts`: `Cursor isn't installed on this computer, so this conversation can't continue here. Nothing was sent.` becomes `Cursor isn't installed on this computer, so this conversation can't continue here.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/pay-as-you-go-desktop.test.ts`: `Buy credits or get a plan to use the Nectovia Agent here. Your own AI tools work without either.` becomes `Buy credits or get a plan to use the Nectovia Agent here.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/phone-relay-desktop.test.ts`: `You went ahead from your phone` becomes `You approved from your phone`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/harness-present.test.ts`: `/cannot promise/` becomes `/Undo isn't guaranteed/`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/harness-present.test.ts`: `/^Waiting for data/` becomes `/^A required file is missing/`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/harness-present.test.ts`: `/something went wrong/` becomes `/The job failed/`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/automations-projection.test.ts`: `/nothing was written/` becomes `/Check the required files before starting again/`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/pack-lifecycle.test.ts`: `/schema 2, which this Diomedes does not read/` becomes `/version 2, which this Nectovia can't read/`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/pack-lifecycle.test.ts`: `/schema 2/` becomes `/version 2/`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/pack-lifecycle.test.ts`: `/digest does not match its contents/` becomes `/doesn't match its recorded checksum/`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/software-pack.test.ts`: `/1 file with uncommitted changes \(draft\.txt\).*never force-removes.*Nothing was removed\./` becomes `/1 file with uncommitted changes \(draft\.txt\).*Commit or discard them yourself first\./`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/software-pack.test.ts`: `You declined. Nothing ran.` becomes `You declined.`. Update the existing assertion to the reviewed copy; behavioral and boundary checks stay intact. (1 occurrence.)
- `tests/capabilities.test.ts`: `toContain('never widen what is allowed')` becomes `toContain('within your existing scope')`. Assert the same scope ceiling in the reviewed permission description. (1 occurrence.)
- `tests/capabilities.test.ts`: `toContain('does not increase file, tool, command or network permission')` becomes `toContain('Your file, tool, command and network permissions remain the limit')`. Assert every existing permission boundary in the reviewed description. (1 occurrence.)
- `tests/capabilities.test.ts`: `toContain('waits for you')` becomes `toContain('Review the change yourself if the reviewer fails, times out or gives an unclear answer')`. Assert that failed or unclear automatic review requires human review. (1 occurrence.)
- `tests/capabilities.test.ts`: `toContain('never recorded as your approval')` becomes `toContain('Human approval requires your own decision')`. Assert truthful human approval attribution in the reviewed description. (1 occurrence.)
- `tests/review-diffs.test.ts`: `${PATH} was changed by you after this change was made, so nothing was written. Review it again against the current file.` becomes `${PATH} was changed by you after this change was made. Review it again against the current file.`. Update existing conflict-message assertion while retaining unchanged-file and unchanged-history proof. (1 occurrence.)
- `tests/h16-stream-triggers.spec.ts`: `${AGENT_NAME} paused this run: a project rule (no-summaries) matched the streamed text “Summarise what”: Summaries are written by a person — continue, redirect, or stop?` becomes `${AGENT_NAME} paused this job. a project rule (no-summaries) matched the streamed text “Summarise what”: Summaries are written by a person`. Console lane copy integration; retain separate Continue, Redirect and Stop assertions. (1 occurrence.)
- `tests/h08-control-profile.test.ts`: `No route contract is registered for this route.` becomes `This connection doesn't support this control.`. Align an existing exact-copy assertion with the revised reader text; retain behavior, state, billing and control checks. (1 occurrence.)
- `tests/h15-ladder.test.ts`: `An escalation about this is already waiting for you.` becomes `This issue already needs your decision.`. Align an existing exact-copy assertion with the revised reader text; retain behavior, state, billing and control checks. (1 occurrence.)
- `tests/team.test.ts`: `Nothing is waiting for this helper.` becomes `This helper has no pending work.`. Align an existing exact-copy assertion with the revised reader text; retain behavior, state, billing and control checks. (1 occurrence.)
- `tests/three-model-team-escalation.test.ts`: `The Nectovia model is managed. Send without choosing one.` becomes `Nectovia chooses the AI for this job. Send without choosing a model.`. Align an existing exact-copy assertion with the revised reader text; retain behavior, state, billing and control checks. (1 occurrence.)
- `tests/three-model-team-escalation.test.ts`: `Choose Nectovia roles or a Team, not both.` becomes `Choose either Nectovia roles or a Team.`. Console lane integration: align existing mutually exclusive choice error; predicate remains unchanged. (1 occurrence.)
- `services/control-plane/tests/managed-inference.test.ts`: `Nectovia’s model service isn’t available right now. Nothing was charged.` becomes `Nectovia's AI service isn't available right now.`. Align an existing exact-copy assertion with the revised reader text; retain behavior, state, billing and control checks. (1 occurrence.)
- `services/control-plane/tests/managed-worker.test.ts`: `Nectovia’s model service isn’t available right now. Nothing was charged.` becomes `Nectovia's AI service isn't available right now.`. Align an existing exact-copy assertion with the revised reader text; retain behavior, state, billing and control checks. (1 occurrence.)
- `tests/usage-presentation.test.ts`: `Codex has not reported its allowance yet. It appears after the next connection check or turn.` becomes `Codex hasn't reported its allowance. It refreshes after a connection check or answer.`. Align existing copy expectation with the final reader text; keep observed status, history actor, scheduling and freshness checks. (1 occurrence.)
- `tests/ready-scheduler.test.ts`: `You turned on starting Ready work automatically.` becomes `You enabled automatic starts from Ready.`. Align existing copy expectation with the final reader text; keep observed status, history actor, scheduling and freshness checks. (1 occurrence.)
- `tests/ready-scheduler.test.ts`: `You resumed the Ready queue.` becomes `You resumed starts from Ready.`. Align existing copy expectation with the final reader text; keep observed status, history actor, scheduling and freshness checks. (1 occurrence.)
- `tests/ready-scheduler.test.ts`: `Diomedes started First from the Ready queue.` becomes `Nectovia started First automatically from Ready.`. Preserve actual started claim, receipt, session and actor assertions while updating sentence. (1 occurrence.)
- `tests/ready-scheduler.test.ts`: `You paused the Ready queue: Stocktake.` becomes `You paused starts from Ready. Stocktake`. Preserve recorded pause reason and no starts while paused. (1 occurrence.)
- `tests/discovery.test.ts`: `Hermes is running on this computer. Diomedes does not use it.` becomes `Nectovia doesn't use Hermes.`. Align existing copy expectation with the final reader text; keep observed status, history actor, scheduling and freshness checks. (1 occurrence.)
- `tests/discovery.test.ts`: `Ollama 0.9.0 is installed but not running. Diomedes does not use it.` becomes `Nectovia doesn't use Ollama 0.9.0.`. Keep separate Installed status, observed version and availability assertions. (1 occurrence.)
- `tests/discovery.test.ts`: `Ollama 0.9.0 is running. Diomedes does not use it.` becomes `Nectovia doesn't use Ollama 0.9.0.`. Keep separate Running status, observed version and availability assertions. (1 occurrence.)
- `tests/devin-adapter.test.ts`: `expect.stringContaining('No substitute')` becomes `expect.stringContaining('no longer offers the requested model')`. The full-suite failure is stale refusal wording. Preserve MODEL_UNAVAILABLE and the existing no session/prompt assertion, which verifies no substitute is started. (1 occurrence.)
- `tests/software-pack.test.ts`: `/not confirmed\. It will not run it again on its own\./` becomes `/Its result isn't confirmed\. Check what happened before trying again\./`. Match the frozen uncertain-command result and check-before-retry warning; preserve uncertain state, no automatic replay and successful later-command assertions. (1 occurrence.)
- `tests/harness-host.test.ts`: `Check before starting again` becomes `Check what happened before starting again`. Match the updated outcome-check warning. Preserve reconcile_required, waiting task/session state, inability to complete, restart durability and canceled-run assertions. (1 occurrence.)
- `tests/h14-team-host.test.ts`: `Vertex reader cannot run: Google Vertex AI is off in Settings > Engines. Fallback is off for this project, so no other profile was tried.` becomes `Vertex reader can't run. Google Vertex AI is off in Settings > Engines. Fallback is off for this project.`. Match the named profile refusal and explicit disabled fallback. Preserve 409/team_profile_refused and pinned route/profile behavior checks. (1 occurrence.)
- `tests/acp-session-runtime.test.ts`: `/restarted while an earlier message was being answered.*not completed or resent/` becomes `/restarted while an earlier message was being answered.*wasn't completed or resent/`. Match the contraction in the interrupted-message continuity warning. Preserve resumed native session, null lost-command result and exact prompt count proving no resend. (1 occurrence.)
- `tests/acp-session-runtime.test.ts`: `/cannot continue a saved session, so this conversation couldn't resume\. Start again\./` becomes `/can't continue a saved session, so this conversation couldn't resume\. Start again\./`. Match the contraction in the unsupported-resume refusal. Preserve canceled state, RECONCILE_REQUIRED and absence of failed stream checks. (1 occurrence.)
- `tests/aws-conversation-seam.test.ts`: `/spend limit/i` becomes `/spending limit/i`. Match the frozen owner spending-limit refusal. Preserve HTTP refusal, zero SDK sends before approval and unchanged cap/available-credit assertions. (1 occurrence.)
- `tests/team-any-route.test.ts`: `Google Vertex AI is unavailable right now. Please contact support and check that your account is connected and has credits remaining.` becomes `Google Vertex AI is unavailable right now. Check your connection and credits, then contact support if it still fails.`. Match the frozen provider refusal. Preserve 409, named provider, unchanged membership and explicit owner tier-map route resolution. (1 occurrence.)
- `tests/team-any-route.test.ts`: `/^(AWS Bedrock|Google Vertex AI) is unavailable right now\. Please contact support/` becomes `/^(AWS Bedrock|Google Vertex AI) is unavailable right now\. Check your connection and credits/`. Match the same refusal prefix without losing named-provider and HTTP refusal checks. (1 occurrence.)
- `tests/team-any-route.test.ts`: `a leader works one tier above it` becomes `The leader uses one tier above your choice.`. Match the console's frozen leader tier caption. Preserve exact tier options and absence of route/model/vendor selectors. (1 occurrence.)
- `tests/acp-session.test.ts`: `/nobody answered in time.*Nothing was approved/` becomes `/approval request expired, so the request stopped/`. Match expiry of the unanswered request; keep APPROVAL_EXPIRED and existing canceled-turn/agent response checks. (1 occurrence.)
- `tests/google-vertex-conversation.test.ts`: `Google Vertex AI is unavailable right now. Please contact support and check that your account is connected and has credits remaining.` becomes `Google Vertex AI is unavailable right now. Check your connection and credits, then contact support if it still fails.`. Match provider refusal while preserving ROUTE_REFUSED, zero SDK sends, zero token mints and changed account evidence. (1 occurrence.)
- `tests/google-vertex-conversation.test.ts`: `/^Google Vertex AI is unavailable right now\. Please contact support/` becomes `/^Google Vertex AI is unavailable right now\. Check your connection and credits/`. Match stored-key mismatch refusal while preserving no send, unmatched credential identity and reconnect removal checks. (1 occurrence.)
- `tests/harness.test.ts`: `/could not confirm/` becomes `/An external action has an unconfirmed result/`. Match unknown external outcome; preserve went-wrong, uncertain step identity and reconciliation rather than success. (1 occurrence.)
- `tests/agent-profiles-routing.test.ts`: `/OpenCode writer cannot run: OpenCode is off in Settings > Engines\. Fallback is off/` becomes `/OpenCode writer can't run\. OpenCode is off in Settings > Engines\. Fallback is off/`. Match named profile refusal and disabled fallback; keep 409, no generator call and no new session assertions. (1 occurrence.)
- `tests/thread-conversation-model-api.test.ts`: `Azure OpenAI is unavailable right now. Please contact support and check that your account is connected and has credits remaining.` becomes `Azure OpenAI is unavailable right now. Check your connection and credits, then contact support if it still fails.`. Match missing-provider refusal; keep named route, all mode refusals, only observational client requests, zero sends and no turns. (1 occurrence.)
- `tests/work-style-home.test.ts`: `Google Vertex AI is unavailable right now. Please contact support` becomes `Google Vertex AI is unavailable right now. Check your connection and credits`. Match unavailable mapped provider; preserve 409, zero sends and no alternate route. (1 occurrence.)
- `tests/work-style-home.test.ts`: `AWS Bedrock is unavailable right now. Please contact support` becomes `AWS Bedrock is unavailable right now. Check your connection and credits`. Match the second unavailable mapped provider; preserve 409 and zero sends. (1 occurrence.)
- `tests/provider-setup-routes.test.ts`: `OpenRouter is unavailable right now. Please contact support and check that your account is connected and has credits remaining.` becomes `OpenRouter is unavailable right now. Check your connection and credits, then contact support if it still fails.`. Match unsupported mapped provider/model refusal; keep ask outcome and absence of a substitute model id. (1 occurrence.)
- `tests/read-connector-routes.test.ts`: `nothing was changed` becomes `can't be read. Fix or remove it first.`. Match malformed-file prerequisite; keep all 409 refusals and exact unchanged file-byte assertions. (1 occurrence.)
- `tests/harness-negative.test.ts`: `/outside/` becomes `/Paused for an external response\./`. Match generic external wait without inventing an internal reason; keep reason null. (1 occurrence.)
- `tests/task-phase.test.ts`: `/existing file, service and spend permissions/i` becomes `/within its existing permissions and spending limit/i`. Match existing permission and spending boundaries of phase continuation; keep exact phase identity, no files and no read-only claim. (1 occurrence.)
- `tests/task-phase.test.ts`: `/grants nothing new/i` becomes `/History records the phase change\./i`. The preceding assertion still verifies continuation within existing permissions. Match the recorded phase-change sentence rather than its removed duplicate no-grant tail; zero-write and no-remembered-grant identity checks stay intact. (1 occurrence.)
- `tests/managed-usage-routes.test.ts`: `/not signed in to a Nectovia account/` becomes `/Sign in to Nectovia to read this business's credit usage/`. Match required sign-in action; preserve not-connected, exact organization id, 200 observation response and absent financial figures. (1 occurrence.)
- `tests/managed-usage-ledger.test.ts`: `/envelope/i` becomes `/parent task.*spending limit/i`. Match plain wording for the distinct parent cap; preserve 402 and parent_envelope_exceeded rather than organization cap. (1 occurrence.)
- `tests/allowance-reserve-access.test.ts`: `/can’t settle this business’s usage yourself/i` becomes `/You can’t settle it directly/i`. Match direct settlement prohibition; preserve 403/direct_settle_refused and exact unchanged pending/settled usage. (1 occurrence.)
- `tests/allowance-reserve-access.test.ts`: `/Nothing was changed\.$/` becomes `/Nectovia records usage when your work finishes\./`. Match legitimate app-owned settlement timing; unchanged pending/settled money assertions continue proving no unauthorized settlement. (1 occurrence.)
- `tests/discovery.test.ts`: `Claude Code 2.1.0 is installed. Diomedes cannot run it yet.` becomes `Nectovia can't run Claude Code 2.1.0.`. Match planned-tool detail; preserve found/status, observed version/location, unavailable adapter and empty capability assertions. (1 occurrence.)
- `tests/discovery.test.ts`: `OpenCode is installed. Its version could not be read. Diomedes cannot run it yet.` becomes `OpenCode's version couldn't be read. Nectovia can't run this tool.`. Match unreadable-version detail; preserve Installed/found, unavailable status, exact location and absent version. (1 occurrence.)
- `tests/discovery.test.ts`: `Cursor 2026.08.11-e8db854 is installed. Diomedes cannot run it yet.` becomes `Nectovia can't run Cursor 2026.08.11-e8db854.`. Match planned-tool detail; preserve observed version/location and no readiness inferred from discovery. (1 occurrence.)
- `tests/discovery.test.ts`: `Claude Code is installed. Its version could not be read. Diomedes cannot run it yet.` becomes `Claude Code's version couldn't be read. Nectovia can't run this tool.`. Match failing version probe; preserve found=true and absent parsed version. (1 occurrence.)
- `tests/ai-setup-api.test.ts`: `AWS Bedrock (GPT-5.6 Luna)` becomes `AWS Bedrock`. Match the owner-only provider card's label after removing its hardcoded model. Preserve owner visibility, customer absence, section counts and separate provider labels. (2 occurrences.)
- `tests/tier-map.test.ts`: `Google Vertex AI is unavailable right now. Please contact support and check that your account is connected and has credits remaining.` becomes `Google Vertex AI is unavailable right now. Check your connection and credits, then contact support if it still fails.`. Match named provider refusal; preserve refuse outcome, exact mapped route/model and no model id in customer text. (1 occurrence.)
- `tests/handoff.test.ts`: `expect(tooDeep.reason).toContain('far enough')` becomes `expect(tooDeep.reason).toContain('delegation steps')`. Match bounded delegation wording; preserve explicit MAX_DELEGATION_DEPTH input and rejected handoff result. (1 occurrence.)
- `tests/harness-lifecycle.test.ts`: `expect(answer.reason).toContain('tried')` becomes `expect(answer.reason).toContain('stopped after')`. Match correction limit refusal; preserve rejected correction after the declared maximum attempt count. (1 occurrence.)
- `tests/execution.test.ts`: `expect(payer.reason).toContain('machine')` becomes `expect(payer.reason).toContain('computer without a usage charge')`. Match local-payer wording; preserve local-machine payer kind for sample and local model work. (1 occurrence.)
- `tests/models.test.ts`: `/has not written its list yet/` becomes `/hasn't reported its models/`. Match absent cached catalogue; preserve empty model list. (1 occurrence.)
- `tests/models.test.ts`: `/could not be read/` becomes `/couldn't be read/`. Match malformed cached-catalogue contraction; preserve empty model list after unreadable cache. (1 occurrence.)
- `tests/task-completion-bypasses.test.ts`: `Cannot complete '${task.name}': an open Need (n1) is waiting for the owner.` becomes `Can't complete '${task.name}'. The owner must answer Need n1.`. Match the explicit owner decision needed to complete a task; preserve 409 and unchanged task state. (1 occurrence.)
- `tests/codex-session.test.ts`: `Diomedes restarted while Codex was answering, and no Codex thread was confirmed to continue, so this conversation couldn't resume. Start again.` becomes `Nectovia restarted while Codex was answering. The saved thread couldn't be confirmed, so this conversation couldn't resume. Start again.`. Applied by the integrator after stale PR169-R8 claim release under claim_muxqx43p_0a6a590d. Match the continuity refusal while preserving saved-thread identity, interrupted-command checkpoint and resume checks. (1 occurrence.)
- `tests/codex-session.test.ts`: `Diomedes restarted while an earlier message was being answered. That message wasn't completed or sent again. This conversation continued from Codex's saved thread.` becomes `Nectovia restarted while an earlier message was being answered. That message wasn't completed or sent again. This conversation continued from Codex's saved thread.`. Applied by the integrator after the legitimate stale-claim release. Preserve the incomplete, never-resent earlier message and continued saved-thread evidence. (1 occurrence.)
- `tests/aws-conversation-authority.review-20260921.test.ts`: `/spend limit/i` becomes `/spending limit/i`. Applied by the integrator after stale security-hardening claim release under claim_muxqx43p_0a6a590d. Match owner spending-limit refusal while preserving HTTP refusal and zero SDK sends before approval. (1 occurrence.)

Other old-worded provider/worker mocks were kept when they intentionally inject an external or older response. Changing a fixture to match app prose would remove that compatibility/error-path evidence. No behavior assertion was weakened to make a copy assertion pass.

The integrator's first full Vitest run on the checksummed mirror reported 10,220 passed, 65 failed and 5 skipped tests across 563 passed and 45 failed files. This lane re-read every final backend/shared copy failure block and its actual source branch. The repair adds 39 expectation fragments (40 occurrences) in 28 test files, including subsequent assertions hidden behind the first failure. Reconciliation states, no prompt/send behavior, disabled fallback, native-session continuity, provider identity, owner-only visibility and tier controls remain asserted. These are authored expectation repairs; the integrator must rerun the corrected tests. This lane has not claimed them passed. Console-owned regex/render expectations were handed to that lane. Two capability-record failures depend on Git metadata missing from the mirror; their true/false expectations were preserved for a Git-aware validation candidate.

- `tests/integrations.test.ts`: `did not complete` becomes `couldn't finish the answer`. Reverified the exact completed-turn refusal in server/integrations.ts and this TURN_FAILED expectation. Update only the wording match; process reuse, request sequencing and native outcome assertions remain unchanged. (1 occurrence.)
- `tests/h02-codex-controls.test.ts`: `Codex did not accept a fork of thread ${kept.nativeThread!.id} (it may no longer have it), so no fork was made.` becomes `Codex rejected the copy of conversation ${kept.nativeThread!.id}. The original may no longer be available.`. Reverified the exact known fork rejection branch and receipt expectation. Keep route-refused, performedBy:null, task count and original-record preservation assertions while matching the reviewed message and unchanged thread-id interpolation. (1 occurrence.)

## Audit disposition by logged finding

The audit-line number refers to `parts/app-server-others.md`. 'Excerpt' means at least a quoted literal or a meaningful shortened fragment was found in the baseline source window; it does not claim every dynamic auditor quotation is byte-exact. 'Context' marks the eight nonliteral excerpts. Blocked findings were inspected but not edited. 'Initially blocked' records the historical claim that prevented editing; the claim was subsequently released, and the finding still has no implementation in this frozen candidate.

| Audit line | Source | Disposition | Reverification | Reason |
|---|---|---|---|---|
| 69 | `server/accounts/agent-gate.ts:44,47` | Changed | Excerpt | Copy edits S001, S002.  |
| 70 | `server/accounts/routing-session.ts:31,61,70,200,205,227,256,257,265,278` | Changed / retained | Excerpt | Copy edits S304, S305, S306, S307, S308, S309, S310. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 71 | `server/accounts/session.ts:209,1399,1400` | Blocked | Excerpt | Live claim: B04.BILLING (claim_muxodwsg_41667444). Source inspected; no overlapping edit. |
| 72 | `server/accounts/session.ts:305` | Blocked | Excerpt | Live claim: B04.BILLING (claim_muxodwsg_41667444). Source inspected; no overlapping edit. |
| 73 | `server/accounts/session.ts:306` | Blocked | Excerpt | Live claim: B04.BILLING (claim_muxodwsg_41667444). Source inspected; no overlapping edit. |
| 74 | `server/accounts/session.ts:1334` | Blocked | Excerpt | Live claim: B04.BILLING (claim_muxodwsg_41667444). Source inspected; no overlapping edit. |
| 75 | `server/app-updates.ts:135,138,140,252,255,260,279,298,314,323,685,693` | Changed | Excerpt | Copy edits S003, S004, S005, S006, S007.  |
| 76 | `server/app-updates.ts:819,828,839,845,856,862` | Changed | Excerpt | Copy edits S008, S009.  |
| 77 | `server/app-updates.ts:156,161,173` | Retained | Excerpt | Metadata bounds and package-only installation refusals occur in separate validation branches; do not change update gates. |
| 78 | `server/app-updates.ts:403,408,412` | Retained | Excerpt | Metadata bounds and package-only installation refusals occur in separate validation branches; do not change update gates. |
| 79 | `server/billing-events.ts:143,157` | Retained | Excerpt | Webhook event diagnostics and durable deduplication history; repeated validation paths are separate events. |
| 80 | `server/billing-events.ts:146` | Retained | Excerpt | Webhook event diagnostics and durable deduplication history; repeated validation paths are separate events. |
| 85 | `server/customization-benefit.ts:197` | Blocked | Excerpt | Live claim: DIO-252 (claim_mux69zuq_67519943). Source inspected; no overlapping edit. |
| 86 | `server/customization-benefit.ts:206` | Blocked | Excerpt | Live claim: DIO-252 (claim_mux69zuq_67519943). Source inspected; no overlapping edit. |
| 87 | `server/customization-benefit-routes.ts:87` | Blocked | Excerpt | Live claim: DIO-252 (claim_mux69zuq_67519943). Source inspected; no overlapping edit. |
| 88 | `server/credit-limit-routes.ts:50` | Retained | Excerpt | API validation uses the actual money unit; do not rename a machine unit into a different contract. |
| 89 | `server/managed-usage-routes.ts:84,313,479` | Changed | Excerpt | Copy edits S254, S255, S256.  |
| 90 | `server/managed-usage-routes.ts:95` | Retained | Excerpt | The API requires integer micro-USD; this is exact money validation, not public pricing prose. |
| 91 | `server/managed-usage.ts:404,478` | Changed / retained | Excerpt | Copy edits S257. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 92 | `server/managed-usage.ts:360` | Changed | Excerpt | Copy edits S258.  |
| 93 | `server/managed-gateway.ts:83` | Changed | Excerpt | Copy edits S077.  |
| 94 | `server/managed-gateway.ts:128,269,297` | Changed | Excerpt | Copy edits S078, S081, S082.  |
| 95 | `server/managed-gateway.ts:245` | Changed | Excerpt | Copy edits S080.  |
| 96 | `server/spend-exposure.ts:219,236,549,890` | Changed | Excerpt | Copy edits S219, S220.  |
| 97 | `server/spend-exposure.ts:1141` | Retained | Excerpt | Internal bounded-spend failure diagnostic; caller visibility and a safe plain replacement were not established. The bound itself must remain explicit. |
| 98 | `server/spend-exposure.ts:1331,1332,1375` | Retained | Excerpt | Internal evidence records raw provider usage and conversion into the actual ledger unit. Preserve values and attribution. |
| 99 | `server/usage.ts:22-31` | Changed | Excerpt | Copy edits S311-S321. Allowance cards state unreported usage once. Actual service identity and the status-only observation boundary remain. |
| 100 | `server/usage.ts:29` | Changed | Excerpt | Copy edits S318. Replace loopback-supervisor terminology with the LocalAI status source while keeping unavailable usage explicit. |
| 101 | `server/job-caps.ts:129` | Retained | Excerpt | Persisted cap-file validation and stopped-job identity semantics need precise recovery wording. |
| 102 | `server/job-caps.ts:429` | Retained | Excerpt | Persisted cap-file validation and stopped-job identity semantics need precise recovery wording. |
| 106 | `server/engines/acp-client.ts:154,540,1117,1123` | Changed / retained | Excerpt | Copy edits S259. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. No automatic retry after a timed-out request is a noninferable paid outcome; protocol response text is model/tool-facing. |
| 107 | `server/engines/acp-client.ts:348,361,1152,1159` | Retained | Excerpt | No automatic retry after a timed-out request is a noninferable paid outcome; protocol response text is model/tool-facing. |
| 108 | `server/engines/acp-client.ts:1144,1187` | Retained | Excerpt | No automatic retry after a timed-out request is a noninferable paid outcome; protocol response text is model/tool-facing. |
| 109 | `server/engines/acp-session.ts:150,152 + codex-session.ts:99 + opencode-session.ts:129` | Changed / retained | Excerpt | Copy edits S150, S151, S153. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 110 | `server/engines/acp-session.ts:442 + codex-session.ts:420 + cursor.ts:402 + opencode-session.ts:383 + opencode.ts:1257 + integrations.ts:1701,2112` | Changed / retained | Excerpt | Reopened after the integrator verified and released stale PR169-R8; remote main, origin/main and HEAD were reverified at bae249b, the cited current source was reread, and exact claim_muxr68ei_2efcb59b was acquired before edits. Changed the two server/integrations.ts full-folder refusals (S359), retaining the reason that each read can't be checked first and the selected-document action. Other cited adapter messages retain this necessary access boundary. |
| 111 | `server/engines/acp-session.ts:361` | Changed | Excerpt | Copy edits S154.  |
| 112 | `server/engines/aws-bedrock.ts:105` | Retained | Excerpt | Owner migration and declared-versus-verified credential evidence need the exact external service/model identity. |
| 113 | `server/engines/aws-bedrock.ts:268` | Retained | Excerpt | Owner migration and declared-versus-verified credential evidence need the exact external service/model identity. |
| 114 | `server/engines/bonsai.ts:27-30` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 115 | `server/engines/bonsai.ts:28,53` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 116 | `server/engines/bonsai.ts:69,223` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 117 | `server/engines/claude.ts:157,636` | Changed / retained | Excerpt | Copy edits S260. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Owned subscription versus API sign-in is an actual account/billing boundary. |
| 118 | `server/engines/claude.ts:547` | Retained | Excerpt | Owned subscription versus API sign-in is an actual account/billing boundary. |
| 119 | `server/engines/claude-session.ts:344-474` | Retained | Excerpt | Protocol refusal and external tool attribution; do not rewrite prompts or pretend the tool accepted a request. |
| 120 | `server/engines/cursor.ts:379 + devin.ts:360` | Retained | Context | Connected account, tool denial and absent OS containment are real owned-tool boundaries; DIO-272 naming remains separate. Connected account, browser sign-in, tool denial and absent OS containment are real owned-tool boundaries. The audit quote is shortened/templated or normalized; the cited source context was inspected, not claimed as a literal quote match. |
| 121 | `server/engines/cursor.ts:461 + devin.ts:429` | Changed | Excerpt | Copy edits S261, S262.  |
| 122 | `server/engines/devin.ts:360` | Retained | Excerpt | Connected account, browser sign-in, tool denial and absent OS containment are real owned-tool boundaries. |
| 123 | `server/engines/engine-asks.ts:66` | Changed | Excerpt | Copy edits S157, S158.  |
| 124 | `server/engines/engine-asks.ts:70,71` | Changed | Excerpt | Copy edits S157, S158.  |
| 125 | `server/engines/engine-asks.ts:147` | Retained | Excerpt | A one-time interactive answer cannot become remembered authority for a task. Preserve this real approval-scope limitation. |
| 126 | `server/engines/engine-asks.ts:162` | Changed | Excerpt | Copy edits S322. The branch checks request expiry or an ended conversation turn. State expiration and the existing recovery action without a no-send tail. |
| 127 | `server/engines/google-vertex.ts:126` | Retained | Excerpt | Gross estimate and separate introductory credit-back are different financial amounts. Do not change pricing semantics in a voice pass. |
| 128 | `server/engines/google-vertex.ts:201,207,219,326,332,348,353,632` | Changed | Excerpt | Copy edits S069, S070, S071, S072, S073, S074, S075, S076.  |
| 129 | `server/engines/install.ts:227,242` | Changed | Excerpt | Copy edits S143, S144.  |
| 130 | `server/engines/install.ts:257,259` | Retained | Excerpt | Installation effects on Node/Bun, privilege elevation, PATH and security settings are noninferable system-change boundaries. |
| 131 | `server/engines/install.ts:321,362,374,389,397` | Changed | Excerpt | Copy edits S145, S146, S147, S148, S149.  |
| 132 | `server/engines/login.ts:163` | Retained | Excerpt | Owner credential instructions name the exact file, account and billing authority needed to connect an owned tool. |
| 133 | `server/engines/model-api-core.ts:174,182,196,538,992,1188` | Changed | Excerpt | Copy edits S189, S190, S191, S192, S194, S195.  |
| 134 | `server/engines/model-api-core.ts:220` | Retained | Excerpt | Unknown paid outcomes, input/output validation and price ceilings remain precise; no uncertain hold is released by wording. |
| 135 | `server/engines/model-api-core.ts:1046,1076,1194,1195,1259` | Changed / retained | Excerpt | Copy edits S195, S198. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Unknown paid outcomes, input/output validation and price ceilings remain precise; no uncertain hold is released by wording. |
| 136 | `server/engines/model-api-core.ts:1215,1247,1253,1267,1295,1304` | Changed / retained | Excerpt | Copy edits S196, S197, S198, S199. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Unknown paid outcomes, input/output validation and price ceilings remain precise; no uncertain hold is released by wording. |
| 137 | `server/engines/model-api-core.ts:1232` | Retained | Excerpt | Unknown paid outcomes, input/output validation and price ceilings remain precise; no uncertain hold is released by wording. |
| 138 | `server/engines/model-api-core.ts:1366` | Retained | Excerpt | Unknown paid outcomes, input/output validation and price ceilings remain precise; no uncertain hold is released by wording. |
| 139 | `server/engines/model-api-routes.ts:166 + provider-routes.ts:241,630` | Changed | Excerpt | Copy edits S268, S271.  |
| 140 | `server/engines/model-api-routes.ts:245 + provider-routes.ts:351,784` | Retained | Excerpt | Approved spending exposure survives reopening/reconnecting and differs from actual provider billing. Saved-key/local checks do not prove an accepted real provider request; exact owner credential commands remain. |
| 141 | `server/engines/nectovia.ts:59,148,225,291,296,309,322,327,335,341,346,363,421,607,608,642,657,663` | Changed / retained | Excerpt | Copy edits S083, S084, S085, S086, S087, S088, S089, S090, S091, S092, S093, S094, S095, S096, S097, S098, S099. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 142 | `server/engines/nectovia.ts:327,335,608,642 + service.ts:2431` | Changed | Excerpt | Copy edits S089, S090, S091, S095, S096, S097, S211, S212.  |
| 143 | `server/engines/nectovia.ts:263,265` | Retained | Excerpt | Separate credit-exhaustion branches must keep the exact unavailable-funding refusal; no price, allowance or payer change is authorized. |
| 144 | `server/engines/nectovia.ts:181,188,217,232` | Changed | Excerpt | Copy edits S085.  |
| 145 | `server/engines/nectovia.ts:469,476,553,563,599` | Changed / retained | Excerpt | Copy edits S095. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 146 | `server/engines/opencode.ts:381` | Changed | Excerpt | Copy edits S263.  |
| 147 | `server/engines/opencode.ts:390,436,489` | Changed | Excerpt | Copy edits S264.  |
| 148 | `server/engines/opencode.ts:530,531,1214` | Retained | Excerpt | OpenCode Go versus other accounts and automatic upstream retry behavior are noninterchangeable facts. |
| 149 | `server/engines/opencode.ts:980` | Retained | Excerpt | OpenCode Go versus other accounts and automatic upstream retry behavior are noninterchangeable facts. |
| 150 | `server/engines/opencode.ts:1050` | Changed | Excerpt | Copy edits S265.  |
| 151 | `server/engines/openrouter.ts:67` | Retained | Excerpt | Owner model-id validation forbids an external router substituting a different model. Keep exact external-service and requested-model identity. |
| 152 | `server/engines/process.ts:56,93` | Retained | Excerpt | A stopped dispatched request may still use paid allowance. This is a noninferable effect boundary. |
| 153 | `server/engines/omp.ts:466` | Retained | Excerpt | Owner connection detail identifies actual account and tool restrictions; naming review belongs to DIO-272. |
| 154 | `server/engines/provider-routes.ts:309-327,746-764` | Retained | Excerpt | Saved-key/local checks do not prove an accepted real provider request; exact owner credential commands remain. |
| 155 | `server/engines/provider-routes.ts:327,761` | Retained | Excerpt | Saved-key/local checks do not prove an accepted real provider request; exact owner credential commands remain. |
| 156 | `server/engines/provider-routes.ts:337,770` | Changed | Excerpt | Copy edits S273.  |
| 157 | `server/engines/provider-routes.ts:121,136` | Changed | Excerpt | Copy edits S272.  |
| 158 | `server/engines/read-connector-routes.ts:148,183` | Changed | Excerpt | Copy edits S221, S222.  |
| 159 | `server/engines/read-scope.ts:319-325` | Retained | Excerpt | These are shipped model instructions, including exact read-only file/tool boundaries. Model prompt rewrites are excluded. |
| 160 | `server/engines/service.ts:841` | Retained | Excerpt | Retained API adapter/runtime diagnostics and OS-boundary statements preserve technical identity and true security limits. |
| 161 | `server/engines/service.ts:1525,1544,2358,2413,2419,2435,2473,2527,2871,2912,3108,3207,3215,3408,3412,3414,3448` | Changed / retained | Excerpt | Copy edits S206, S207, S208, S209, S210, S211, S212, S213, S214, S215, S216, S217. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Retained API adapter/runtime diagnostics and OS-boundary statements preserve technical identity and true security limits. |
| 162 | `server/engines/service.ts:1608,1610,1611` | Retained | Excerpt | Retained API adapter/runtime diagnostics and OS-boundary statements preserve technical identity and true security limits. |
| 163 | `server/engines/service.ts:1645,1705` | Retained | Excerpt | Retained API adapter/runtime diagnostics and OS-boundary statements preserve technical identity and true security limits. |
| 164 | `server/engines/service.ts:1770` | Retained | Excerpt | Retained API adapter/runtime diagnostics and OS-boundary statements preserve technical identity and true security limits. |
| 165 | `server/engines/service.ts:2619,2770` | Retained | Excerpt | Retained API adapter/runtime diagnostics and OS-boundary statements preserve technical identity and true security limits. |
| 169 | `server/harness/present.ts:60` | Changed | Excerpt | Copy edits S012, S013.  |
| 170 | `server/harness/present.ts:67` | Changed | Excerpt | Copy edits S012, S013.  |
| 171 | `server/harness/present.ts:76,99` | Changed | Excerpt | Copy edits S014, S015, S016.  |
| 172 | `server/harness/present.ts:170,171,200,201` | Changed | Excerpt | Copy edits S018, S019, S020, S025, S026, S027, S028.  |
| 173 | `server/harness/present.ts:172` | Changed | Context | Copy edits S018, S019, S020.  The audit quote is shortened/templated or normalized; the cited source context was inspected, not claimed as a literal quote match. |
| 174 | `server/harness/present.ts:188-192` | Changed | Excerpt | Copy edits S021, S022, S023, S024, S025, S026, S027.  |
| 175 | `server/harness/present.ts:191` | Changed | Excerpt | Copy edits S021, S022, S023, S024, S025, S026.  |
| 176 | `server/harness/lifecycle.ts:193,197,202` | Changed | Excerpt | Copy edits S033, S034, S035.  |
| 177 | `server/harness/lifecycle.ts:314` | Changed | Excerpt | Copy edits S036.  |
| 178 | `server/harness/lifecycle.ts:320,322` | Changed / retained | Excerpt | Copy edits S036. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 179 | `server/harness/bridge.ts:658,844` | Changed / retained | Excerpt | Copy edits S275. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 180 | `server/harness/bridge.ts:284,721,796` | Changed / retained | Excerpt | Copy edits S276. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 181 | `server/harness/board-progress.ts:72` | Changed | Excerpt | Copy edits S040.  |
| 182 | `server/harness/board-progress.ts:39,70` | Changed / retained | Excerpt | Copy edits S040. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 183 | `server/harness/capabilities/weekly-brief.ts:55,320,517` | Changed / retained | Excerpt | Copy edits S041, S044. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 184 | `server/harness/capabilities/weekly-brief.ts:93,199` | Changed | Excerpt | Copy edits S042, S043.  |
| 185 | `server/harness/capabilities/native-loop.ts:1438` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 186 | `server/harness/capabilities/native-loop.ts:1517` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 187 | `server/harness/capabilities/native-loop.ts:1634` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 188 | `server/harness/capabilities/native-loop.ts:121,123-125,682,685,689,1263` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 189 | `server/harness/claude-session-run.ts:1484,1517,1613,1653` | Retained | Excerpt | Queued-message, interrupted-send and restart records distinguish cancellation, delivery and unknown outcomes. |
| 190 | `server/harness/claude-session-run.ts:1549,1553,1619,1623,1663,1670` | Retained | Excerpt | Queued-message, interrupted-send and restart records distinguish cancellation, delivery and unknown outcomes. |
| 191 | `server/harness/claude-session-run.ts:1621,1668` | Retained | Excerpt | Queued-message, interrupted-send and restart records distinguish cancellation, delivery and unknown outcomes. |
| 192 | `server/harness/claude-session-run.ts:710,792 + model-session-run.ts:575,631` | Retained | Excerpt | Queued-message, interrupted-send and restart records distinguish cancellation, delivery and unknown outcomes. Unknown paid response outcome and no-resend behavior must remain explicit. |
| 193 | `server/harness/claude-session-run.ts:821,835 + model-session-run.ts:652,659` | Retained | Excerpt | Queued-message, interrupted-send and restart records distinguish cancellation, delivery and unknown outcomes. Unknown paid response outcome and no-resend behavior must remain explicit. |
| 194 | `server/harness/claude-session-run.ts:1700` | Retained | Excerpt | Queued-message, interrupted-send and restart records distinguish cancellation, delivery and unknown outcomes. |
| 195 | `server/harness/claude-session-run.ts:491,494` | Retained | Excerpt | Queued-message, interrupted-send and restart records distinguish cancellation, delivery and unknown outcomes. |
| 196 | `server/harness/capabilities/team-loop.ts:384` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 197 | `server/harness/capabilities/read-scope-tools.ts:400` | Retained | Excerpt | Tool descriptions and reading-limit responses guide the model; model prompt rewrites are outside this lane. |
| 198 | `server/harness/capabilities/read-scope-tools.ts:213,219` | Retained | Excerpt | Tool descriptions and reading-limit responses guide the model; model prompt rewrites are outside this lane. |
| 199 | `server/harness/capabilities/page-fetch.ts:158,160,186` | Retained | Excerpt | Address validation/refusals are returned through a tool and keep public-network restrictions. |
| 200 | `server/harness/capabilities/page-fetch.ts:182,184` | Retained | Excerpt | Address validation/refusals are returned through a tool and keep public-network restrictions. |
| 201 | `server/harness/containment.ts:90` | Retained | Excerpt | Path containment assertions and race checks protect actual filesystem writes. |
| 202 | `server/harness/containment.ts:229` | Retained | Excerpt | Path containment assertions and race checks protect actual filesystem writes. |
| 203 | `server/harness/agent-collaboration.ts:194` | Retained | Excerpt | Unmeasured comparative quality must stay unmeasured; this is selection evidence, not a marketing claim. |
| 204 | `server/harness/automatic-team-selection.ts:67` | Retained | Excerpt | Runtime selection evidence retains measured quality and reserved correction budget. |
| 205 | `server/harness/instruction-delivery.ts:104-336` | Retained | Excerpt | Exact delivered-versus-omitted instruction evidence and pack activation boundaries must remain inspectable. |
| 206 | `server/harness/instruction-delivery.ts:204,207` | Retained | Excerpt | Exact delivered-versus-omitted instruction evidence and pack activation boundaries must remain inspectable. |
| 207 | `server/harness/instruction-delivery.ts:221` | Retained | Excerpt | Exact delivered-versus-omitted instruction evidence and pack activation boundaries must remain inspectable. |
| 208 | `server/harness/instruction-delivery.ts:623,632` | Retained | Excerpt | Exact delivered-versus-omitted instruction evidence and pack activation boundaries must remain inspectable. |
| 209 | `server/harness/context-assembly.ts:303,308,313` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 210 | `server/harness/context-assembly.ts:308` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 211 | `server/harness/external-worker.ts:244` | Retained | Excerpt | Owned-tool billing and runtime-reported attribution are distinct from Nectovia credits. |
| 212 | `server/harness/external-worker.ts:297` | Retained | Excerpt | Owned-tool billing and runtime-reported attribution are distinct from Nectovia credits. |
| 213 | `server/harness/model-api-adapter.ts:66-83` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 214 | `server/harness/aws-model-adapter.ts:129-133, azure-model-adapter.ts:88-91, openrouter-model-adapter.ts:80-83, vertex-model-adapter.ts:90-95, nectovia-model-adapter.ts:91-94` | Retained | Excerpt | Adapter protocol notes preserve store/retry/tool-owner facts; they are technical evidence. |
| 215 | `server/harness/host.ts:331 + routes.ts:29,31` | Changed / retained | Excerpt | Copy edits S277. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 216 | `server/harness/model-session-run.ts:1221,1226` | Retained | Excerpt | Unknown paid response outcome and no-resend behavior must remain explicit. |
| 217 | `server/harness/text-route.ts:157,236` | Changed | Excerpt | Copy edits S323. Name caller cancellation once; both cancellation branches keep their existing caller-owned stop behavior. |
| 218 | `server/harness/text-route.ts:205` | Changed | Excerpt | Copy edits S037, S038.  |
| 219 | `server/harness/text-route.ts:210` | Changed | Excerpt | Copy edits S037, S038.  |
| 220 | `server/harness/run-service.ts:691,704,1313` | Retained | Excerpt | Internal state assertions define which uncertain result can be checked; no user-facing status is inferred from an internal guard. |
| 221 | `server/harness/native-loop.ts:745,746` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 222 | `server/harness/native-loop.ts:841,946` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 223 | `server/harness/native-loop.ts:971` | Blocked | Excerpt | Live claim: DIO-247-STACK (claim_muxbtxwm_99270f88). Source inspected; no overlapping edit. |
| 224 | `server/harness/tools.ts:338` | Retained | Excerpt | Effect reconciliation evidence uses actual tool identity and idempotency keys. |
| 225 | `server/trust/remembered-approvals.ts:470,471` | Retained | Excerpt | Historical exact-approval provenance and revocation/offer behavior are different facts, not interchangeable generic approvals. |
| 226 | `server/trust/remembered-approvals.ts:252,470,621` | Retained | Excerpt | Historical exact-approval provenance and revocation/offer behavior are different facts, not interchangeable generic approvals. |
| 227 | `server/trust/remembered-approvals.ts:604` | Retained | Excerpt | Historical exact-approval provenance and revocation/offer behavior are different facts, not interchangeable generic approvals. |
| 228 | `server/trust/remembered-approvals.ts:291,299,307` | Retained | Excerpt | Historical exact-approval provenance and revocation/offer behavior are different facts, not interchangeable generic approvals. |
| 229 | `server/trust/reviewer.ts:326,329` | Blocked | Excerpt | Live claim: security-hardening-cloud-sharing (claim_mudo5yxg_d871b0b3). Source inspected; no overlapping edit. |
| 230 | `server/trust/reviewer.ts:331` | Blocked | Excerpt | Live claim: security-hardening-cloud-sharing (claim_mudo5yxg_d871b0b3). Source inspected; no overlapping edit. |
| 231 | `server/trust/reviewer.ts:625` | Blocked | Excerpt | Live claim: security-hardening-cloud-sharing (claim_mudo5yxg_d871b0b3). Source inspected; no overlapping edit. |
| 232 | `server/trust/reviewer.ts:145` | Blocked | Excerpt | Live claim: security-hardening-cloud-sharing (claim_mudo5yxg_d871b0b3). Source inspected; no overlapping edit. |
| 233 | `server/trust/scope-grants.ts:336,337` | Retained | Excerpt | Separate sending consent, actual account binding, machine-review provenance and possible in-flight effects are true authority boundaries. |
| 234 | `server/trust/scope-grants.ts:395` | Retained | Excerpt | Separate sending consent, actual account binding, machine-review provenance and possible in-flight effects are true authority boundaries. |
| 235 | `server/trust/scope-grants.ts:614` | Retained | Excerpt | Separate sending consent, actual account binding, machine-review provenance and possible in-flight effects are true authority boundaries. |
| 236 | `server/trust/scope-grants.ts:487,494,495` | Retained | Excerpt | Separate sending consent, actual account binding, machine-review provenance and possible in-flight effects are true authority boundaries. |
| 237 | `server/trust/environments.ts:16` | Retained | Excerpt | A project folder or worktree is not OS containment. This noninferable security limit must remain explicit. |
| 238 | `server/trust/authority.ts:54-62` | Retained | Excerpt | Trust invariants and stale-generation refusal diagnostics define authority and uncertain-effect recovery. |
| 239 | `server/trust/authority.ts:242,327` | Retained | Excerpt | Trust invariants and stale-generation refusal diagnostics define authority and uncertain-effect recovery. |
| 240 | `server/trust/local-backend.ts:79,84,87` | Retained | Excerpt | An actual OS identity prerequisite; repeated exception branches are not repeated text on one screen. |
| 241 | `server/supervision/ladder.ts:110,114` | Changed | Excerpt | Copy edits S278, S279.  |
| 242 | `server/supervision/ladder.ts:113,131,134,135,140,143,144,150,153,199,203` | Changed / retained | Excerpt | Copy edits S278, S279, S280. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 243 | `server/supervision/ladder.ts:204` | Changed | Excerpt | Copy edits S280.  |
| 244 | `server/supervision/ladder.ts:175,181` | Changed / retained | Excerpt | Copy edits S281. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 245 | `server/supervision/detectors.ts:229,255,330,533` | Blocked | Excerpt | Live claim: supervision-guidance-followups (claim_mukn3b39_bbfe9011). Source inspected; no overlapping edit. |
| 246 | `server/supervision/detectors.ts:539` | Blocked | Context | Live claim: supervision-guidance-followups (claim_mukn3b39_bbfe9011). Source inspected; no overlapping edit. The audit quote is shortened/templated or normalized; the cited source context was inspected, not claimed as a literal quote match. |
| 247 | `server/supervision/service.ts:329` | Blocked | Excerpt | Live claim: supervision-guidance-followups (claim_mukn3b39_bbfe9011). Source inspected; no overlapping edit. |
| 248 | `server/supervision/service.ts:366` | Blocked | Excerpt | Live claim: supervision-guidance-followups (claim_mukn3b39_bbfe9011). Source inspected; no overlapping edit. |
| 249 | `server/sandbox/change-sets.ts:350` | Changed | Excerpt | Copy edits S282.  |
| 250 | `server/sandbox/change-sets.ts:323,413,495` | Retained | Excerpt | A conflict can leave outside changes present; preserve original-base comparisons and human authorship. |
| 251 | `server/software-pack/service.ts:435,603,604` | Changed | Excerpt | Copy edits S103, S105, S106.  |
| 252 | `server/software-pack/service.ts:306` | Changed | Excerpt | Copy edits S101.  |
| 253 | `server/software-pack/service.ts:157,527` | Changed | Excerpt | Copy edits S100, S104.  |
| 254 | `server/software-pack/service.ts:346,482,642` | Changed | Excerpt | Copy edits S102, S108, S188.  |
| 255 | `server/software-pack/service.ts:822` | Retained | Excerpt | Exact command approval, undeclared actions and existing repository history remain distinct. |
| 256 | `server/software-pack/tools.ts:127,141,176` | Retained | Excerpt | Existing uncommitted work, branch/commit preservation and authorized command scope remain explicit. |
| 257 | `server/software-pack/tools.ts:249,253,260,307,311,316,321,333` | Changed / retained | Excerpt | Copy edits S110, S111, S112, S113, S114, S115. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Existing uncommitted work, branch/commit preservation and authorized command scope remain explicit. |
| 258 | `server/software-pack/tools.ts:275,283,340` | Retained | Excerpt | Existing uncommitted work, branch/commit preservation and authorized command scope remain explicit. |
| 259 | `server/stream-rules/service.ts:342` | Retained | Excerpt | A trigger-rule edit cannot grant authority. The historical action receipt preserves that real boundary. |
| 260 | `server/team/board.ts:104,110` | Changed | Context | Copy edits S283.  The audit quote is shortened/templated or normalized; the cited source context was inspected, not claimed as a literal quote match. |
| 261 | `server/team/service.ts:431` | Changed | Excerpt | Copy edits S284.  |
| 262 | `server/verification/service.ts:331` | Retained | Excerpt | Checks must judge the actual produced version; missing command authority and incomplete verdict remain unverified. |
| 263 | `server/verification/service.ts:379` | Retained | Excerpt | Checks must judge the actual produced version; missing command authority and incomplete verdict remain unverified. |
| 264 | `server/verification/service.ts:404` | Retained | Excerpt | Checks must judge the actual produced version; missing command authority and incomplete verdict remain unverified. |
| 265 | `server/verification/service.ts:545` | Changed | Excerpt | Copy edits S285.  |
| 269 | `server/app.ts:4904,5228` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 270 | `server/app.ts:5600` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 271 | `server/app.ts:5594` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 272 | `server/app.ts:6069` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 273 | `server/app.ts:6539,6540` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 274 | `server/app.ts:7065` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 275 | `server/app.ts:3638` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 276 | `server/app.ts:3650` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 277 | `server/app.ts:5990,6299` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 278 | `server/app.ts:6212` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 279 | `server/app.ts:4141,4143,4144` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 280 | `server/app.ts:1647,1887,2990,3427` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 281 | `server/app.ts:2267` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 282 | `server/app.ts:3074,6192` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 283 | `server/app.ts:3881,3882` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 284 | `server/automations.ts:276,457,1577,1604` | Changed | Excerpt | Copy edits S122, S123, S127, S128, S129, S130.  |
| 285 | `server/automations.ts:294,309` | Retained | Excerpt | The primary scheduling fact is what the next occurrence does while this computer is on. Do not change scheduling behavior for prose. |
| 286 | `server/automations.ts:547,548,1484` | Retained | Excerpt | Missed offline jobs are recorded and never replayed later. This noninferable catch-up behavior is necessary. |
| 287 | `server/automations.ts:842` | Changed / retained | Excerpt | Copy edits S124, S125. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 288 | `server/automations.ts:845` | Changed | Excerpt | Copy edits S124, S125.  |
| 289 | `server/automations.ts:846` | Changed | Excerpt | Copy edits S124, S125.  |
| 290 | `server/automations.ts:849` | Changed / retained | Excerpt | Copy edits S124, S125. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 291 | `server/automations.ts:1606,1607` | Changed | Excerpt | Copy edits S128, S129, S130.  |
| 292 | `server/automations.ts:1750` | Changed | Excerpt | Copy edits S324. Replace internal schedule slots with scheduled jobs while preserving future starts and skipped-paused-job semantics. |
| 293 | `server/integrations.ts:674` | Changed | Excerpt | Reopened after the integrator verified and released stale PR169-R8; remote main, origin/main and HEAD were reverified at bae249b, the cited current source was reread, and exact claim_muxr68ei_2efcb59b was acquired before edits. S345 uses the required ChatGPT account action once. Exact account-kind and requiresOpenaiAuth checks remain; the paired disclosure keeps API-key fallback disabled. |
| 294 | `server/integrations.ts:924,925` | Changed | Context | Reopened after the integrator verified and released stale PR169-R8; remote main, origin/main and HEAD were reverified at bae249b, the cited current source was reread, and exact claim_muxr68ei_2efcb59b was acquired before edits. S346-S347 retain OpenAI as recipient, selected document/message contents, ChatGPT account/subscription and disabled API-key fallback in direct wording. The audit excerpt joins or normalizes source text; the captured source lines were inspected rather than claimed as one exact literal. |
| 295 | `server/integrations.ts:993,994` | Changed | Context | Reopened after the integrator verified and released stale PR169-R8; remote main, origin/main and HEAD were reverified at bae249b, the cited current source was reread, and exact claim_muxr68ei_2efcb59b was acquired before edits. S348-S349 keep the connection status-only: it doesn't generate responses or change local models or Hermes. Exact GET endpoint, request code and location fields are unchanged. The audit excerpt joins or normalizes source text; the captured source lines were inspected rather than claimed as one exact literal. |
| 296 | `server/integrations.ts:1127` | Changed | Excerpt | Reopened after the integrator verified and released stale PR169-R8; remote main, origin/main and HEAD were reverified at bae249b, the cited current source was reread, and exact claim_muxr68ei_2efcb59b was acquired before edits. S352-S353 state that AionCore isn't connected and Nectovia doesn't start it. Its found/available flags and absence of an adapter remain unchanged. |
| 297 | `server/integrations.ts:1324,1353,1395` | Changed | Excerpt | Reopened after the integrator verified and released stale PR169-R8; remote main, origin/main and HEAD were reverified at bae249b, the cited current source was reread, and exact claim_muxr68ei_2efcb59b was acquired before edits. S354-S356 name the policy, team-service or tool-restriction check. Read-only sandbox, network, provider, thread id and bounded MCP inventory checks still refuse before any turn; no model-turn tails are needed. |
| 298 | `server/integrations.ts:1561,1572` | Changed | Excerpt | Reopened after the integrator verified and released stale PR169-R8; remote main, origin/main and HEAD were reverified at bae249b, the cited current source was reread, and exact claim_muxr68ei_2efcb59b was acquired before edits. S357-S358 keep the failed answer or sanitized native error without a repeated fallback tail. TURN_FAILED/error handling, redaction, process reuse and no retry behavior remain unchanged. |
| 299 | `server/integrations.ts:1984,1989,1995,2028` | Changed | Excerpt | Reopened after the integrator verified and released stale PR169-R8; remote main, origin/main and HEAD were reverified at bae249b, the cited current source was reread, and exact claim_muxr68ei_2efcb59b was acquired before edits. S360-S363 distinguish original-account mismatch, unsupported copy/continuation and known thread-fork rejection. The thread id and uncertainty about original availability remain; unknown errors still rethrow. |
| 300 | `server/integrations.ts:1101,1103` | Changed | Excerpt | Reopened after the integrator verified and released stale PR169-R8; remote main, origin/main and HEAD were reverified at bae249b, the cited current source was reread, and exact claim_muxr68ei_2efcb59b was acquired before edits. S350-S351 name sample work, Nectovia's approvals/history and execution on this computer without AI. Sample identities, labels and execution behavior are unchanged. |
| 301 | `server/native-loop-routes.ts:395,397,549,550` | Changed | Excerpt | Copy edits S287.  |
| 302 | `server/native-loop-routes.ts:312` | Changed | Excerpt | Copy edits S286.  |
| 303 | `server/native-loop-routes.ts:764` | Retained | Excerpt | This refusal honors the person's explicit pause-when-owned-tool-unavailable setting; do not imply a fallback starts instead. |
| 304 | `server/native-work.ts:244,252,266,287,291,304,1114,1492,1497,1511` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 305 | `server/native-work.ts:1211` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 306 | `server/native-work.ts:312` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 307 | `server/native-work.ts:1249` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 308 | `server/native-work.ts:732,733` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 309 | `server/native-work.ts:1184` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 310 | `server/native-work.ts:1520,1528,1625,1640,1644` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 311 | `server/native-work.ts:1658` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 312 | `server/native-work.ts:721,722,931` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 313 | `server/pack-lifecycle.ts:253,266,273,626` | Changed | Excerpt | Copy edits S116, S117, S118, S120.  |
| 314 | `server/pack-lifecycle.ts:318` | Changed | Excerpt | Copy edits S119.  |
| 315 | `server/pack-lifecycle.ts:735,937,979,983,1126` | Retained | Excerpt | Activation and permissions are separate; branch/commit preservation, uncertain changes and existing dirty work remain explicit. |
| 316 | `server/pack-lifecycle.ts:395-403,543,620` | Changed / retained | Excerpt | Copy edits S120. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Activation and permissions are separate; branch/commit preservation, uncertain changes and existing dirty work remain explicit. |
| 317 | `server/pack-lifecycle.ts:1001` | Retained | Excerpt | Activation and permissions are separate; branch/commit preservation, uncertain changes and existing dirty work remain explicit. |
| 318 | `server/pack-lifecycle.ts:1028` | Retained | Excerpt | Activation and permissions are separate; branch/commit preservation, uncertain changes and existing dirty work remain explicit. |
| 319 | `server/pack-lifecycle.ts:903` | Retained | Excerpt | Activation and permissions are separate; branch/commit preservation, uncertain changes and existing dirty work remain explicit. |
| 320 | `server/store.ts:512,529` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 321 | `server/store.ts:671,760,773,1559,1568` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 322 | `server/store.ts:1745` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 323 | `server/store.ts:1888` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 324 | `server/store.ts:741` | Parent-owned | Excerpt | Integrator owns these hot source files; this lane leaves their findings for the combined ledger. |
| 325 | `server/workspaces.ts:152` | Retained | Excerpt | Membership administration propagates across devices. This is a noninferable account effect, separate from local sign-out. |
| 326 | `server/workspaces.ts:658` | Retained | Excerpt | Business-wide access is separate from exact effect approval and data-route consent. Preserve all three authorities. |
| 327 | `server/workspaces.ts:1088` | Changed | Excerpt | Copy edits S289.  |
| 328 | `server/workspaces.ts:1353` | Changed | Excerpt | Copy edits S288.  |
| 329 | `server/workspaces.ts:1902,1954` | Retained | Excerpt | Protected Owner access follows live ownership and cannot be assigned as an ordinary profile permission. |
| 330 | `server/workspaces.ts:278,291` | Retained | Excerpt | Internal authority-generation guard. It is not safe to replace the exact failure with a success or generic account state. |
| 331 | `server/work.ts:171,172,175,176` | Changed / retained | Excerpt | Copy edits S029, S030. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 332 | `server/work.ts:196,197` | Changed | Excerpt | Copy edits S031, S032.  |
| 333 | `server/work.ts:274,308` | Retained | Excerpt | Files changed outside the app can remain when a sample skips a write. Preserve outside-edit and partial-result evidence. |
| 334 | `server/work.ts:365` | Changed | Excerpt | Copy edits S327. Name the sample-task failure directly and preserve the appended partial-write count and History instructions. |
| 335 | `server/work.ts:316` | Changed | Excerpt | Copy edits S325, S326. Use the current product name for future sample output and give the available Review/History recovery action without a demonstration-purpose explanation. |
| 336 | `server/execution.ts:77,85,93,100,121,129,136,158,166,174,183,190` | Retained | Excerpt | Gate/payer traces are runtime evidence; changing a successful guard trace into a user approval would be misleading. |
| 337 | `server/execution.ts:165,166` | Retained | Excerpt | Gate/payer traces are runtime evidence; changing a successful guard trace into a user approval would be misleading. |
| 338 | `server/durable-controls.ts:687,693,705,706` | Retained | Excerpt | Resume checks distinguish original inputs, widened permission and current authorization. Ready-state absence is a primary fact. |
| 339 | `server/durable-controls.ts:701` | Retained | Excerpt | Resume checks distinguish original inputs, widened permission and current authorization. Ready-state absence is a primary fact. |
| 340 | `server/durable-controls.ts:546,556,995` | Retained | Excerpt | Resume checks distinguish original inputs, widened permission and current authorization. Ready-state absence is a primary fact. |
| 341 | `server/durable-controls.ts:755,756` | Retained | Excerpt | Resume checks distinguish original inputs, widened permission and current authorization. Ready-state absence is a primary fact. |
| 342 | `server/codex-controls.ts:51,56` | Retained | Excerpt | Native versus queued controls and thread continuity need truthful external-tool/protocol attribution; DIO-272 naming remains separate. |
| 343 | `server/codex-controls.ts:54,61,69` | Retained | Excerpt | Native versus queued controls and thread continuity need truthful external-tool/protocol attribution; DIO-272 naming remains separate. |
| 344 | `server/codex-controls.ts:273` | Retained | Excerpt | Native versus queued controls and thread continuity need truthful external-tool/protocol attribution; DIO-272 naming remains separate. |
| 345 | `server/file-drops.ts:66,78,80,84` | Retained | Excerpt | Separate file-drop rejection branches share one accurate failure message. They are not duplicate lines on one screen. |
| 346 | `server/file-drops.ts:103 + shared/file-drops.ts:203,204` | Changed / retained | Excerpt | Copy edits S045. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 347 | `server/file-drops.ts:186` | Retained | Excerpt | These are recorded paste/drop receipts attributing a completed human action, not helper text. |
| 348 | `server/file-imports.ts:156` | Retained | Excerpt | A historical import receipt identifies the person's completed action; it is not helper prose restating a button. |
| 349 | `server/guidance.ts:270` | Blocked | Excerpt | Live claim: supervision-guidance-followups (claim_mukn3b39_bbfe9011). Source inspected; no overlapping edit. |
| 350 | `server/guidance.ts:321` | Blocked | Excerpt | Live claim: supervision-guidance-followups (claim_mukn3b39_bbfe9011). Source inspected; no overlapping edit. |
| 351 | `server/guidance.ts:410,423,463,533` | Blocked | Excerpt | Live claim: supervision-guidance-followups (claim_mukn3b39_bbfe9011). Source inspected; no overlapping edit. |
| 352 | `server/review-comments.ts:155` | Changed | Excerpt | Copy edits S290.  |
| 353 | `server/task-execution.ts:148,158,184,194,203,205` | Retained | Context | Pack activation grants no authority; managed selection, sample work and worker billing limitations must remain distinct. The audit quote is shortened/templated or normalized; the cited source context was inspected, not claimed as a literal quote match. |
| 354 | `server/task-execution.ts:103,104` | Retained | Excerpt | Pack activation grants no authority; managed selection, sample work and worker billing limitations must remain distinct. |
| 355 | `server/task-execution.ts:197` | Retained | Excerpt | Pack activation grants no authority; managed selection, sample work and worker billing limitations must remain distinct. |
| 356 | `server/task-workflow.ts:196 + task-phase.ts:184` | Retained | Excerpt | Historical continuation receipt keeps the permission and scope under which the phase moved. |
| 357 | `server/agent-team-host.ts:139,188,466-487` | Retained | Excerpt | Required price bounds and account identity are runtime eligibility diagnostics; don't invent a price or downgrade a refusal. |
| 358 | `server/capability-packs.ts:145` | Retained | Excerpt | Activation versus authority and untrusted instructions are separate true boundaries. |
| 359 | `server/capability-packs.ts:405,406` | Retained | Excerpt | Activation versus authority and untrusted instructions are separate true boundaries. |
| 360 | `server/pack-contributions.ts:386` | Retained | Excerpt | Pack activation makes contributions available; it grants no authority. |
| 361 | `server/lineage-continuity.ts:120,125` | Retained | Excerpt | Visible history can remain while the model forgets it. The displayed-history fact is not inferable from memory failure. |
| 362 | `server/interaction-turn.ts:324,333,351` | Retained | Excerpt | Sending a new message is distinct from completing an accepted original request. Preserve retry identity and delivery semantics. |
| 363 | `server/interaction-turn.ts:325,334,352` | Retained | Excerpt | These receipts distinguish unfinished startup from a new request. The safe same-message retry requirement remains explicit. |
| 364 | `server/interaction-turn.ts:255` | Changed / retained | Excerpt | Copy edits S137, S138, S139, S140, S141. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 365 | `server/interaction-turn.ts:258,259` | Changed | Excerpt | Copy edits S137, S138, S139, S140, S141.  |
| 366 | `server/interaction-turn.ts:253,261-263` | Changed | Excerpt | Copy edits S137, S138, S139, S140, S141.  |
| 367 | `server/interaction-service.ts:524` | Changed | Excerpt | Copy edits S142.  |
| 368 | `server/organization-export.ts:101,151,378` | Changed | Excerpt | Copy edits S131, S132.  |
| 369 | `server/organization-export.ts:224` | Retained | Excerpt | An export doesn't revoke keys, cancel work or delete records. Those offboarding actions are separate. |
| 370 | `server/organization-export.ts:241` | Retained | Excerpt | An export doesn't revoke keys, cancel work or delete records. Those offboarding actions are separate. |
| 371 | `server/organization-setup.ts:69` | Changed | Excerpt | Copy edits S218.  |
| 372 | `server/support-bundle.ts:89-112` | Retained | Excerpt | Disclosure must state exactly what a support copy can include before it is sent. |
| 373 | `server/update-reconcile.ts:534` | Retained | Excerpt | Cache clearing versus persisted storage is a noninferable update effect boundary. |
| 374 | `server/ready-scheduler.ts:104` | Changed | Excerpt | Copy edits S291.  |
| 375 | `server/ready-scheduler.ts:347,410,411,420,428` | Changed | Excerpt | Copy edits S328-S333. Current Ready receipts name Nectovia and the actual automatic start, refusal, enable, pause or resume event. Existing stored history and actor identity remain intact. |
| 376 | `server/weekly-brief.ts:286,292,299` | Retained | Excerpt | Inactive versus blocking business setups are distinct refusal states. Keep the required activation/problem review instead of implying a brief was prepared. |
| 377 | `server/permission-routes.ts:116` | Retained | Excerpt | Revocation blocks future writes; already-dispatched effects may finish. |
| 378 | `server/migrations/files.ts:61,71,102 + framework.ts:83-150` | Retained | Excerpt | Failed migration/read-only backup handling must preserve data-loss and backup evidence; do not imply a successful migration. Failed migration/read-only backup handling must preserve data-loss and backup evidence. |
| 379 | `server/local/hardware.ts:282,288,292,300,309` | Retained | Excerpt | Local hardware discovery distinguishes unavailable evidence from absent hardware. This diagnostic needs local-model ownership review before replacing it with a hardware claim. |
| 380 | `server/outcome-evidence/projection.ts:55,74,75` | Retained | Excerpt | Associated revenue versus incremental contribution is a financial measurement boundary. |
| 381 | `server/readiness/instructions.ts:105,150,152` | Retained | Excerpt | Shipped model prompt and installed-build identity evidence are outside the prose rewrite scope. |
| 382 | `server/relay/ports.ts:53` | Changed | Excerpt | Copy edits S133.  |
| 383 | `server/relay/messages.ts:103,111` | Changed / retained | Excerpt | Copy edits S134. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 384 | `server/change-review/render.ts:93,95,97` | Changed / retained | Excerpt | Copy edits S135. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 385 | `server/change-review/partial-keep.ts:143` | Changed | Excerpt | Copy edits S136.  |
| 386 | `server/change-review/partial-keep.ts:78,79,88,92` | Retained | Excerpt | Single-part and already-kept changes require specific actions. Do not turn a whole-change decision into a partial write. |
| 387 | `server/change-review/rules.ts:559,569` | Retained | Excerpt | Recorded field/source/destination deltas must preserve hidden-value handling. |
| 388 | `server/change-review/snapshot.ts:165` | Retained | Excerpt | Symbolic-link exclusion is a real read boundary, not general reassurance. |
| 389 | `server/bonsai/runtime.ts:18,25,26` | Retained | Excerpt | Exact active profile and local runtime mismatch are technical identity evidence; local-model claims need DIO-247 coordination. |
| 390 | `server/bonsai/probe.ts:132,133` | Retained | Excerpt | Observed model identity must distinguish absent, different and requested models. |
| 391 | `server/connections/openapi-candidate.ts:276,277,281,284,289` | Retained | Excerpt | Unreviewed connector candidate fields and OpenAPI validation errors must not imply a working live connection. |
| 392 | `server/connections/openapi-candidate.ts:42-318` | Retained | Excerpt | Unreviewed connector candidate fields and OpenAPI validation errors must not imply a working live connection. |
| 393 | `server/connections/service.ts:184,800` | Blocked | Excerpt | Live claim: connection-reauth (claim_mukn7wok_335094fa). Source inspected; no overlapping edit. |
| 394 | `server/connections/toast.ts:110,162,163,164` | Blocked | Excerpt | Live claim: connection-reauth (claim_mukn7wok_335094fa). Source inspected; no overlapping edit. |
| 395 | `server/connections/toast.ts:153-168` | Blocked | Excerpt | Live claim: connection-reauth (claim_mukn7wok_335094fa). Source inspected; no overlapping edit. |
| 396 | `server/connections/fixture-model.ts:29,40` | Retained | Excerpt | Synthetic transport/model fixture evidence cannot be rewritten into live-provider acceptance. |
| 397 | `server/discovery.ts:576,577,595,596,664,681,726,775,784` | Changed | Excerpt | Copy edits S335-S344. Remove redundant installed/running detail already carried by status/version fields. Keep actual tool identity and unsupported-use facts; only future detail strings use Nectovia. |
| 398 | `server/discovery.ts:21` | Retained | Excerpt | Passive discovery doesn't launch a local service or send a model request. This is a noninferable resource/billing boundary. |
| 399 | `server/discovery.ts:361` | Retained | Excerpt | An installation alone does not prove a usable connection. Preserve actual readiness evidence. |
| 400 | `server/codex-setup.ts:54-161` | Retained | Excerpt | The person signs in to their own external tool account. The destination/vendor name is required identity, not a marketing reference. |
| 401 | `server/models.ts:98-120` | Changed | Excerpt | Copy edits S292.  |
| 402 | `server/inventory/*.ts` | Retained | Excerpt | Inventory retention/archival diagnostics protect receipt deduplication. They are internal assertions, not new reader-facing prose. |
| 403 | `server/evaluation/route-matrix.ts:375, server/harness/conformance.ts:270,280,318,345,347` | Retained | Excerpt | Engineering evidence report text is outside reader-facing copy; don't rewrite historical acceptance evidence. Engineering conformance diagnostics are outside reader-facing copy. |
| 407 | `shared/automations.ts:406,407` | Changed | Excerpt | Copy edits S047, S048, S049, S050, S051.  |
| 408 | `shared/automations.ts:411,414` | Changed | Excerpt | Copy edits S048, S049, S050, S051.  |
| 409 | `shared/automations.ts:435,436,607,608` | Changed / retained | Excerpt | Copy edits S054, S055. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 410 | `shared/automations.ts:397,423,426,428` | Changed | Excerpt | Copy edits S046, S047, S052, S053, S054, S055.  |
| 411 | `shared/automations.ts:610` | Changed | Excerpt | Copy edits S334. Keep data, approval, checks, missed and blocked jobs as the same attention categories while removing assistant waiting prose. |
| 412 | `shared/business-setup.ts:58,70` | Retained | Excerpt | A rehearsal is unavailable and the first draft is a real job requiring review. Keep this actual capability/effect distinction. |
| 413 | `shared/business-setup.ts:175,183,192,203,211,230,243,260,275,288,297,304` | Changed | Excerpt | Copy edits S176, S177, S178, S179, S180, S181, S182, S183, S184, S185, S186.  |
| 414 | `shared/business-setup.ts:175,203,230,243,297` | Changed | Excerpt | Copy edits S176, S177, S179, S180, S181, S182, S186.  |
| 415 | `shared/business-setup.ts:211,243,288` | Changed | Excerpt | Copy edits S179, S180, S182, S185.  |
| 416 | `shared/business-setup.ts:192` | Changed | Excerpt | Copy edits S178.  |
| 417 | `shared/business-setup.ts:260` | Changed | Excerpt | Copy edits S183.  |
| 418 | `shared/capability-packs.ts:206,229` | Retained | Excerpt | Pack activation authority boundaries and model-facing professional-advice instructions are outside presentation-only changes. |
| 419 | `shared/capability-packs.ts:284,285,287,289` | Retained | Excerpt | Pack activation authority boundaries and model-facing professional-advice instructions are outside presentation-only changes. |
| 420 | `shared/capability-packs.ts:355,395` | Retained | Excerpt | Pack activation authority boundaries and model-facing professional-advice instructions are outside presentation-only changes. |
| 421 | `shared/small-business-skills.ts:30` | Retained | Excerpt | Shipped skill/model instructions are outside this lane; starter text needs separate prompt-effect review. |
| 422 | `shared/small-business-skills.ts:33,481` | Retained | Excerpt | Shipped skill/model instructions are outside this lane; starter text needs separate prompt-effect review. |
| 423 | `shared/small-business-skills.ts:63,210` | Retained | Excerpt | Shipped skill/model instructions are outside this lane; starter text needs separate prompt-effect review. |
| 424 | `shared/small-business-skills.ts:123` | Retained | Excerpt | Shipped skill/model instructions are outside this lane; starter text needs separate prompt-effect review. |
| 425 | `shared/small-business-skills.ts:254,298,391` | Retained | Excerpt | Shipped skill/model instructions are outside this lane; starter text needs separate prompt-effect review. |
| 426 | `shared/configuration.ts:161` | Changed | Excerpt | Copy edits S223.  |
| 427 | `shared/configuration.ts:738` | Changed | Excerpt | Copy edits S224.  |
| 428 | `shared/configuration.ts:1084` | Changed | Excerpt | Copy edits S226.  |
| 429 | `shared/execution.ts:138,145,153,159` | Changed | Excerpt | Copy edits S228, S229.  |
| 430 | `shared/execution.ts:205` | Changed | Excerpt | Copy edits S231, S232.  |
| 431 | `shared/execution.ts:83,470,490,493,495,498` | Changed | Excerpt | Copy edits S227, S235, S236, S237, S238, S239, S240.  |
| 432 | `shared/execution.ts:192,210,214,358,492,497` | Changed | Excerpt | Copy edits S230, S231, S232, S233, S234, S236, S237, S238, S239, S240.  |
| 433 | `shared/packs.ts:361,431,472,487,512,526` | Retained | Excerpt | Setup provenance distinguishes recorded answers, unsupported automatic handoffs and real authority. Keep absent configuration explicit. |
| 434 | `shared/packs.ts:315` | Retained | Excerpt | Setup provenance distinguishes recorded answers, unsupported automatic handoffs and real authority. Keep absent configuration explicit. |
| 435 | `shared/packs.ts:401,457,498` | Retained | Excerpt | Setup provenance distinguishes recorded answers, unsupported automatic handoffs and real authority. Keep absent configuration explicit. |
| 436 | `shared/packs.ts:299,300` | Retained | Excerpt | Setup provenance distinguishes recorded answers, unsupported automatic handoffs and real authority. Keep absent configuration explicit. |
| 437 | `shared/packs.ts:355,381` | Retained | Excerpt | Setup provenance distinguishes recorded answers, unsupported automatic handoffs and real authority. Keep absent configuration explicit. |
| 438 | `shared/permissions.ts:308,341` | Changed | Excerpt | Copy edits S159, S160, S161, S162, S163, S164.  |
| 439 | `shared/permissions.ts:305,323,340` | Changed / retained | Excerpt | Copy edits S159, S160, S161, S162, S163, S164. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Actual OS containment, per-task write scope, sending consent and human review provenance remain distinct. |
| 440 | `shared/permissions.ts:339` | Changed | Excerpt | Copy edits S161, S162, S163, S164.  |
| 441 | `shared/permissions.ts:338,342` | Changed | Excerpt | Copy edits S161, S162, S163, S164.  |
| 442 | `shared/permissions.ts:354,356,358` | Changed / retained | Excerpt | Copy edits S165, S166. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Actual OS containment, per-task write scope, sending consent and human review provenance remain distinct. |
| 443 | `shared/stream-rules.ts:534,536,538,540,541,564` | Changed | Excerpt | Copy edits S170, S171, S172, S173, S174, S175.  |
| 444 | `shared/stream-rules.ts:526,420` | Changed / retained | Excerpt | Copy edits S170, S171. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 445 | `shared/native-loop.ts:566,567,573,613` | Changed | Excerpt | Copy edits S061, S062, S063, S064, S065.  |
| 446 | `shared/handoff.ts:115` | Changed | Excerpt | Copy edits S241, S242.  |
| 447 | `shared/handoff.ts:198` | Changed | Excerpt | Copy edits S244.  |
| 448 | `shared/handoff.ts:185` | Changed | Excerpt | Copy edits S243.  |
| 449 | `shared/handoff.ts:266,271,272` | Retained | Excerpt | Worker model occupancy and actual delegated authority must remain distinct. |
| 450 | `shared/access.ts:97` | Retained | Excerpt | Paid eligibility and credit lifetime remain factual and unchanged; duplicate server gate branches are separate checks. |
| 451 | `shared/access.ts:326,341,399,402,405` | Changed | Context | Copy edits S066, S067.  The audit quote is shortened/templated or normalized; the cited source context was inspected, not claimed as a literal quote match. |
| 452 | `shared/access.ts:399,405` | Retained | Excerpt | Paid eligibility and credit lifetime remain factual and unchanged; duplicate server gate branches are separate checks. |
| 453 | `shared/access.ts:326,329` | Changed | Excerpt | Copy edits S066, S067.  |
| 454 | `shared/access.ts:339,349` | Retained | Excerpt | Paid eligibility and credit lifetime remain factual and unchanged; duplicate server gate branches are separate checks. |
| 455 | `shared/agents.ts:265,267` | Retained | Excerpt | Worker contract summaries must preserve who can write/apply a change; changing Agent definitions is outside this pass. |
| 456 | `shared/board-moves.ts:70,96,137,168` | Changed / retained | Excerpt | Copy edits S169. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 457 | `shared/board-moves.ts:121,145` | Changed | Excerpt | Copy edits S167, S168, S169.  |
| 458 | `shared/board-moves.ts:118,126,127` | Changed / retained | Excerpt | Copy edits S167, S168. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 459 | `shared/instruction-view.ts:97-99` | Retained | Excerpt | Permission is rechecked at the actual write, separately from initial approval; this is a real authority boundary. |
| 460 | `shared/capability-record.ts:196,226` | Retained | Excerpt | Build identity, published-release evidence and publisher identity are separate evidence scopes. |
| 461 | `shared/data-coverage.ts:376` | Retained | Excerpt | Fallback cannot widen source or destination scope. Unknown fields must remain unknown. |
| 462 | `shared/data-coverage.ts:486` | Retained | Excerpt | Fallback cannot widen source or destination scope. Unknown fields must remain unknown. |
| 463 | `shared/escalation-roles.ts:27,74` | Retained | Excerpt | Credit payer must remain visible wherever a separately chargeable role is chosen. |
| 464 | `shared/individual-plan.ts:210,211` | Changed | Excerpt | Copy edits S059, S060.  |
| 465 | `shared/individual-plan.ts:36,43` | Retained | Excerpt | Individual eligibility remains Personal-only; it must not be broadened into Business membership. |
| 466 | `shared/managed-usage.ts:230-242` | Retained | Excerpt | Credit eligibility, purchased-versus-included usage, unknown limits and exact money invariants remain separate from copy. |
| 467 | `shared/managed-usage.ts:241,242` | Retained | Excerpt | Credit eligibility, purchased-versus-included usage, unknown limits and exact money invariants remain separate from copy. |
| 468 | `shared/managed-usage.ts:240` | Retained | Excerpt | Credit eligibility, purchased-versus-included usage, unknown limits and exact money invariants remain separate from copy. |
| 469 | `shared/managed-usage.ts:377` | Retained | Excerpt | Credit eligibility, purchased-versus-included usage, unknown limits and exact money invariants remain separate from copy. |
| 470 | `shared/managed-usage.ts:445,459,744-800,1038,1177` | Retained | Excerpt | Credit eligibility, purchased-versus-included usage, unknown limits and exact money invariants remain separate from copy. |
| 471 | `shared/managed-usage.ts:1044` | Retained | Excerpt | Credit eligibility, purchased-versus-included usage, unknown limits and exact money invariants remain separate from copy. |
| 472 | `shared/managed-usage.ts:71` | Retained | Excerpt | Credit eligibility, purchased-versus-included usage, unknown limits and exact money invariants remain separate from copy. |
| 473 | `shared/organization-export.ts:190,205,238` | Retained | Excerpt | Export credential exclusions and separate offboarding actions are noninferable data/authority boundaries. |
| 474 | `shared/organization-setup.ts:195,237` | Changed | Excerpt | Copy edits S245, S246.  |
| 475 | `shared/organization-setup.ts:198` | Changed / retained | Excerpt | Copy edits S245. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 476 | `shared/setup-question-changes.ts:61,65` | Changed | Excerpt | Copy edits S247, S248.  |
| 477 | `shared/customization-entitlement.ts:102,173` | Blocked | Excerpt | Live claim: DIO-252 (claim_mux69zuq_67519943). Source inspected; no overlapping edit. |
| 478 | `shared/team-delegation.ts:679` | Retained | Excerpt | The worker's answer cannot verify its own outcome; declared lead checks remain authoritative. |
| 479 | `shared/team-routes.ts:81` | Retained | Excerpt | Supported team transport and exact owned-tool identity need DIO-272 naming reconciliation. |
| 480 | `shared/rule-authority.ts:156,177,240` | Retained | Excerpt | Guidance and untrusted data grant no enforcement authority. Keep this runtime distinction. |
| 481 | `shared/session-controls.ts:126,129,130,131` | Changed | Excerpt | Copy edits S250.  |
| 482 | `shared/session-controls.ts:111` | Changed | Excerpt | Copy edits S249.  |
| 483 | `shared/workspaces.ts:248,386` | Changed | Excerpt | Copy edits S251.  |
| 484 | `shared/task-workflow.ts:104,131,141` | Retained | Excerpt | Manual Team cards and native-loop phases are different control owners; preserve actual start/move behavior. |
| 485 | `shared/agent-profiles.ts:170` | Changed | Excerpt | Copy edits S252, S253.  |
| 486 | `shared/attribution.ts:144,150,151` | Retained | Excerpt | Historical attribution and runtime-reported model identity must not be renamed or inferred. |
| 487 | `shared/route-unavailable.ts:9` | Changed | Excerpt | Copy edits S068.  |
| 488 | `shared/conversation-engines.ts:66, evaluation-eligibility.ts:83, interaction.ts:297,341, predicates.ts:249, verification.ts:336` | Changed / retained | Excerpt | Copy edits S056. A quoted fragment still appears in the cited area; retained precision or remaining wording needs the note below. Only the listed exact edits are resolved; repeated/other instances remain for visibility and meaning review. |
| 489 | `shared/work-style.ts:335,337,339,341,368` | Retained | Excerpt | Exact requested/selected/reported model identities are truthful attribution and owned-tool setup; DIO-272 remains separate. |
| 490 | `shared/work-style.ts:397,398` | Retained | Excerpt | Exact requested/selected/reported model identities are truthful attribution and owned-tool setup; DIO-272 remains separate. |
| 491 | `shared/engine-routes.ts:58,77,93,111,128` | Retained | Excerpt | Owned account sign-in, subscription/API billing and disabled tool boundaries must retain exact service identity. |
| 492 | `shared/engine-routes.ts:93` | Retained | Excerpt | Owned account sign-in, subscription/API billing and disabled tool boundaries must retain exact service identity. |
| 493 | `shared/engine-routes.ts:111` | Retained | Excerpt | Owned account sign-in, subscription/API billing and disabled tool boundaries must retain exact service identity. |
| 494 | `shared/engine-routes.ts:98,116` | Retained | Excerpt | Owned account sign-in, subscription/API billing and disabled tool boundaries must retain exact service identity. |
| 495 | `shared/engine-routes.ts:48,63,82` | Retained | Excerpt | Owned account sign-in, subscription/API billing and disabled tool boundaries must retain exact service identity. |
| 496 | `shared/engines.ts:264,269,274` | Retained | Excerpt | Disabled tools and prompt instructions do not provide OS containment; preserve that noninferable security limit. |
| 497 | `shared/model-api.ts:73,91,125` | Retained | Excerpt | Internal dated provider price-card evidence is not public pricing; source ids/units remain unchanged. |
| 498 | `shared/routing-policy.ts:319-482` | Retained | Excerpt | Data-processing geography, retention and price ceilings are exact eligibility diagnostics; don't weaken policy for prose. |
| 499 | `shared/route-capabilities.ts:297-319` | Retained | Excerpt | Caching observations distinguish checked reuse from unconfirmed provider behavior; preserve evidence scope. |
| 521 | `services/control-plane/src/commercial.ts:831 + funding.ts:1100,1218 + managed-inference.ts:334,337,341,1453 + routing.ts:228,248 + managed-bindings.ts:262 + organization-setup/service.ts:66` | Changed | Excerpt | Copy edits S293, S294, S295, S296, S297, S298, S299, S300, S301, S302, S303.  |
| 522 | `services/control-plane/src/account-service.ts:302,306,310` | Retained | Excerpt | Invitation secrecy and active-owner membership administration are authorization boundaries; repeated refusal branches are distinct. |
| 523 | `services/control-plane/src/account-service.ts:125,264` | Retained | Excerpt | Invitation secrecy and active-owner membership administration are authorization boundaries; repeated refusal branches are distinct. |
| 524 | `services/control-plane/src/credit-purchases.ts:841` | Blocked | Excerpt | Live claim: B04.BILLING (claim_muxo2vai_caee3ba1). Source inspected; no overlapping edit. |
| 525 | `services/control-plane/src/funding-postgres.ts:28-110` | Retained | Excerpt | Stored-money validation uses the real safe integer unit; it is an internal persistence diagnostic. |
| 526 | `services/control-plane/src/funding.ts:586` | Retained | Excerpt | Only the current billing period funds new work. Preserve actual money invariants and hold state. |

## Coverage retained outside this lane

The audit also includes release notes, resources, desktop, top-level engineering docs, and ops, Android, iOS and macOS workspaces. This lane does not rewrite shipped historical release records or model-facing product facts. Desktop and top-level client/hot server files are assigned to the integrator. Other workspace implementation and the macOS older-copy reconciliation are not claimed complete by this server/shared ledger. The audit's original skipped areas remain unverified; this patch is not a new full read of every app string or control-plane endpoint.

Local source edits and static checks do not establish merge, publication, provider acceptance, device behavior, payment acceptance or customer acceptance. The integrator must attach the exact final gate candidate and results before those claims.
