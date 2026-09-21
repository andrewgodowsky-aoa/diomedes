# Mobile inventory boundary

MI00 candidate; contract version 1, revision 2026-09-19.2.
Baseline: `80263205133c410d590549efd1c8f40cedf33b1c`.
Feature: `mobile-inventory-contracts`; branch: `feature/mobile-inventory-contracts`.
Worktree: `F:/Diomedes/diomedes-wt/mobile-inventory-contracts`.
Author: architect task `01a0b964-3019-73b3-8fea-855b99d51a35`, gpt-6-astra.

This is a data/intent contract and implementation boundary. It does not expose a
remote service or certify a shared login, stock writer, physical device or human
demonstration. Parsing a valid command never grants permission.

## Selected operational owner

Use one governed business host with a narrow inventory gateway. The operational
owner is the existing project `Store` and its recorded writer. A selected
organization is explicitly bound to its existing Project using the Workspaces
output-binding pattern. MI02/MI03 will use a versioned inventory document within
that bound project; callers never supply its filesystem path. Inventory balances,
operation identities and domain receipts belong to this one document, while
existing History owns recorded effects. There is no second Tasks/Runs/History
database, model loop or inventory-specific authentication service.

The pilot selects a Diomedes recorded ledger for synthetic data because no
customer inventory source has been confirmed. A future approved connector may
replace the selected authority after discovery; it must never create two writable
masters. Source kind `connected` is provenance, not permission to write to a vendor.

The shared B01 control plane retains account/membership/billing and opaque host
binding records. It does not take ownership of operational inventory or existing
Tasks/Runs/History. The narrow gateway is a consumer of B02/B03 verified identity
and current Trust, not a replacement for those producers. Its eventual device
client is the responsive Console/PWA; normal Personal startup stays local.

The existing desktop remains on loopback. Do not change its listen address,
tunnel the developer machine, expose the general desktop API, or permit shell,
arbitrary URLs, user-chosen paths or desktop administrative actions through this
gateway. Deployment and real shared access remain gated on B01-B03 and MI01.

## Existing interfaces to extend

| Responsibility | Existing source and binding | Current proof boundary |
| --- | --- | --- |
| Organization and membership | `shared/workspaces.ts`: Organization, Membership, Person, WorkspaceRef | Existing local fixtures are explicitly labeled; no production identity is inferred. |
| Organization's work target | `OutputBinding`, `resolveBriefTarget`, `server/workspaces.ts`: WorkspaceService | Configuration binds a project; it grants no stock permission. |
| Hosted subject and tenant contract | `services/control-plane/contract/contract.ts`: VerifiedSubjectMapping, MembershipAssertion, verifySubject, assertMembership | B00 pure contract, not JWT verification. A caller passing `hosted` does not authenticate itself. |
| Current authority | `server/trust/types.ts`: Authority, PrincipalRef, AuthorityClaim; `server/trust/authority.ts`: currentAuthority, refOf, requireCapability, requireGenuine | Reuse these types server-side. Baseline has no verified web-session ingress. |
| Revocation | `server/trust/revocation.ts`, WorkspaceService membership revocation | Re-resolve at admission, status/replay and immediately before effects. A stored Authority cannot restore rights. |
| Durable effect | `server/store.ts`: Store.locked, current, writeRecorded, HistoryEntry | Existing journal and expected-content hash; do not import an older Store implementation. |
| Exact write authorization | `server/trust/scope-grants.ts`, `server/approval-admission.ts` | Current grants are local text-work grants, not tenant-scoped inventory grants. H12/MI01 must prove the new consumer. |
| Run/effect reconciliation | `server/harness/run-service.ts`: RunService; existing RunStore | Uncertain effects require reconciliation; no blind second stock mutation. |
| Recorded event replay | `server/harness/routes.ts`, `server/harness/host.ts` | Existing numeric event reads plus separate H01 observer-recovery candidate. Inventory projection must not invent a run lifecycle. |

