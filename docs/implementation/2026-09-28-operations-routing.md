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
- Pillars, Roadmap and Project Memory: 2026-09-27.1.
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
app/service delta is claimed at provisional PR #169 commit
`b4a1e92f74fe0938d8c7a43ba36b8f1cd1636957`; its full committed dependency must
be composed after its owner's next exact head and verification status are
known. This feature worktree is the composition venue. All heavy checks use
the pinned exclusive slot; no other owner's current run is acceptance here.

Four harness paths have handoff `handoff_mukyfrs1_47802fe4`, and the failed-step
receipt writer in `run-service.ts` has `handoff_mukykscp_6f84c258`. They are
frozen at that same dependency but must be claimed only after composition.
Session ancestry has `handoff_mukzkaq0_a55758ab`. ThreadView is frozen at the
same provisional dependency under `handoff_mul05now_ee237af1`. AccountSettings
is frozen at provisional PR #174 commit
`634266f5f6b95182b051fd11f7e4a1e441d2dc0f` under
`handoff_mul05m83_3a236699`; its existing funding disclosure remains separate
from customer routing/privacy consent. No dirty peer source is imported.

## Provider readiness

| Provider | Existing managed generation on base | New binding | Fixture tested | Live tested | Packaged | Deployed |
| --- | --- | --- | --- | --- | --- | --- |
| AWS Bedrock | Luna Responses only | Implemented: approved Responses/Chat, Converse, Messages | Responses, Converse, Messages tools/usage; Mantle authentication | No | No | No |
| Azure | None | Implemented: v1 Responses/Chat with deployment identity | Both protocols, tools/usage | No | No | No |
| Vertex | None | Implemented: GenerateContent and Anthropic Messages | Both protocols, tools/usage/native state | No | No | No |
| OpenRouter | Jev evaluations only | Implemented: Chat with exact downstream and attribution | Tools/usage, downstream refusal | No | No | No |

Provider qualification, account access/quota, health, privacy and price are
separate records. Provider documentation describes requirements; it does not
prove this company's account meets them.

## Current implementation and acceptance gaps (2026-09-28)

The source is a local candidate, not an accepted feature. At 08:51:23 UTC,
control-plane type checking and the two policy/provider suites passed: 58 tests,
no SDK errors. Operations type checking passed on its unchanged candidate at
08:36:43 UTC. Other integration, browser and database checks remain unrun.

The original diagnostic preserved five type errors and three fixture failures.
The next run passed but exposed SDK errors that its assertions missed. Stronger
assertions reproduced nine failures; adding the required creation timestamp to
normalized response events made all 58 tests pass cleanly. Red/green logs and
source hashes are in `test-results/operations-routing-normalization/`.

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
  existing run details. Mounting and durable harness propagation still depend
  on the unapplied integration patches below.

After a host restart, claims were recovered under PID 67556. Andrew reconfirmed
routing ownership of six paths overlapping the separately active Individual tier feature:
`server/accounts/agent-gate.ts`, `server/accounts/client.ts`, and control-plane
`commercial.ts`, `commercial-postgres.ts`, `faux/store.ts`, `worker.ts`.
Both candidates are preserved; Individual edits to those paths are paused for later
composition. This candidate's Individual billing identity
is `billing_scopes`, not a fabricated Business organization; the paid plan must
compose with this same authority.

Routing's `009-scoped-routing.sql` remains the account foundation. The separate
Individual grant migration also numbered 009 must become 010 during composition;
it is not part of this candidate. `persons.id` names a person, while
`billing_scopes(id, tenant_id, person_id)` names the one commercial account.
Grant, access-revision, admission and funding writes must use that account's id
and distinct tenant id, with SQL enforcing the relationship.
`commercial.ts` exports `ensureIndividualAccount(tx, verifiedPerson, at)` for
both customer initialization and the later paid-plan provisioning path. It uses
the same per-person transaction lock and creates no entitlement, credits or
Business organization. Provisioning must call it before grants even when the
routing screen has never opened. Grant-first and setup-first order must converge
in composition tests. The helper is below routing in the import graph, avoiding
a runtime import cycle with commercial grant code.

`operations-routing-handoff/desktop.patch` and `harness.patch` are still
unapplied pending dependency composition. The customer Account view mount is
also pending its owner's handoff. Source-inheritance and failed-step receipt
regressions are prepared for red-first validation once those writers are owned.
These are required integration work; fixture results alone cannot close them.

The gateway and desktop now carry failure receipts as well as successful
fallback receipts. Validated all-released failures release the local hold;
unresolved attempts retain it. The durable failed-step writer still needs its
handoff applied and its restart regression run. All these new cases are unrun.

## Migration and behavioral rollback

`009-scoped-routing.sql` backfills only existing organization scope identities,
adds real Individual identities and append-only preferences, scopes policy
revision keys, and retains job source constraints and model cooldowns. Existing
policy JSON, customer consent, grants and balances are not synthesized or
rewritten. Ledger account/tenant relationships remain compound foreign keys.

The migration runner includes 009. Schema migration does not assume runtime
roles exist or change their privileges. Apply the separately reviewed
`runtime-permissions.sql` after the migration: scoped authority locks need
column-level UPDATE on `billing_scopes.kind`; consent remains append-only;
source rules and cooldowns receive only their mutable column grants. The
funding writer continues using the existing ledger tables and receives no
scope or customer consent permissions. No migration or grant has been run.

The separate Individual candidate must renumber its later migration to 010,
use `ensureIndividualAccount` inside staff issuance before any routing-screen
visit, and use that stored tenant for grants, access, admission, pins and
revocation. Person id, Individual account id and tenant id are distinct. Its
refusal of managed-inference grants until personal funding exists remains.
That separate candidate is not imported or repaired by this checkpoint.

The real PostgreSQL routing suite requires a new database named
`b01_validation_operations_routing_*`, an explicitly supplied test URL and,
for Neon, a pinned nonproduction branch and exact endpoint. It refuses an
existing schema and performs no schema reset. It exercises pre-009 upgrade,
idempotence, organization backfill/trigger, restricted role locks, concurrent
Individual creation, consent CAS, durable reads and denied mutations.

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
