# Independent source review record

Status: in progress. No independent acceptance verdict or current test pass.

Authorization: the user's implementation request explicitly requests independent
review where available. Read-only bounded reviews use the approved model router
skill and `ask-opencode.ps1 -Mode ask`. No tests, edits, servers, secrets,
publication, other chats or further delegation are authorized for the reviewer.

Route: verifier; `opencode-go/muse-spark-1.3-contributor`; OpenCode Go;
variant `high`. Live `opencode models opencode-go --verbose` and the adapter's
ValidateSet confirmed this route, high effort, tool use, a 1,048,576-token
context and 131,072-token output limit. No model/provider fallback was used.

## Routing, funding and persistence review

The first review returned concrete findings and hypotheses. Parent source
reconciliation found:

| Item | Disposition |
| --- | --- |
| Migration 009 omitted from runner | Confirmed; runner and migration test lists updated. |
| Individual authority locks lack runtime UPDATE privilege | Confirmed by source review; narrow column grant added to reviewed permission template; real PostgreSQL proof pending. |
| Preview ignores current model cooldown/credential availability | Confirmed; preview now uses the same filtered connections and circuit projection as snapshots/dispatch. |
| Concurrent Individual creation may duplicate identities | Not reproduced by source: existing per-person transaction advisory lock serializes creation. Real concurrency regression authored. |
| Faux funding company lock is a no-op | Store transactions already serialize the whole draft; this is not a second independent concurrency primitive. PostgreSQL behavior still needs its own tests. |
| New Individual may take legacy route without consent | Confirmed for the new scope; it now requires versioned setup. Existing organization legacy behavior is explicitly preserved by the user request. |
| Empty helper source header is treated as a restriction | Parser reused; only actual restrictions block on that condition, and the job retains their monotone union. Versioned accounts still exclude the unqualified optional helper. |
| Existing job may name another tier on a later attempt | Original cap is retained by openJob; a regression now proves no fallback cap reset. No new cap authority was added. |
| Colon in deterministic fallback attempt ID | Allowed by the existing run-id contract; needs endpoint coverage, not an encoding workaround. |
| Global affected-account scan can be expensive | Bounded source concern, not performance acceptance. Real scale measurement remains unverified. |

An independent cross-workspace transport/UI review ended before a report because
OpenCode's read-only workspace boundary refused the Operations directory. It
provided no acceptance evidence. A narrower app-only review was dispatched
without broadening that boundary. Operations review remains owed.

## Provider and desktop review

The retry completed as an app-only source review on the same Muse route. It ran
no tests. Parent reconciliation found:

| Item | Disposition |
| --- | --- |
| Desktop checkpoint header remains portable for sealed reasoning | Confirmed metadata defect; the desktop now derives the native route from the actual SDK reasoning parts and refuses mixed or unbound state. Gateway body-derived enforcement already prevented incompatible fallback. |
| Native tool mirror comparison depends on JSON key order | Confirmed; canonical JSON comparison now shares the existing request-digest semantics. Changed values still reject. Regression authored. |
| Binding can omit account scope | Production callers already supplied the scope, but the optional transport contract admitted an unsafe future call. Scope is now required and validated before dispatch; regression authored. |
| OpenRouter must always return an attempts array | Rejected against current official documentation: attempts is optional, while attempt identifies the successful ordinal. Existing checks require ordinal 1, exact sole endpoint, company payment and no modifying pipeline; any supplied attempts list is also validated. |
| Versioned receipt should accept null attempt routing | Rejected: every funded versioned gateway attempt stores immutable routing. Null is a legacy/unqualified record and cannot prove the account/request attribution required here. |
| Individual admission account id must equal tenant id | Rejected: the existing ledger account column carries the billing scope id; its compound tenant identity is deliberately distinct. |
| Routing snapshots are not validated | The client already schema-checks snapshots and verifies their scope. Additional final person/workspace checks now reject late admission and preference results after a workspace change. Regressions authored. |

