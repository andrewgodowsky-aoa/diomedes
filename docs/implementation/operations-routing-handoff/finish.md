# Operations-controlled routing: local handoff

Local implementation is complete across the control plane, desktop runtime and
Operations. The two Business/Personal browser journeys pass on the exact source
below. Final combined acceptance is still open; this feature is not marked DONE,
merged, packaged, deployed or live-provider qualified.

## Exact source

| Repository | Branch and checkpoint | Tree |
| --- | --- | --- |
| App | `feature/operations-routing`, `dae3a4b60feef2baec1ce15defcb3542c3c5a41c` | `e810433d10d0f26480b9cc23d92ebd0ea31f0f46` |
| Operations | `feature/operations-routing`, `fdd73a74b87bcbcf0ddec123cf78117efcf8fa8a` | `e44e9737138a02b53ded7ab5ea5bf466df0a4560` |

Worktrees are `F:/Diomedes/diomedes-wt/operations-routing` and
`F:/Diomedes/diomedes-ops-wt/operations-routing`. Unrelated primary checkouts
and active worktrees were preserved. Local source checkpoints were committed;
this lane has not pushed, merged main, changed production or deployed.

App main `1af37e085ef24fc6c92d6b2b8510fc52a504bd1b` and Operations main
`d0d04da058e7e9fdaeb89f6b28da2ad933f678de` were composed after the owner's
ADAPT TO NEW MAIN decision. App merge `a9bbe8c` preserves the already-imported
engine dependency `8ce83140`; it must not be replayed. `b4fdcf0` clarifies two
Personal-only comments. `da04d6a` repairs funding/membership response contracts.
`dae3a4b` supplies the two browser journeys and the missing Home receipt mount.
Operations merge `e8366b4` composes routing checkpoint `f97e0b5` with main's
Individual administration. `fdd73a7` changes only the formally transferred
Operations fixture and passes all 24 Operations tests; production bytes remain
the reviewed and browser-tested `e8366b4` source.

[source-candidate.json](source-candidate.json) gives exact paths, Git blobs and
canonical SHA256 for the complete composed delta: 236 app files and 8 Operations
files against the imported main commits. This includes inherited engine work;
the count is not a claim that this routing lane authored every file. The manifest
pins source commits, while the later handoff commit changes documentation only.
The old `candidate-manifest.json` and patch files remain historical artifacts.

## Implemented behavior

- One persisted global/organization/Individual policy authority with ordered
  backups, bounded attempts, independent revisions, preview, CAS, audit,
  inherit/reset and revalidated rollback.
- Paid Individual access applies to Personal only. Billing identity uses the
  person tenant without creating a Business. A person plan and explicit usage
  agreement are separate requirements; neither consent nor funding grants access.
- Accepted NC-SETUP customer restrictions and source restrictions intersect
  mandatory routing controls before every primary/backup dispatch. Staff cannot
  weaken consent through route configuration.
- Approved server connections and configurable model/protocol bindings feed
  real AWS, Azure, Vertex and OpenRouter transports. Unknown privacy, access,
  qualification or health excludes a route before content leaves.
- Every attempt retains one parent job cap, immutable policy/price attribution
  and its own reservation. Uncertain usage stays held. Refusals, visible partial
  output, uncertain tool effects and incompatible native state do not silently
  replay through another route.
- Authenticated dynamic prices and limits remove the Luna-only client assumption.
  Old protocols are explicitly refused before dispatch on versioned routes.
  Existing Home, conversation and task details display durable routing receipts.

The file-by-file requirement map is [coverage.md](coverage.md). The chronological
failure, repair and review evidence is [review-record.md](review-record.md).

## Observed local checks

These are separate runs against their own immutable manifests, not an aggregate
test count or a claim that every suite ran on the final commit.

| Run | Observed result | Bound source/evidence |
| --- | --- | --- |
| Old-base composed routing | 77 control-plane + 55 root tests passed; both typechecks passed; no skips | 10:32 UTC, `operations-routing-integration-green-20260928-103253` |
| New-main authority repair | Five intended RED failures, then 49 control-plane + 34 root passed; no skips | 11:20/11:46 UTC, `operations-routing-main-{red,green}-*` |
| Fixture-only type repair | Both typechecks passed after explicit database-result string validation | 11:48 UTC, `operations-routing-main-types-20260928-114842` |
| Response contract repair | 58/58 passed, control-plane TypeScript passed | `da04d6a` tree, `operations-routing-response-contract-20260928-122346` |
| Operations diagnostic | Typecheck passed; 22 tests passed, 2 failed in separately owned stale seed fixture | `e8366b4`, `operations-routing-ui-diagnostic-20260928-120724` |
| Complete local browser journey | 2/2 passed; root TypeScript and both builds passed; no source drift | `dae3a4b` tree + `e8366b4`, `operations-routing-personal-ui-20260928-125449` |
| Operations fixture repair | 24/24 passed in four files; no skips or source drift | `fdd73a7` tree + `dae3a4b` code, `operations-routing-ops-green-20260928-132145` |

All evidence directories above are beneath the app worktree's `test-results/`.
The final browser freeze SHA256 is
`F871EF300AB0C61B87F679660C33980AB25F2ABB9261752989E1E69A19569B94`.
All 1,499 source hashes matched before and after. Installed Chrome
153.0.8010.53 ran in disposable profiles; no browser or dependencies were added.

