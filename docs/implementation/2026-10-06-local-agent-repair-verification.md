# Local Agent repair verification

Status: deterministic gates and independent hostile review passed; GPU qualification pending.

- Owner: primary Codex chat `01a112d4-dbf2-70b3-a290-da1d2bb2e553`.
- Feature: local-agent-repair-verification.
- Issues: DIO-255, DIO-257, DIO-254 under DIO-247.
- Branch: `feature/local-agent-repair-verification`.
- Worktree: `F:/Diomedes/diomedes-wt/local-agent-repair-verification`.
- Published main at composition: `f885d50e235cd900312976d0f36618d180f2b54a`.
- Committed DIO-247 proof stack: `9e03d6ebdaf5e072453b5a8911b99d7b799249ad`.
- Initial clean composition: `a73e53d936c615866732d75cd1eb4bc09c8e318e`.
- Andrew first directed this chat to let `local-agent-loop` finish. After its
  commits and the hostile findings, he explicitly authorized the handoff and
  completion of the fixes in this isolated branch. Later DIO-256 edits in the
  author worktree are preserved and are not imported.
- Andrew authorized the repair PR targeting main and hostile verification.
  No deployment or installed-app replacement is authorized by that request.

The independent socket regression distinguishes request abort from a mock
promise rejection and exercises the proof recorder's stream tee. It is a
transport diagnostic, not evidence of llama.cpp stopping GPU inference or of
RunService delivering a child cancellation. Those require separate evidence.

Baseline transport diagnostic, 2026-10-06 20:46Z:

- Candidate: `a73e53d936c615866732d75cd1eb4bc09c8e318e`, plus the independent
  `tests/local-agent-repair-verification.test.ts` test file.
- `vitest run tests/local-agent-repair-verification.test.ts`: 4 passed,
  0 failed, 0 skipped. One file passed. Output: Codex command chunk `5904ed`.
- Both pending-header and open-stream requests disconnect after Stop, with
  and without a recording tee. The successor request sees no active request.
- This passed before the repair commits. It does not reproduce the abandoned
  GPU request and cannot certify the host-to-child cancellation path.

Independent baseline regressions, 2026-10-06 20:51Z:

- Same baseline and test file, now 8 tests: **4 expected failures, 4 passed,
  0 skipped**. Output: Codex command chunks `34c30a` and `760ab5`.
- The real advisor and sandboxed worker each returned 24,000 of 287,231
  characters, excluding the decisive tail record (two failing tests).
- The persisted advisor budget was 120,000 ms (one failing test).
- The post-advice prompt counted at 122,689 tokens was refused before
  dispatch, although omitting completed reasoning would count at 118,800
  within 119,808 input room (one failing test). Counts are scripted; this is
  branch verification, not a GPU tokenizer measurement.
- The four real socket cancellation controls passed again.
- An earlier collection attempt failed before executing any tests because
  this new worktree lacked the control-plane dependency junction. The root
  and control-plane installs now reuse the proof worktree's existing installs
  after matching their lockfile hashes. No package was added or installed.

The frozen eight-test baseline was captured again in
`tmp/local-agent-verification/baseline.json`: 4 expected failures, 4 passed,
0 skipped. A separate recovery boundary test then failed on the baseline:
an already expired saved advisor still constructs an adapter. Its focused
result is `tmp/local-agent-verification/recovery-baseline.json`: 1 failed,
0 passed, 8 filtered out. At this baseline it remained an unresolved regression,
not a passing cancellation claim. The baseline and independent fixtures passed TypeScript
before that additional recovery test was added.

Initial repaired composition: `65efe86f71b5d5e48e91f28bd09cc943bd021a6e`, importing
author commit `f132fd0e76e17700a8118192eefd1aa841ca6223`. The author's tracked
worktree was clean at import; none of its untracked files were copied.

Focused verification, 2026-10-06 21:09Z: **23 passed, 1 failed, 0 skipped** in
four files (`local-agent-repair-verification`, `local-loop-reads`,
`local-make-room`, `local-child-stop`). Evidence:
`tmp/local-agent-verification/initial-candidate.json`. All four original
baseline failures now pass. The expired-advisor recovery failure remains.
Independent test SHA-256:
`7e298dde22c5baa8e2178d187c8cabc718440d71689e99c951abb07b70d8e897`.

The author controls also exercise child cancellation through the real host
and a loopback socket, including delayed durable cancellation. They do not
establish that delayed persistence caused the October 6 GPU observation.
That initial candidate was not accepted. No GPU run has been executed here.

## Corrections after hostile review

The independent native Codex GPT-6.1 Sol reviewer rejected the initial candidate:
5 claims confirmed, 2 partial, 3 refuted. The primary agent checked the cited
paths and reproduced the findings before editing. Four focused hostile tests
then failed as expected: a surrogate-splitting partial read, expired recovery,
folding a newly received read, and ten counting attempts instead of at most
three. `tmp/local-agent-verification/hostile-red.json` records 0 passed,
4 failed, 14 filtered out.

The corrective candidate adds:

