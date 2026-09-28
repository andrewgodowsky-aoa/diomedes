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