The browser traverses the actual Operations bridge, persisted faux policy,
authenticated customer scope, gateway, real Azure binding and normalized
desktop runtime. Its provider HTTP responses are synthetic. The Personal test
issues separate access and funding, changes only Individual routing, reloads
its receipt, resets to inherit, and verifies unchanged Business records.

The coordinator separately reported full control-plane 723 passed/39 skipped,
and both builds plus 2/2 journeys on its combined security/routing source
`6e9ebba`. Its first full root attempt found observation/scope review failures
and was stopped before completion. Focused reproduction and final review remain
with that integration lane; there is no full-root green claim. Consult its exact
checkpoint/evidence before acceptance.

## Independent review and UI evidence

Bounded app authority review at `a9bbe8c` and Operations frontend/bridge review
at `e8366b4` both returned PASS with no actionable finding. They used live
`opencode-go/muse-spark-1.3-contributor`, OpenCode ask/plan mode, high effort,
read-only scope, no fallback. The parent reconciled source references and
evidence. Earlier normalization, harness and cancellation reviews and original
failures remain preserved. No review is a substitute for real database or
provider acceptance. The coordinator also reviewed the Home receipt repair and
the browser screenshots before importing its exact three-file blobs.

The six final screenshots and byte hashes are in `source-candidate.json` under
`screenshots`. Their common directory is
`test-results/operations-routing-personal-ui-20260928-125449/browser-artifacts/`:

- Business: `operations-routing-journey-d0428-rves-a-non-Luna-run-receipt/`
  contains `operations-policy.png`, `customer-consent.png` and
  `customer-response.png`.
- Personal: `operations-routing-journey-1aa26-utside-the-Business-account/`
  contains `operations-individual-policy.png`, `personal-consent.png` and
  `personal-response.png`.

Both settled response screenshots were inspected. They show actual Azure model,
route, price version and policy/global/account/privacy revisions after reload.
The Personal consent and override screens show explicit Individual identity and
separate usage funding. An earlier run reproduced the missing Home detail view;
the only product repair between that RED and final GREEN mounts the existing
receipt component. All earlier timeout/launch diagnostics remain in place.

## Migration and rollback

Keep applied `009_individual_plans.sql` byte-for-byte: Git blob
`a6da526ec52317a13f0a8b529b66508e9f39680b`, SHA256
`540F7BB22CC183175984FCDCF8E82718A7B093EC77D09329656DDD68196E5886`.
Routing appends `010-scoped-routing.sql`. It backfills organization scopes and
identities for existing person-grant holders, preserves grant/admission bytes,
adds the compound Personal billing reference, scoped revision keys, append-only
customer consent, monotone job restrictions and model-specific cooldown storage.
It invents no grants, balances, prices or privacy qualification. Existing policy
bytes and disabled fallback remain unchanged until explicit publication.

Apply migrations as owner, then the separately reviewed runtime permissions;
schema application does not provision runtime roles. The funding login retains
ledger-only writes and gets no consent authority. Source tests and typechecks
pass, but this lane has not executed these SQL changes on PostgreSQL.

The real fixture needs a new empty `b01_validation_operations_routing_*` database
with a direct owner connection in `CP_ROUTING_TEST_DATABASE_URL`. A Neon target
also needs `CP_APPROVED_ISOLATED_BRANCH=yes`, `CP_TEST_BRANCH_ID` and
`CP_TEST_EXPECTED_HOST` for the exact nonproduction branch/endpoint. It refuses
existing schemas and production targets; it does not reset a schema. The latest
read-only local check found no PostgreSQL/Docker executable or test environment.
Read-only Neon inventory found only the production primary/default branch.
No resource, credential or role was created as a substitute.

Roll back behavior with a new eligible history revision or qualified single
primary with fallback disabled. Recheck current credentials, evidence and
restrictions. Keep the additive schema and immutable history after writes;
do not down-migrate away Individual identity, consent or receipts.

## Provider readiness and remaining gates

| Provider | Implemented | Transport-fixture tested | Funded live tested | Packaged | Deployed |
| --- | --- | --- | --- | --- | --- |
| AWS Bedrock | Approved Responses, Chat, Converse and Messages bindings | Yes: all four protocols, tools/usage, protocol-specific authentication | No | No | No |
| Azure | v1 Responses/Chat with deployment identity | Yes: both protocols, tools/usage; complete browser journey | No | No | No |
| Google Vertex | GenerateContent and Anthropic Messages | Yes: both protocols, tools/usage/native state | No | No | No |
| OpenRouter | Chat with exact downstream policy and attribution | Yes: tools/usage, ZDR guards and unauthorized-downstream refusal | No | No | No |

Live qualification needs the actual approved connection's credentials, account
access/quota, current prices, endpoint/model privacy evidence and authorized
funded probes. AWS effective retention/allowed modes, Azure geography and abuse
monitoring, Vertex feature-specific retention and OpenRouter downstream/region
entitlement must be proven for the real account; source or provider nationality
does not establish them. Credentials belong in the configured server secret
store or isolated test environment, never in this handoff.

Remaining acceptance work: final combined source gates/review; isolated real PostgreSQL migration,
roles and restart/concurrency run; then separately authorized live, packaged
and deployed checks. No Individual contract remains invented or unresolved in
the source: its real person-plan authority is now composed and fixture-tested.

## Coordinator continuation

The forward composition after this owner handoff is recorded in
[combined-acceptance.md](combined-acceptance.md). The combined app source
`a23b27e` passed the complete local app, control-plane and browser gates.
Independent review of the final combined repair, real PostgreSQL, funded
providers, packaging and deployment remain open, so this feature is not DONE.
