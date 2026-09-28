# Operations-controlled routing

Status: implementation in progress. No production, funded-provider, package or
deployment acceptance is claimed.

## Work order

- Feature: operations-routing
- Request: Operations-controlled model routing and failover, 2026-09-28
- Owner: Codex chat 01a0e643-9236-7b53-a39f-bd1e3ba87858
- App: `F:/Diomedes/diomedes-wt/operations-routing`,
  `feature/operations-routing`, base `0f2038402f58772400916ab00059d8121d2e3b35`
- Operations: `F:/Diomedes/diomedes-ops-wt/operations-routing`,
  `feature/operations-routing`, base `06195b18da87365d9ebbef8045b01be508f86bf2`
- Composed repository Pillars, Roadmap and Project Memory: 2026-09-27.2.
  Andrew's newer Personal-only Individual direction takes precedence over
  older solo-business wording: an Individual policy never funds a Business
  workspace, including a business with one member.
- Local work authorized. Publication, paid probes and credential-policy changes
  retain their separate authorization requirements.

## Source-to-change map

| Requirement | Existing authority and intended change |
| --- | --- |
| Published defaults and account overrides | Extend CommercialService and its PostgreSQL/faux transactions; preserve compare-and-set, audit and append-only policy revisions. |
| Customer privacy | Reuse NC-SETUP-2026-09-27.1 definitions in a shared account preference contract. Main has no implementation of those profiles. Operations reads this authority; it cannot change consent. |
| Individual identity and funding | Main's Personal workspace has no hosted tenant and commercial grants require organizations. Resolve the minimum real Individual contract before admission; do not fabricate a Business organization. |
| Catalog and four providers | Replace the managed registry's code-only generation table with validated model bindings to approved server connections. Existing AWS Responses transport, endpoint guards and normalization are the starting points. |
| Privacy and price eligibility | Intersect mandatory, customer and source requirements before ranking. Bind evidence to the actual connection/model/protocol/features and versioned price. |
| Failover and accounting | Extend ManagedInferenceService's existing FundingService lifecycle. Every attempt keeps the root job and its own reservation; uncertain cost remains held. |
| Desktop | Extend the authenticated policy snapshot and remove nectoviaRateCard's Luna-only restriction. Preserve ModelAdapter/NativeAgent/RunService/Trust ownership. |
| Operations | Extend Routing, Customers and api.ts through the existing staff-only allowlisted bridge. Preserve device keys, roles and main-process credentials. |
| Verification | Exercise real HTTP bindings with synthetic streams, disposable persistence, role/scope attacks, safe continuation, pricing, budget and UI journeys. |

## Dependencies and ownership

Andrew authorized coordinating file handoffs while preserving existing work.
Routing's source paths are claimed under the pinned coordination tool. The
app/service delta was claimed at provisional PR #169 commit
`b4a1e92f74fe0938d8c7a43ba36b8f1cd1636957`. On 2026-09-28 at 09:27 UTC,
local merge `2b231c80cfd2dd9c6a7534e2ecf9e772f6db9c19` composed the complete
frozen dependency `8ce831400fb4329ea06aec5cf85609638eb938e8`, itself based on
merged policy main `2e6c7850eb28491ea662fe2f36b68d5ac41ddbea`. That engine
dependency remains provisional while its owner verifies the combined source.
This feature worktree is the composition venue. All heavy checks use
the pinned exclusive slot; no other owner's current run is acceptance here.

Four harness paths have handoff `handoff_mukyfrs1_47802fe4`, and the failed-step
receipt writer in `run-service.ts` has `handoff_mukykscp_6f84c258`. They are
frozen at that same dependency and were claimed after composition.
Session ancestry has `handoff_mukzkaq0_a55758ab`. ThreadView is frozen at the
same provisional dependency under `handoff_mul05now_ee237af1`. AccountSettings
is frozen at provisional PR #174 commit
`634266f5f6b95182b051fd11f7e4a1e441d2dc0f` under
`handoff_mul05m83_3a236699`; its existing funding disclosure remains separate
from customer routing/privacy consent. No dirty peer source was imported.