MI00's public scope uses the existing organization/tenant/project identifiers and
receipt actor uses the existing Person identifier. Commands contain only intent:
client role, actor, principal, tenant, organization and grant claims are rejected.
Server-side consumers must bind a current verified subject to the selected
organization and target, then current Trust authority. A role string alone cannot
grant an effect. No new principal or permission hierarchy is defined here.

## Data and command semantics

`shared/inventory.ts` is the versioned public schema. Quantities are safe integer
minor units with one declared scale (0-6) and base unit per item. Never use floating
point stock arithmetic or implicit conversions. Barcodes are exact strings,
preserving leading zeros. Item variants, physical sites and bins are records;
users and tablet stations are not sites. IDs are bounded opaque values, never
filesystem paths. Imports remain data and never instructions.

On-hand and reserved quantities can be unknown. Availability is null when either
input is unknown; otherwise it is their checked nonnegative difference. The pilot
can declare reservations untracked or imported/read-only. It does not implement a
reservation system. Untracked reservations cannot be projected as known zero.

Source observation, record observation, movement time and physical count time are
separate. A physical count carries explicit count evidence. Import or sync time
does not establish that someone counted stock. Counts can be stale or absent.
All timestamps admit seconds through milliseconds of precision; finer precision
is rejected so ordering and provenance comparisons cannot silently truncate it.

Receive/use/transfer quantities are positive. Adjustment sets an explicit absolute
on-hand target, including zero, and requires a reason; it is not an ambiguous
signed delta. Record-count sets an absolute nonnegative on-hand target and includes
its own count time/evidence. Only record-count changes physical-count provenance.
Corrections append a new operation referencing the prior receipt and a reason.

All commands carry an operation ID and expected source version. Transfers also
carry the destination version and must name another bin. The server checks actual
item/unit/precision, target ownership, supported action, current permissions,
reserved balances and safe arithmetic before effects. Units accepted by the
schema alone are not proof of compatibility with an item.

MI03 must persist both transfer endpoints and the operation receipt in the same
recorded write. Use `Store.locked` and `Store.writeRecorded` with exact prior hash
and `merge: false`. The domain receipt is keyed by operation ID and immutable
command digest; History records that same identity in a stable label. The response
projects the corresponding existing History entry ID rather than allocating a
second evidence identity. Recovery tests must prove that this relationship is
reconstructable after a lost response or interruption. Receipt results are never
sent as settled before the owning journal is durable.

A settled receipt contains one balance change for a single-bin action or exactly
two distinct endpoints for a transfer. Transfer endpoints share item, unit and
scale. Every change advances its version and keeps known reservations at or below
on-hand. Adjustments and corrections retain their required reason. These are
structural checks; the server still proves actual deltas against the prior ledger.

This is a bounded single-writer host design. Multi-process/distributed writers,
out-of-band edits, transaction recovery and restore must be proved or refused;
`Store.locked` by itself is not a cross-process lock. A malformed/externally altered
ledger is an actionable blocked state, not an empty inventory fallback.

An identical authorized retry returns the original receipt; changed payload under
the same ID is a conflict. Status/replay still checks current membership and read
authority. Timeout is `uncertain`, with the original operation ID for reconciliation.
No invisible offline queue or automatic retry of a potentially committed effect.

The gateway maps unauthenticated to 401, denied/revoked to 403, inaccessible/absent
objects to the existing non-disclosing 404 policy, stale versions or changed
idempotency payloads to 409 and invalid commands to 422. Explicit uncertain status
requires a subsequent operation-status read. No error is represented as success.

## Prerequisite release map

The package retains all original dependencies and full acceptance. The table is
a release *plan*, not an acceptance verdict. Each pending release needs exact
base/patch/new-file hashes, contract revision, named consumers, independent verdict
and focused evidence before those consumers perform dependent writes. The run's
`mobile-inventory-contracts/prerequisite-map.json` records immutable baseline
fingerprints and verdict references. Changes invalidate affected releases/reviews.