- Shared local read coverage: full UTF-16 length, returned range and UTF-8
  bytes, without splitting surrogate pairs. Host-derived coverage and a
  warning survive worker/advisor handoff, durable ledger read and reuse.
- Saved child budgets govern recovery. Already expired or stopped children
  are cancelled before claiming or constructing an adapter. Immediate abort
  is local-only; durable cancellation is awaited and still owns settlement.
- At most three counted bodies: original, completed tool-exchange reasoning
  removed, and one eligible read omitted. Read omission is lead-only, directly
  after a visible draft and completed advice. The immediately preceding full
  read must match the advisor's host-recorded path/hash/scope/result digest.
  Children never omit read bodies. Missing evidence produces an unsent refusal.
- A versioned projection receipt records counts, window/reserves, source and
  result hashes, advisor read identity and the durable original transcript.
  The original source and reasoning stay in that transcript, including after
  reopening the store. Calls that fit retain their original request bytes.

The bounded reasoning stage removes completed reasoning together, instead of
recounting after every message. This can change the cached prefix on an
overflowing call; projected-call cache behavior must be measured separately.
It does not change the unchanged-conversation cache acceptance target.

Focused final candidate run: **51 passed, 0 failed, 0 skipped**, five files,
recorded in `tmp/local-agent-verification/focused-final.json`. It includes
real-host reads, Unicode/truncation handoffs, recovered expiry and parent Stop,
late child answers/tool calls, real HTTP cancellation, projection eligibility
negative controls, immutable durable transcripts and existing cloud team tests.
This supersedes intermediate correction runs (25/2, 48/0 and 27/0), which remain
in the local evidence directory. Counts here are from one run, not their sum.

The PR composition includes the still-unmerged DIO-247 prerequisite commits
for local long context, N4 conversation prefix reuse and conversation read
progress, plus DIO-251 admission. Their commits remain distinct from these
three repairs. DIO-256's later Agent/Work read-progress edits are excluded.
The canonical mirrors remain at version 2026-10-06.1; no product definition,
authority or roadmap completion status changes in this slice.

The second hostile pass confirmed 9 claims and found one remaining defect:
matching historical reads could authorize omission after the file changed.
The real-host regression reproduced it: `freshness-red.json` records 1 passed
unchanged-source control, 1 expected failure, 16 filtered out. The corrected
host now rechecks source hash and bytes through the same guarded project
reader after the final token count and before dispatch. Failed, missing or
changed sources refuse unsent. The receipt records the check time. No extra
tool authority or model call is introduced.

`focused-v3.json` records **53 passed, 0 failed, 0 skipped**. It also proves a
real lead/advisor read-folding chain, preserved original transcript on reopening,
and no final inference after source change during advice. A further control
changes the file during the last tokenizer call. The earlier full-unit run was
deliberately interrupted when the candidate changed and provides no gate result.
Earlier successful TypeScript/build results are historical until rerun.

The final independent hostile pass confirmed all 10 bounded claims, with no
unresolved code finding. The reviewer checked all 62 source/test hashes at
opening and closing against `candidate-v3.json` (SHA-256
`5256efad451bddb7d73718a327107954d89a903162b53379d3fa1c3f56563f92`). The parent
also checked the live `Store.current` read and the final dispatch ordering.
This is source/deterministic evidence, not GPU qualification. Reviewer route:
native Codex GPT-6.1 Sol, high effort, read-only, no fallback or outside provider.

The v3 TypeScript check passed with exit 0; Vite rebuilt successfully in 26.79 s
with its bundle-size warnings. An initial v3 full-unit attempt hit the sandbox's
Windows process-query denial in `coordination.test.ts` and was stopped. The same
test passed without source changes using normal OS process access: 1 passed,
0 failed, 84 filtered (`process-query-control.json`). The complete rerun passed
in that environment. Neither interrupted attempt is a completed gate.

## Final deterministic acceptance

The final source/test hashes match the independently reviewed manifest above.
The required gates completed on 2026-10-06:

| Gate | Result | Local evidence under `tmp/local-agent-verification/` |
| --- | --- | --- |
| TypeScript, `tsc --noEmit` | Passed, exit 0 | `typecheck-v3.log` and command exit |
| Full unit suite, `vitest run --maxWorkers=4` | 614 files passed; 10,297 tests passed, 0 failed, 5 skipped; 1,140.48 s | `full-vitest-final.json`, `full-vitest-final.log` |
| Client build, `vite build` | Passed, exit 0; 26.79 s; bundle-size warnings | `build-v3.log` |
| Browser gate, `playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts` | 36 passed, 0 failed, 0 skipped, 0 flaky; 152.29 s | `playwright-final.json`, `playwright-final.log` |

The same full-unit run includes 54 passed, 0 failed, 0 skipped in the five
focused files: independent repair verification (13), local read parity (5),
local child Stop (4), local make-room (19), and existing team host (13).
This includes the source mutation during the final tokenizer call. These 54
are part of the 10,297 total, not an additional run or an additive total.