All nine engine handoff blobs matched their frozen b4 source exactly; the
AccountSettings blob matched the merged policy candidate. The five merge
conflicts were in routing-owned files: Nectovia transport, its adapter,
commercial routing, the managed registry and shared model definitions. The
resolution retained dynamic routing and the older published Luna binding,
while preserving the dependency's reasoning-summary negotiation and registry
validation. Those resolutions require this feature's own checks.

Main moved after those gates: the shared `origin/main` now records
`1af37e085ef24fc6c92d6b2b8510fc52a504bd1b`, the PR #176 merge of
`a194ad8663c6d744c83d92ac09e0d91cafe0a653` onto `2e6c785`. That change is
imported in the local composition after Andrew chose adaptation. It overlaps six routing-owned account paths and adds
`009_individual_plans.sql`. The coordinator reports that Individual 009 has
already been applied to staging. The earlier proposal to renumber that file is
withdrawn: applied history remains immutable. The local forward path
appends routing as 010.
Operations main also moved to `d0d04da058e7e9fdaeb89f6b28da2ad933f678de`
(PR #6), overlapping this feature's Customers, API and staff bridge files.
That source is also imported locally. Nine app conflicts are resolved; Operations
merged without conflicts. The merge commits and post-repair gates remain pending.
The current test results remain valid only for their recorded candidate, not
for the new main or a future composed tree. No deployment or migration claim
is inferred from the merge.

The original desktop, harness and conversation-view patches are now applied.
Both original-source harness runs recorded nine failures and thirteen passes.
The seven-file repair then passed all 22 cases on unchanged source. Root type
checking found two test-fixture signatures; after correction the 10:14 UTC
rerun passed all 22 cases and root TypeScript. Original logs, exits and
1,472-file manifests are retained in the harness folders documented in the
review record.

## Provider readiness

| Provider | Existing managed generation on base | New binding | Fixture tested | Live tested | Packaged | Deployed |
| --- | --- | --- | --- | --- | --- | --- |
| AWS Bedrock | Luna Responses only | Implemented: approved Responses/Chat, Converse, Messages | All four protocols, tools/usage; protocol-specific Mantle authentication | No | No | No |
| Azure | None | Implemented: v1 Responses/Chat with deployment identity | Both protocols, tools/usage | No | No | No |
| Vertex | None | Implemented: GenerateContent and Anthropic Messages | Both protocols, tools/usage/native state | No | No | No |
| OpenRouter | Jev evaluations only | Implemented: Chat with exact downstream and attribution | Tools/usage, downstream refusal | No | No | No |

Provider qualification, account access/quota, health, privacy and price are
separate records. Provider documentation describes requirements; it does not
prove this company's account meets them.

## Current implementation and acceptance gaps (2026-09-28)

The source is a local candidate, not an accepted feature. The current composed
integration run at 10:32:53-10:33:34 UTC passed all 77 control-plane cases,
all 55 desktop/harness cases, and both TypeScript checks. No skips, SDK stderr
or source drift occurred. Evidence is retained in
`test-results/operations-routing-integration-green-20260928-103253/`.
Operations type checking passed on its unchanged checkpoint at 08:36:43 UTC;
its full bridge tests, the browser journey, broader compatibility and real
database checks remain pending.

The original diagnostic preserved five type errors and three fixture failures.
The next run passed but exposed SDK errors that its assertions missed. Stronger
assertions reproduced nine failures; adding the required creation timestamp to
normalized response events made all 58 tests pass cleanly. Red/green logs and
source hashes are in `test-results/operations-routing-normalization/`.

A later regression reproduced cancellation during the real dispatch write:
the original gateway still invoked transport and settled synthetic usage.
The reviewed repair observes already-aborted requests before the provider call,
retains the committed hold, and returns cancellation before adding a provider
cooldown or using a backup. Its full assertions pass in the composed run.
The earlier red and the independent review remain in the review record.

- `shared/routing-policy.ts`: scoped revisions, hard restrictions, customer
  consent, server connections, model bindings, qualification, prices,
  eligibility, conservative reference ceilings and authenticated receipts.
- `services/control-plane/src/routing.ts`: one persisted policy authority,
  explicit inherited/reset overrides, publication/rollback/preview/audit,
  owner/admin consent and authenticated snapshots. Preview and dispatch use
  current connection credentials and model-specific cooldown state.
- `services/control-plane/src/managed-inference.ts`: bounded candidate set,
  rechecks after reservation, one original job cap, separate immutable attempt
  prices, retained uncertain costs and no retries after output or refusal.
- `managed-bindings.ts` and `managed-normalization.ts`: real allowlisted Worker
  transports and normalized tool/usage streams. Native checkpoints are sealed
  to the account and binding; incompatible continuations are refused.
- `server/engines/nectovia.ts`: authenticated dynamic rates/caps, actual attempt
  receipts and conservative handling of unresolved costs.
- Operations `Routing.tsx`, `Customers.tsx`, `api.ts`, `electron/service.mjs`:
  ordered backups, evidence/configuration, scope details, preview/history and
  staff-only bridge calls. Renderer credentials remain absent.
- Customer `RoutingPreferences.tsx` and `ManagedRoutingReceipt.tsx`: consent and
  existing run details. Both customer mounts are applied. Durable propagation,
  failure receipts and the conversation reader pass the 22-case composed
  harness suite; the browser journey remains unrun.

After a host restart, claims were recovered under PID 67556. Andrew reconfirmed
routing ownership of six paths overlapping the separately active Individual tier feature:
`server/accounts/agent-gate.ts`, `server/accounts/client.ts`, and control-plane
`commercial.ts`, `commercial-postgres.ts`, `faux/store.ts`, `worker.ts`.
Both candidates are preserved; Individual edits to those paths are paused for later
composition. This candidate's Individual billing identity
is `billing_scopes`, not a fabricated Business organization; the paid plan must
compose with this same authority.

The historical checkpoint contains `009-scoped-routing.sql`. The local composition
preserves main's already-applied Individual 009 and renames routing to 010.
`persons.id` names the access holder, while
`billing_scopes(id, tenant_id, person_id)` names the funded commercial account.
Main's person grants/access/admissions already use `tenant_id = person_id`.
Source review supports using that same tenant key on the new Individual billing
scope while keeping its distinct `individual_*` account ID. Historical person
records must remain unchanged, and current person access and funded usage must
both authorize a managed dispatch. This reconciliation is locally implemented;
its five original regressions failed before repair and passed afterward. The
focused composition passed 49 control-plane and 34 desktop tests; both typechecks
passed after a fixture-only string-validation repair. Exact evidence is recorded
in `operations-routing-handoff/review-record.md`.
`commercial.ts` exports `ensureIndividualAccount(tx, verifiedPerson, at)` for
both customer initialization and the staff person-plan provisioning path. It uses
the same per-person transaction lock and creates no entitlement, credits or
Business organization. Provisioning must call it before grants even when the
routing screen has never opened. Grant-first and setup-first order must converge
in composition tests. The helper is below routing in the import graph, avoiding
a runtime import cycle with commercial grant code.

`operations-routing-handoff/desktop.patch`, `harness.patch` and the customer
mount patch were applied after dependency composition and the recorded claims.
Source-inheritance and failed-step receipt regressions reproduced failures
before `harness-repairs.patch` was applied and passed afterward. The source
review and harness results do not close the browser, database or provider gates.

The gateway and desktop now carry failure receipts as well as successful
fallback receipts. Validated all-released failures release the local hold;
unresolved attempts retain it. The durable failed-step writer's restart
regression and real desktop-to-gateway client suite pass on the composed source.
The browser receipt view still needs its journey check.

## Migration and behavioral rollback

`010-scoped-routing.sql` backfills existing organization identities and Individual
identities for existing 009 grant holders, adds append-only preferences, scopes policy
revision keys, and retains job source constraints and model cooldowns. Existing
policy JSON, customer consent, grants and balances are not synthesized or
rewritten. Ledger account/tenant relationships remain compound foreign keys.

The migration runner retains unchanged Individual 009 and appends routing 010. Schema migration does not assume runtime
roles exist or change their privileges. Apply the separately reviewed
`runtime-permissions.sql` after the migration: scoped authority locks need
column-level UPDATE on `billing_scopes.kind`; consent remains append-only;
source rules and cooldowns receive only their mutable column grants. The
funding writer continues using the existing ledger tables and receives no
scope or customer consent permissions. No migration or grant has been run.

Andrew chose adaptation to the merged Individual code. The local repair reuses
`ensureIndividualAccount` inside authorized staff issuance before setup, locks the
person before their billing scope, and requires the person grant plus explicit funded
agreement for managed admission and dispatch. It retains Personal BYO and refuses
every Business through Individual. New Personal admissions name the billing scope
while retaining their person tenant; historical 009 records are not rewritten.
See `operations-routing-handoff/main-composition-notes.md` for the source boundary,
original failure evidence and pending acceptance gates.

The real PostgreSQL routing suite requires a new database named
`b01_validation_operations_routing_*`, an explicitly supplied test URL and,
for Neon, a pinned nonproduction branch and exact endpoint. It refuses an
existing schema and performs no schema reset. It is authored to exercise upgrade
from 009, preservation of person grant/admission record text and revisions,
idempotence, identity backfills, restricted role locks, concurrent Individual
creation, scoped Personal admission, consent CAS, durable reads and denied mutations.
It has not run against a real database.

At 09:31 UTC no PostgreSQL server/client or Docker executable was available on
PATH, no PostgreSQL service was present, and no routing test database URL,
approved isolated branch or expected endpoint was configured. No database was
created and no production connection was used as a substitute.

A later read-only Neon inventory found one project, `small-wave-81999606`
(`diomedes`), with only `br-old-star-aepf7zk6`, named `production`, marked
primary and default. There is no existing isolated branch to bind this test to.
No branch, database, role or credential was created or changed. The remaining
database dependency is an explicitly approved isolated branch and a new empty
`b01_validation_operations_routing_*` database with a direct owner connection;
the test also needs the exact branch id and expected hostname. Credentials belong
in the test process environment, never in this report or a committed file.

Roll back routing behavior by publishing a qualified single primary with
fallback disabled, or by creating a new rollback revision from still-eligible
versioned history. Recheck credentials, restrictions and route evidence at
rollback time. Old unqualified legacy bytes are not reactivated as a shortcut.
Do not down-migrate after Individual, consent or receipt writes: retain the
additive schema and history. Database restore would need its own reviewed
plan and authority. Publication, live probes and deployment remain separate
from this local implementation.

## Protocol references used in the bindings

- [AWS adaptive thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html):
  separate qualified adaptive versus token-budget settings, including Converse
  additional fields. Model identities do not select these settings in code.
- [Nova reasoning](https://docs.aws.amazon.com/nova/latest/nova2-userguide/extended-thinking.html)
  and [migration limits](https://aws.amazon.com/blogs/machine-learning/migrate-from-amazon-nova-1-to-amazon-nova-2-on-amazon-bedrock/):
  managed requests retain a hard output bound, excluding an unbounded high
  reasoning setting. Explicit depth mappings can use qualified bounded modes.
- [Vertex thinking](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking):
  qualified budget and level controls are separate options.

These documents establish serialization requirements, not live account access,
model quality, endpoint privacy, quota or a production price promise.
