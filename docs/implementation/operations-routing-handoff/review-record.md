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