The five skipped assertions are outside those focused files. Their exact names
remain in the full JSON report. Raw reports, the frozen manifest and review
briefs are preserved locally without staging the scratch directory. The
committed record contains their results and boundaries. No GPU qualification,
roadmap completion, merge, deployment or installed-app acceptance follows
from these gates.

## Required GPU proof after deterministic acceptance

All cells below are **DID_NOT_RUN** for the repaired candidate. The October 6
proofs are baseline evidence only. Do not mark the issues accepted from unit
tests or merge status.

Freeze the implementation commit/tree, runner, fixture, grader, descriptor,
model, llama runtime and template hashes in a new manifest. Preserve the
original proof directory. Use the existing exclusive GPU slot and watchdog.
No installed-app replacement is part of this repair.

- Models: Ornith 1.5 35B-A3B AD-Q4 and Qwen3.8 27B UD-IQ3_S.
- Window: 131,072; medium effort; thinking enabled; 4,096 reasoning tokens
  within an 8,192 total output cap. Keep the phase-1 GPU placement, KV, batch
  and microbatch configuration. Record actual cache RAM and headroom guards.
- Documents: original `ledger-100k-distributed` (99,839 document tokens) and
  `ledger-115k-distributed` (114,959). The first is nominal 100K and does not
  itself certify a 100,000-plus document threshold.
- Tokenize each actual rendered request. Expected answers belong only in the
  offline grader. Record cold versus warm starts separately.

| Cells | Combinations | Runs | Required outcome |
| --- | --- | ---: | --- |
| G01-G04 | Both models x both documents, three repeats | 12 | Whole lead read, completed nonempty advice, completed post-advice lead call, correct final answer, no abandoned inference. |
| G05-G08 | Both models x both documents, explicit worker and advisor reads | 4 | Real sandbox worker, advisor and lead each read the intended complete snapshot and the lead finishes. Merely configuring a seat does not count. |
| G09-G16 | Both models x wall expiry/parent Stop x prefill/decode, 115K | 8 | Child abort, correlated server cancellation, slot release and a successful successor; no late tools or advice. Use a test-only shorter admitted ceiling. |
| G17-G20 | Both models x conversation with same-file follow-up/Work, 115K | 4 | Conversation correct with at least 95% same-file reuse. Grade Work separately and preserve approval state; report any DIO-258 recurrence. |
| Total | 20 scenario cells | 28 | All unrun. |

The original replay prompt does not guarantee child reads, so explicit-read
cells are mandatory. Grade final values and strict JSON format separately:
SKU-A/B/C units 13/9/5, approved_cents 46475, held_cents 4525,
payment_authorized false, sources GRANT/INV-v2/PO-v2/REC-v2. A waiting write
proposal is not a final answer; do not approve it to improve the grade.

Record run, child, role, step, attempt and provider request IDs. Measure read
range/hash, preflight and dispatched input tokens, output/reasoning counts,
deadlines, context reductions, advisor result and final answer. The historical
runner's last-call/largest-prompt heuristics cannot identify the post-advice
lead reliably after a refusal or context reduction.

Freeze cancellation thresholds before execution: app abort within 1 second,
loopback disconnect within 2 seconds, live server release within 5 seconds.
Record successor queue delay separately from its prefill. Missing correlated
server evidence means UNVERIFIED, even when the application promise rejects.
Measure decode at occupied context against the 30 tok/s floor. Correctness
alone is not speed qualification. Report cache changes from context reduction
separately; do not lower the conversation reuse requirement.

## Scope and authority

DIO-256 Agent/Work progress UI, DIO-258 empty Work answers, and the broader
NC-MEM-LC compaction program stay separate. The separately owned DIO-251
admission commit is a prerequisite in the author's stack, not a duplicate
implementation. This repair must preserve Runtime/Trust path scope, downstream
sharing grants, child admission, account/payer binding, approvals, sandbox
ownership and uncertain-effect reconciliation. A larger reader or deadline
grants no effect authority. Canonical source transcripts remain durable.

## Owner decision: the newest reasoning first, 2026-10-06

Andrew chose to change the reasoning stage before the loop is run again on the GPU. The newest
completed turn's reasoning is now removed first and the call counted again. Every completed turn's
reasoning is removed only when that was not enough, and the eligible read is then folded as before,
so a call is counted at most four times (`server/engines/bonsai.ts`, `makeRoom`).

The newest turn follows the document the lead read. Removing only its reasoning sends everything up
to and including the document exactly as before, so the local server keeps that prefix in its
cache. An older turn's reasoning can come before the document, and removing it meant reading the
whole document again before the first word of the answer. This supersedes the paragraph above on removing completed reasoning together; its note that projected
calls need their own cache measurement still stands for a call that needs the second stage.

Tests in `tests/local-make-room.test.ts`: the O2 shape now fits after the first stage and sends its
first four messages unchanged, the read turn's reasoning included; a new case needs both stages and
keeps the read whole; the folding case and the bound are four counts. A refused call whose read
can't be folded is still counted at most three times. These are scripted counts, not a GPU
measurement.