[OpenRouter's field reference](https://openrouter.ai/docs/guides/features/router-metadata)
was refreshed for the optional attempts distinction. This is protocol evidence,
not a live endpoint test. The separately dispatched Operations-only review is
completed inside that workspace's read-only boundary.

## Operations review

The Operations-only Muse review returned a report without edits or test runs.
It found the staff bridge and credential isolation consistent with the existing
boundary by source inspection. Parent reconciliation found:

| Item | Disposition |
| --- | --- |
| Organization detail can show an earlier selection | Confirmed; account detail now remounts on the selected account, as Individual detail already did. |
| Older searches overwrite newer results | Confirmed; request sequence checks discard stale results, failures and scope changes. Lists show loading and clear prior results. |
| Model/deployment picker leaves the binding behind | Partly confirmed: Azure discovery returns deployment ids, which must update deployment rather than model. Fixed; fresh unqualified templates track model identity, while explicitly verified model versions remain distinct and require review. |
| Removing one backup incorrectly drops the attempt limit | Rejected: the handler reads the old backup count, which equals the remaining backups plus the primary. With two old backups, removing one caps attempts at two. |
| Individual loading state is missing | Confirmed; list and detail now show loading explicitly. |
| Individual actions retain old errors or allow duplicate clicks | Confirmed; one pending action guard covers agreement and withdrawal, errors clear on fresh reads, successful forms reset and the list refreshes. |
| Model input names a missing datalist | Confirmed; removed the inactive attribute, keeping the explicit discovery picker. |
| Empty global policy is labeled inherited | Confirmed; empty global policy says none published. |
| Routing load has no retry control | Added a retry action with current-error clearing and request sequencing. |

These corrections still need type, transport and browser checks. This review
does not substitute for those checks or for review of the eventual composed app.

## Integration source checks

Checkpoint validation now applies only to versioned routing. The existing legacy
tool-continuation regression must continue to accept its original gateway state;
new versioned client regressions check exact native headers and reject mixed or
foreign checkpoints before a local reservation.

Current AWS documentation distinguishes bearer authentication for Mantle's
[Responses](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html)
and [Chat Completions](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html)
from the x-api-key header for
[Messages](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html).
The binding now follows that distinction; three transport regressions are
authored but unrun. No credential or provider account was changed.

The prepared harness regression also covers directly supplied source rules on
an adapter without a preparation step. Its persistence fix remains pending the
four-path harness handoff; the test has not run.

Exhausted gateway requests now carry validated attempt receipts alongside their
non-success error responses. The desktop checks account/request/revision
attribution and attaches them to its failure. The run-details reader supports
failed-step receipts. A separate one-path handoff for `run-service.ts` is issued,
but its durable failure writer is still unapplied pending dependency composition
and the authored red-first regression. Neither the new client case nor the
failed-step restart case has run.

Every accepted fix still requires current focused validation and reconciliation
on the eventual composed candidate. Historical test results are not reused as
independent proof.

## Harness review and first diagnostic

The fourth bounded Muse source review examined the deferred harness patch and
its original nine authored regressions. It made no edits and ran no checks.
Reconciliation found two concrete boundaries needing repair after composition:
validate successful managed receipts before persistence, and translate malformed
or oversized source-rule inputs into the existing harness error contract.
Regressions are authored and unrun. Ancestor scope verification will also check
project identity. The suggested spend-identity gap was not substantiated: the
prepared request digest already binds profile and source restrictions.

Further owner inspection found conversation wrappers must preserve enforcement
capability, and follow-ups, carried history and the separate writing repair run
must inherit source rules from durable model steps. Three actual-driver cases
cover these paths. The failed external model-step expectation is correctly
`reconcile_required`, preserving the runtime's existing uncertainty semantics.
No runtime state transition was changed to satisfy the fixture.

The first frozen source diagnostic ran under `slot_mukzu4a5_a7532eb4` from
08:36:35 to 08:36:44 UTC on 2026-09-28. Control-plane type checking found five
errors; the policy/provider fixtures passed 55 of 58 tests, with all three
failures in Responses fixture schema fields. Operations type checking passed.
Before/after source manifests matched. Original logs and result are retained at
`test-results/operations-routing-focused-20260928-083635/`.

The six-file repair captures the guarded preference revision, constructs all
three legacy tiers explicitly, fixes the historical policy and async store
fixtures, retains the ledger's written-off receipt state, and supplies required
Responses creation time and completed tool status. Its exact SHA256 manifest is
`test-results/operations-routing-focused-repairs.json`. The narrow rerun is
authorized only after the security red batch releases the shared slot; it has
not run. These are diagnostic results, not feature acceptance.

That authorized rerun completed at 08:48:10 UTC: type check and 58 tests passed,
with unchanged before/after sources. Reading its stderr exposed a real
normalizer defect hidden by the SDK's continuing stream: `response.created`
lacked `created_at`. The tests now collect SDK errors and require none.
Under the separately authorized `slot_mul0c9f9_ad437c3e`, the unchanged source
failed nine of 30 binding cases. One captured response timestamp repaired the
normalizer; the two suites then passed all 58 tests with no stderr, and CP
type checking passed. The slot released at 08:51:23 UTC. Original red/green
logs, exits and source hashes are in `test-results/operations-routing-normalization/`.
The integration and UI acceptance gaps above remain open.

## Conversation receipt and derived-history review

The fifth bounded read-only Muse review completed at 09:36:58 UTC, exit 0.
The route and high-effort variant were confirmed against the live OpenCode Go
inventory before dispatch; no fallback was used. The reviewer inspected the
authored reader/view/tests and repair artifacts against the frozen b4 driver
objects, whose nine handoff blobs also match the composed 8ce dependency.
It ran no checks and made no edits.

No new reachable defect was reported. Parent reconciliation confirmed the
actual selectHistory/compaction shapes, native carried-history distinction,
writing-helper ancestry, project/tenant/command checks, immutable turn cursor,
and model-only receipt boundaries. The report does not turn the intentionally
unapplied repairs into verified implementation.

Missing historical thread/command identities or an unavailable model child
stop the affected page or follow-up. Dropping unverifiable source restrictions
would be unsafe; this compatibility limit is explicit. Historical formats
outside the inspected driver, browser behavior and runtime acceptance remain
unverified. A work-run id cannot currently enter a conversation lineage; the
review's possible future id-prefix tightening is not a current defect.

Raw read-only review evidence: `test-results/operations-routing-receipt-review.log`,
SHA256 `66FB41C2ACAA0DDB1AC5F95296AA97D5EE52373E01065AC8A308659E06E5CE47`.

## Executed harness failure evidence

The first original-source run used `slot_mul2707v_a539be5c`, from 09:42:36
through 09:42:45 UTC: nine failures and thirteen passes of 22, exit 1.
The omitted original Nectovia adapter section was then applied separately.
The complete-original run used `slot_mul2f7uk_981a09c8`, 09:48:59 through
09:49:04 UTC, with the same nine failures and thirteen passes, exit 1.
Both before/after manifests matched all 1,472 frozen source files. Both slots
were released before any edits. No broad checks ran in either window.

The failures reproduce non-gateway receipt trust, malformed/oversized source
error mapping, guarded conversation and writing-helper propagation, direct
intent ancestry, failed-step receipt loss, malformed successful receipts and
tool content displayed as billing evidence. The suite instantiates generic
and synthetic adapters, so the separate Nectovia integration section did not
cause or mask those assertions. The exact test file is unchanged for green.

The seven-file repair is now applied and held for its focused green/type window.
Current source hashes match `test-results/operations-routing-harness-green-freeze.json`
(SHA256 `D9199DF84A5C0BC9523264A50BFCF14450E561911C5DE6E095BF283BC28375B4`).
Original logs and manifests are preserved separately in
`test-results/operations-routing-harness-red-20260928-094236/` and
`test-results/operations-routing-harness-complete-red-20260928-094859/`.

The repaired run used `slot_mul2re7p_d722f2b0`, 09:58:27 through 09:58:56 UTC:
all 22 harness cases passed, followed by root TypeScript exit 2. All 1,472 source
hashes remained unchanged. The compiler identified two test-fixture signatures:
the synthetic egress authorizer must return a promise, and the journey's account
client requires an explicit fetch transport. Both fixtures are now corrected;
no production source changed for these errors. The next focused rerun is pending.
The journey error is the client constructor, not the `turnRunId` call.
Evidence: `test-results/operations-routing-harness-green-20260928-095827/`.

The fixture-only rerun used `slot_mul3bi5u_73fe79bf`, 10:14:05 through 10:14:33
UTC: all 22 harness cases passed and root TypeScript exited 0. All 1,472 source
hashes matched before and after. No other checks ran in this window.
Evidence: `test-results/operations-routing-harness-types-20260928-101405/`.
The source freeze was `operations-routing-harness-types-freeze.json`, SHA256
`2947F7F6A5B1A1888ED02634C268634A36995966F1864601C9A91D68752FAD47`.

After release, three owned test files gained the recorded follow-ups: two old
protocol cases, a cancellation-during-dispatch-write reproducer, two actual
Nectovia adapter source-rule cases, and the direct OpenRouter ZDR guard case.
Those six additional cases are authored and unrun; production remains unchanged
until the cancellation reproducer records its result.

The sixth bounded independent review used role `verifier`,
`opencode-go/muse-spark-1.3-contributor`, OpenCode Go, `ask` mode and the live
catalogue's `high` variant. The live inventory reported active tool access,
1,048,576 context and 131,072 output limits. No fallback, edits or checks were
used. The reviewer found the timing hypothesis reachable and the proposed
funding transition correct, conditional on the four stated ordering controls.
Parent reconciliation clarified runScoped as the immediate-abort link target
and placed the explicit 499 branch before circuit/fallback logic. The fixture
proves only an abort during the dispatch write, before attempt-try entry; later
cancellation relies on signal-respecting transport. No new production repair
was applied from the review. Raw output is
`test-results/operations-routing-cancellation-review.log`.

The first attempt to acquire the granted six-case diagnostic slot was denied
by the tool: `needs-you-rule` already held `slot_mul3kca9_7bf9c4a7`. No test or
production mutation ran and no other owner's slot was released. The diagnostic
remains queued against the unchanged `operations-routing-followup-red-freeze.json`.

The renewed diagnostic used `slot_mul3pe34_bc6f002f`, 10:24:53 through 10:24:59
UTC. Control-plane selected cases: one intended cancellation failure, two
protocol passes, fifteen filtered skips, exit 1. The first failed assertion
observed one provider transport invocation instead of zero; its response and
ledger showed a settled 14 micro-USD charge after cancellation. Subsequent
cancelled-state assertions are not independently proven by that red. Root
selected cases: both real Nectovia source-rule cases and the direct OpenRouter
ZDR guard passed, thirty filtered skips, exit 0. All 1,472 source hashes matched.
Original evidence: `test-results/operations-routing-followup-red-20260928-102453/`.

After slot release, the reviewed runScoped-only repair was applied. It links an
already-aborted request, checks before invoking the provider, parks the committed
hold, then returns 499 with its receipt before any cooldown or backup. Tests are
unchanged. The current integration green is queued under manifest
`test-results/operations-routing-integration-green-freeze.json`, SHA256
`4BA6BD0162AD3BC34E6B83F49987A2ACF493F091B737E53B8FD0571F271F0E43`.
The cancellation review log SHA256 is
`FCD02A2696DD61F67CDDDFC813A9E1C561C4EF74876BEF0A7E5135B41EAA543D`.

The composed integration green used `slot_mul3zois_a07a619e`, 10:32:53 through
10:33:34 UTC. All 77 control-plane tests passed (18 scoped dispatch, 31 bindings,
28 policy), followed by CP TypeScript exit 0. All 55 root tests passed (22
harness, 17 routing client, 16 OpenRouter), followed by root TypeScript exit 0.
There were no skips or SDK stderr. All 1,472 source hashes matched before and
after. The cancellation test reached every assertion: zero sends/backups,
499/cancelled, one committed uncertain attempt, no settlement and no cooldown.
Original evidence: `test-results/operations-routing-integration-green-20260928-103253/`.

After release, the unrun browser test's composer locator was corrected to the
actual accessible label, `Message this thread`. Product code is unchanged by
that fixture correction. The Operations checks, both builds and first browser
journey remain pending under a new two-repository freeze.

The first browser grant was placed on hold by the coordinator before acquisition
after PR #176 moved main to `1af37e0` and introduced another migration 009 plus
overlapping account files. No command from that five-command window ran.
The 1,498-file app/Operations freeze remains unchanged, SHA256
`CF61DB513184D4F35D9BFBB527989756B84DFBEDC094C991CD9D9BA36F2F7E8B`.
Actual migration application state and the exact-main composition must be
reconciled before any current-main acceptance claim. No migration history is
rewritten on the assumption that a merge implies deployment or application.

## New-main original failure record

After Andrew chose adaptation, local checkpoint
`e730317e89ddb49ccac7dcb54d3fa7e66f92896a` preserved the old-base candidate.
The mechanical app merge imports `1af37e0` into that checkpoint; staged tree
`ea7c0821c4926ed98ef65db010150b210f25e10a` includes five new regressions.
Routing migration is 010; Individual 009 is unchanged. The independent security
repair has not been imported or changed.

The coordinator granted one original-failure command. Own slot
`slot_mul5p9nw_c91f8594` ran from 11:20:46.915 through 11:20:50.165 UTC and
was released immediately. `scoped-routing.test.ts -t new-main:` exited 1 with
five intended failures, zero passes and eighteen filtered skips (23 total).

| Regression | First observed failure |
| --- | --- |
| Plan issuance before setup creates one billing identity | No Individual account was created. |
| Active person plan permits scoped Personal BYO | Admission was refused. |
| Funding alone cannot substitute for person access | Gateway returned 200 and settled synthetic 14 micro-USD. |
| Person revocation invalidates an already issued admission | Gateway returned 200 and settled synthetic 14 micro-USD. |
| Individual never covers a one-member Business | Business access reported Agent included. |

Later assertions after those first failures were not reached and are not proven
by this red run. No setup failure or unrelated type/build check is counted as a
regression. All 1,473 frozen source hashes matched before and after. Freeze SHA256:
`6E738A4212CFD3E7C4B3404EA1F97DB99E8EF122E41A0C7ED965AC877CD184B2`.
Original logs, before/after hashes and result are retained under
`test-results/operations-routing-main-red-20260928-112046/`.

## New-main focused green and fixture type repair

Coordinator-authorized slot `slot_mul6lydw_3bed14cd` ran the four focused
commands from 11:46:11.951 to 11:46:51.714 UTC. It was released immediately.
App staged tree `3581acbc502d8cb02fa84f810266a15b0755b3ce` and Operations
tree `17557e6820d5446576d80d5d87419e8581b7b8c7` were frozen under manifest
`64097A7DFC30733FCC3CF28629E0473B99289D53E35F06670C8693B7D153CBB8`.
All 1,499 source hashes remained unchanged.

- Control plane: 49/49 passed, no skips (scoped routing 23, Individual 13,
  migrations 13). All five original regression cases now pass.
- Desktop: 34/34 passed, no skips (routing client 18, Individual 16), including
  scoped Personal host admission through a real non-Luna binding and funding receipt.
- Both typechecks exited 2 at the same two assignments in the authored real
  PostgreSQL fixture: unvalidated `unknown` query values assigned to string snapshots.
  No other type errors were reported.

Original logs, exits and before/after hashes:
`test-results/operations-routing-main-green-20260928-114611/`.
The subsequent fixture-only repair validates both database values as strings before
saving them. It changes no application behavior.

The authorized two-command rerun used slot `slot_mul6p6sj_b7f304eb` from
11:48:42.817 to 11:49:09.195 UTC. Control-plane and root TypeScript both exited 0.
All 1,499 hashes were unchanged under manifest
`124CBA6550999D0619BD5CDA7D0407A797F06CF8A13D58D6EFDCAA0DBB09BD2D`;
app tree `ad94ef32645d51af46b686bd29b2993cc847a9fe`, same Operations tree.
Exactly one source file differs from the 83-test green run: the unrun PostgreSQL
fixture. Logs: `test-results/operations-routing-main-types-20260928-114842/`.
The slot is released. The real database fixture remains unexecuted; these checks
do not establish migration/privilege, browser, packaged or deployed acceptance.

## Personal authority source review

An initial combined review could not read the external Operations checkout and
returned no verdict; process exit 0 was not treated as acceptance. Its original
log remains `test-results/individual-composition-review.log`, SHA256
`DB6C156188836C194C70238DC83209051D92F29CA97DBABFC49229CDCF443FE2`.
The narrower app-only review used live-available
`opencode-go/muse-spark-1.3-contributor`, role verifier, OpenCode ask/plan mode,
high effort, read-only app scope, no fallback. It returned PASS with no
actionable correctness finding on `a9bbe8c2924cd95c88e9c92af9d5e97286be0ebb`.
The parent reconciled its Personal identity/admission/funding references against
the source and original five RED plus 83 GREEN cases. It excludes security-owned
session.ts, Operations, real PostgreSQL execution and live providers.
Log `test-results/individual-app-review.log` SHA256:
`432EA02212A3BE17B8EFDEAA5CBCEAD893A1A39C57B78D76A47A55B6396B71B6`.
Dispatch/reconciliation record: `test-results/individual-app-review-record.json`.

## Response contract repair

The coordinator's independent combined run exposed two source regressions:
FundingError is an AccountError subclass, so its handler must run first to keep
funding refusals HTTP 402; Business attempt lookup must retain `not_a_member`
for membership refusal and `sign_in_required` for unauthenticated access.
Both repairs are confined to `managed-inference.ts`. Fixtures also needed the
current registry contract: a synthetic actually-unregistered route, immutable
old and current Luna bindings, and the new nullable routing/zero-hold receipt
fields. The production registry was unchanged.

The first local run at 12:22 UTC passed 57 and failed one new fixture assertion:
route save returns 200, not the fixture's 201. Both production repairs passed.
The original run remains `operations-routing-response-contract-20260928-122228`
under test-results, freeze
`DC22864E86A678FF915BEBC18CB4220C786921DFCCBEB97656E128365AE08D7D`.
No typecheck ran after that failure. Correcting only the fixture expectation
produced 58/58 with no skips and control-plane TypeScript exit 0, 12:23:46.932
through 12:23:57.013 UTC, slot `slot_mul7yaca_1634bd83`.
All 1,499 source hashes were unchanged; freeze
`F9CDE4180D27B1CCDE5E6B863AA374E55D7791587B2A7209BA5842869696929D`.
Its tree `3d2d94ada66bd28d2057cfb20ff37a51448d70dd` is committed as
`da04d6a91c53fc48beae99002b018dcb84425c62`. Logs and result remain under
`test-results/operations-routing-response-contract-20260928-122346/`.

## Operations checks and complete browser journeys

The first Operations diagnostic at 12:07 UTC passed app build and Operations
TypeScript, then recorded 22 Operations tests passed and 2 failed, no skips.
The two failures are in separately owned `tests/ops-service.test.mjs`: the
formerly unqualified `aws-luna-6` seed is now qualified; the later audit assertion
fails because the earlier case aborted before publication. The same test also
assumes the old Focused route during rollback. The file remained untouched
pending formal ownership transfer. Original evidence:
`test-results/operations-routing-ui-diagnostic-20260928-120724/`, freeze
`11060833487E8DF3EC581E2F121F67686763C7BC2758F6B9DEB73478EC55759F`.

The browser fixture now has two serial journeys. Business publishes a global
policy, accepts Strict, exercises the real Azure binding and reopens its durable
receipt. Personal separately issues a paid person plan and managed-usage
agreement, accepts Strict, publishes an isolated override, performs the same
runtime path, reopens the receipt, resets to inherit and proves both old receipt
immutability and unchanged Business attempts/organization records. All services,
data directories and browser profiles are disposable and owned. Provider
transport is synthetic; no credentials, paid inference or installed user data
are used.

All original diagnostic runs are retained. Directory suffixes below are under
`test-results/operations-routing-personal-ui-20260928-`:

| Run | Directory suffix | Observed result |
| --- | --- | --- |
| v1 | 123543 | Both typechecks and builds passed; browser launch failed because the Playwright headless binary was absent. One failed, one not run; no page assertion reached. |
| v2 | 123856 | Both builds passed; route Status label locator timed out. One failed, one not run. |
| v3 | 124342 | Publication and customer Strict consent passed; nonexistent Close settings locator timed out. One failed, one not run. |
| v4 | 124707 | Settings navigation passed; wrong Home composer label timed out. One failed, one not run. |
| v5 | 125146 | Real managed response, answer, persisted receipt and reloaded answer passed; Home had no AI run details. One failed, one not run. This is the actual product regression. |
| v6 | 125449 | Both full journeys passed, no skips; root TypeScript and both builds passed. |

The installed Chrome `153.0.8010.53` was used from v2 onward, SHA256
`E8BCE39747EA63C9C7D4306F7635D2916C9ECB0CF913FBCF5E7ACC4539B5B8A0`.
No browser was installed. Semantic combobox locators, the real Settings toggle
and `Message Nectovia` composer label corrected fixture assumptions.
The v5 RED freeze was
`21BB75072B4F845EE7ECBF1FDAA67BA864DED1A92D39F1635389F23691CBED2C`.
The only source difference from v5 to v6 is mounting existing
ThreadManagedRoutingDetails in DiomedesHome beside NativeSessionControls; the
journey assertions were unchanged. It adds no new receipt authority or run state.

Final local v6 slot `slot_mul9277q_0bea3971` ran 12:54:49.121-12:55:32.373 UTC.
All 1,499 hashes stayed unchanged under freeze
`F871EF300AB0C61B87F679660C33980AB25F2ABB9261752989E1E69A19569B94`.
The exact tested app tree `e810433d10d0f26480b9cc23d92ebd0ea31f0f46` is now
commit `dae3a4b60feef2baec1ce15defcb3542c3c5a41c`; Operations remained
`e8366b42df6667d29554a09acd243528c73bedc9`. Screenshots show Strict consent,
published policies and settled non-Luna details after reload. The Personal
receipt retains policy 1/global 2/account 1/privacy 1 after routing reset.
The Business receipt names policy 2/global 2/account 0/privacy 1.
Evidence, six screenshots and hashes are linked in `source-candidate.json`.

The coordinator independently inspected the Home three-file diff and screenshot
evidence with no blocker, imported exact blobs, and reported both journeys and
builds passing on combined `6e9ebba`. That is a separate checkout including the
security-owned repair. This lane does not convert that report into a local run
or a final combined acceptance claim.

## Independent Operations source review

The user-requested review used role verifier, exact model
`opencode-go/muse-spark-1.3-contributor`, OpenCode Go subscription route through
ask-opencode.ps1, ask/plan mode, high variant. Live inventory reported active
tool access, context 1,048,576 and output 131,072. No fallback occurred.
Inventory log SHA256:
`6F473FCCB066C70DEB736D71F903C6606083546BD8F1DF602D41300CC413E93B`.

Its boundary was the Operations checkout only, read-only source and Git;
no tests, builds, browser, outside-workspace access, credentials, provider calls,
edits, commits, messages or further workers. Slot `slot_mul9ex0o_cda2aaa8`
was acquired 13:04:42.409 UTC and released 13:08:52.298 UTC. The review process
ran 13:05:06.762-13:08:52.298 UTC and exited 0.

Verdict: PASS, no actionable frontend/bridge defect demonstrated, on clean
Operations `e8366b42df6667d29554a09acd243528c73bedc9` against main `d0d04da`.
It traced roles, Personal-only plan versus usage funding, typed scope/CAS,
read-only consent, approved connection metadata and the staff bridge allowlist.
Parent reconciliation reread these source paths, confirmed the unchanged clean
Operations checkpoint and matched the source claims to the recorded real-bridge
and browser runs. This required no source repair.
The backend is outside this verdict; PostgreSQL, live, packaged and deployed
acceptance are excluded. The known stale Operations fixture remains a separate
gate. Log `test-results/operations-ui-review.log` SHA256:
`3610832DE98C836A7E47F3077EA5C53E637E7125E697BC71365600A0C4D07B6C`.

## Operations fixture handoff and final green

The original test owner explicitly approved a single-path handoff. Integrator
recovery released old stopped-process claim `claim_mukn7vir_77bd4f5c` at
13:14:34.110 UTC and retained its other six paths under
`claim_mul9rmsq_8280d7ee`. Routing then acquired only
`tests/ops-service.test.mjs` under `claim_mul9t7g2_2706829f` at 13:15:49.107.
The current composed fixture was preserved; no older holder blob was imported.

The repair registers a dedicated synthetic, supported AWS route as unqualified,
asserts publication fails with 422, then qualifies it. Publication changes only
Focused while retaining the starting other tiers. Stale publication still
requires 409; rollback compares every tier to the captured initial policy.
Role and audit assertions are retained. The coordinator independently read the
exact one-file diff and whitespace result and found no blocker before the run.
No Operations or app production source changed.

The authorized full Operations suite ran in `slot_mula0u3p_ea50b71d`,
13:21:45.088-13:21:53.684 UTC: all 24 tests passed in four files, zero skips,
exit 0. All 1,499 frozen hashes were unchanged. The sole delta from the prior
browser freeze was this fixture, pinned by
`test-results/operations-routing-ops-fixture-freeze.json`, SHA256
`433D0FF9F33D017CD12FD8AEE6999E83BF00E0EA2A1B3D057B7A5103240209E9`.
The actual staff bridge, WorkOS stand-in, scoped provider-binding fixture and
staff-key suites all ran. No build/type rerun was needed for this test-only edit;
the previous e8366b4 production source checks remain separately recorded.

The exact tested tree `e44e9737138a02b53ded7ab5ea5bf466df0a4560` is now clean
Operations commit `fdd73a74b87bcbcf0ddec123cf78117efcf8fa8a`, parent `e8366b4`.
Only `tests/ops-service.test.mjs` changed, blob
`39fc9b5c10fd45fc3b89e9c6963149f4f3fd8ba5`, 24 additions/15 deletions,
raw SHA256 `E90EBCD98A3349A874F8A805204C67B8D465BF5777878DFB5FCA102211E61021`.
Its claim was released at 13:23:09.333 UTC for coordinator import.
Evidence: `test-results/operations-routing-ops-green-20260928-132145/`.
Test log SHA256 `49161DF1304BB4F711AC62BD8E5FA6D128294352D1EE6C33D93B9E770A5786B2`;
result SHA256 `49879DD6C1BD7C55A92A8A483E013D85E1DD1507821C9B0ADACC11A93B13596E`.
The original 22-pass/2-fail run remains unchanged.