| Producer / named subset | Allowed consumer after independent release | Required proof | Excluded or pending |
| --- | --- | --- | --- |
| C00 and B00 full accepted contracts | MI00 | Existing accepted result records; merged b115b3c ancestry in baseline; current contract bytes | No new production cloud identity is inferred. |
| H01 current contract and durable observer replay | MI00 contract mapping, MI06; H21 preparation | Ordered persisted cursor replay, reconnect/drop/restart, no duplicate dispatch, authorization on subscriptions | Full all-route/live provider conformance remains H01 work. |
| H12 current authority and recorded stock-effect mediation | MI03, MI01, MI06 | Genuine verified principal; tenant/project/object scope; revocation immediately before effects; exact permitted write; replay/read reauthorization; uncertain outcome | Existing local scope grants and parser checks alone do not qualify. Full OS/native containment remains separate. |
| H21 single-host recorded-data/recovery subset | B01, MI02 persistence, MI03 | Journal recovery, lock ownership, interrupted write, compare-and-swap conflict, receipt/history consistency and no duplicate effects | Full all-route parity/performance and production multi-host recovery remain open. |
| B01 control-plane storage and host-binding interfaces | B02, B03, MI01 | Parameterized tenant-bound repository, migration/rollback, transaction semantics, unavailable-store refusal, no duplicate operational owner | Hosted provisioning/deployment and real DB evidence when unavailable. |
| B02 verified web identity subset | B03, MI01 | Official route verification of issuer/audience/signature/expiry/rotation; logout/revocation; no client-provided identity promotion | Fixture JWT/session tests do not establish live sign-in or physical device behavior. Full Electron callback scope remains B02. |
| B03 verified membership-to-Trust bridge | MI01, MI03, MI06 | Person/org/tenant/project binding, real membership, revocation generations, hostile cross-tenant IDs, read/status/write checks | A fixture subject or configuration role never substitutes for genuine shared identity. |
| MI00 contract revision 2026-09-19.2 | MI02 pure domain; MI03/MI04 test preparation | Independent MI00.R over the complete reconstructable candidate and contract regression suite | Does not authorize shared stock writes or imply any pending H/B release. |

No H/B subset above is released by this document. C00/B00 acceptance evidence is
in the program `results/C00.R-rollout-20260917.json` and
`results/B00.R-20260917.json`, and the package completion ledger. Both completed
prompts remain complete; other prompts stay OPEN.

## Ownership and next work

The architect owns `shared/inventory.ts` and shared app/Store/API/Shell integration.
MI02 owns catalog/import modules; MI03 ledger/commands; MI01 narrow authenticated
access; MI04 client views; MI05 scanning; MI06 consistency projection; MI07 fixture
setup; MI08 independent candidate/device qualification; MI09 human materials.
Exact claims must precede each lane, and every feature starts from this run's same
baseline with only independently accepted predecessor patches imported.

At this snapshot four Jev claims remain excluded. Adapter event recovery owns
`server/harness/host.ts` and `routes.ts`; the cache worker owns only its new pure
context-cache module, tests and architecture record. Trust review owns independent
tests, not production authority. These scopes are coordination evidence, not
permanent module ownership.

## Validation and remaining proof

Focused contract tests cover malformed/safe-integer quantities, unknown counts,
barcode identity, duplicate/reference/unit errors, source/count provenance, unsigned
client claims, transfer versions, explicit adjustment/count semantics and uncertain
effects. They exercise the exported schema and pure item-binding function.

This candidate has no model calls, server routes or persistence implementation.
No device, live login, deployed gateway, stock mutation, cross-device update or
Aaron rehearsal is claimed. MI-A01 through MI-A24 remain governed by their named
evidence tiers. Full MI-DEMO requires actual iPhone/iPad and observed human proof.
Reviewed unmerged work is not DONE. No publication or deployment occurred.
