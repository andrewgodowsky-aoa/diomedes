# Development roadmap and acceptance gates

Date: September 6, 2026. Status: proposed backlog, not an implementation record. Feature IDs are local planning identifiers, not filed issues. No production schedule or effort estimate is implied.

This roadmap implements the [shared architecture](/F:/Achilles/diomedes/docs/research/2026-09-06-business-plugins/README.md) and [industry playbooks](/F:/Achilles/diomedes/docs/research/2026-09-06-business-plugins/industry-playbooks.md). It prioritizes reusable proof: both industries can assess a business before the platform attempts shared operational writes.

## Phase 0: Observe a real workflow and establish ownership

| ID | Deliverable | Exit evidence |
|---|---|---|
| D01 | Cabinetry workflow and data inventory | Walk one completed job from original estimate through manufacture/install; identify a successful case and an overrun/rework case if available |
| D02 | Restaurant workflow and data inventory | Walk one ingredient from receipt through prep/sale/count and one overnight time entry |
| D03 | Authority and identity map | Named owner for stock, recipes/BOMs, customer scope, attendance, payroll, approvals and each integration |
| D04 | Baseline and pilot scope | Recorded current reconciliation effort, capture burden, data gaps and measurable target workflow |

Ask for representative records through the client's authorized channel: exports, source field dictionaries, a material/ingredient catalog, one receipt, relevant counts, versions of an estimate/recipe and time records. Begin with synthetic or appropriately minimized data while access is being established. Do not gather unrelated employee wages or customer home information to test a stock lookup.

Output a business profile the client can correct: process, source of each fact, role responsibilities, units, allowed actions, unresolved questions and pilot success criteria. Document how much capture staff will realistically perform. A technically complete ledger will not help if its forms are too slow to use.

## Phase 1: First-party plugin skeleton and read-only assessments

| ID | Feature | Dependencies and definition of done |
|---|---|---|
| P01 | Catalog and descriptor validation | Validate plugin IDs, versions, host API, dependency graph and contribution names; reject duplicates and missing dependencies |
| P02 | Contextual contribution registry | List only enabled, authorized capabilities; load an assessment when selected or relevant; explain why it applies |
| P03 | Declarative setup and readiness | Show missing data, mapping and permission requirements per capability; demonstrations remain visibly synthetic |
| P04 | Typed evidence and findings | Consistent source IDs, revisions, timestamps, coverage, calculation version and conclusion status |
| P05 | Import staging | Parse one documented export shape per industry; preview mappings, validate units/IDs and retain source hashes; no live-system writes |
| P06 | Restaurant assessment | Reproduce the R08 quantity fixture and flag missing recipe/POS/count coverage |
| P07 | Cabinetry assessment | Preserve estimate and actuals independently; explain the five-sheet example and incomplete installation time |
| P08 | Versioned evaluation fixtures | Test numerical facts separately from language; unknown answers and scoped evidence are expected outputs |

This phase can build on the current personal desktop and file workflows. Keep imported assessments isolated and labeled by source date. Do not describe a CSV from yesterday as current stock. Provide direct structured results before adding a model explanation, so the feature remains useful without an online model.

The first plugin catalog can be a reviewed static registry shipped with the app. Do not start by implementing download servers, paid extensions, a marketplace, arbitrary scripting or a visual schema editor. Those features do not answer either pilot's initial questions.

## Phase 2: Shared operations foundation

| ID | Feature | Dependencies and definition of done |
|---|---|---|
| S01 | Business host lifecycle | Run independently of Electron; authenticated health/session handling; closing a desktop window does not stop iPad work |
| S02 | People, devices and grants | Person, organization, location/job and duty scope; revocation and shared-device switching; API and attachment enforcement |
| S03 | Operations database and migrations | One tested database target; transactions, constraints, backup/restore, initial upgrade path |
| S04 | Item/unit/location foundation | Canonical IDs, aliases, approved conversions, precision and timezone/business-date rules |
| S05 | Inventory journal and reservations | Receipt, transfer, issue, return, scrap, holds, counts and correction; atomic reservation and conservation tests |
| S06 | Time and approval foundation | Individual attribution, overlap checks, correction/amendment, version-bound approvals and separation from payroll execution |
| S07 | Protected document revisions | Binary attachment storage, hashes, release/draft state, permissions and links to operations |
| S08 | Import/connector delivery mechanics | Deduplication, source revisions, backfill, outbox, watermarks, reconciliation and visible failures |
| S09 | Tablet client | Authenticated responsive flow, foreground synchronization, current person/location, manual alternatives to scanning |
| S10 | Business action dispatcher | Same validation for UI, imports, assistants and scheduled work; authoritative context supplied by the host |

Operational plugins depend on this phase. Keep module boundaries clear inside one service. The current store's process queue is not an adequate substitute for database-level constraints and a shared authorization model.

Start with online committed operations. Add limited cached reading and a documented outage procedure. Full offline mutation is its own gate; it should not silently become a dependency for demonstrating ordinary stock entry.

## Phase 3: Complete one operational cabinetry loop

| ID | Feature | Exit evidence |
|---|---|---|
| CDEV01 | Job baseline and released package | Original estimate and customer price survive template/revision changes and completion |
| CDEV02 | Full sheets and remnants | Separate identities, dimensions, eligibility and saved-remnant confirmation |
| CDEV03 | Run issue/return/consumption | C01-C05 and C09 pass, including two devices and material conservation |
| CDEV04 | Labor and rework | C08 and C12 pass; worker time remains separate from machine/calendar duration |
| CDEV05 | Revision and site handoff | C06, C10 and C11 pass; released files and assigned-project access are enforced |
| CDEV06 | Job variance explanation | C07/C12 produce source-linked budget, actual and incomplete-data distinctions |

Use synthetic fixtures first, then run beside the existing records for the selected material/job. Reconcile each day with the shop lead. Do not transition record ownership until both the numbers and the staff workflow are accepted. Prove a full cycle including corrections and returns; a successful stock query alone is insufficient.

Add a CAD/CAM connector only after reviewing an exact representative export and documented source access. An approved file importer is a valid early deliverable. Native file editing, nesting optimization and machine control are separate future products, not implicit obligations of this plugin.

## Phase 4: Complete one operational restaurant loop

| ID | Feature | Exit evidence |
|---|---|---|
| RDEV01 | Catalog, counts and receiving | R01, R06 and R08 pass with a documented physical cutoff |
| RDEV02 | Recipe and prep lifecycle | R02/R03 pass, including remaining prepared stock and no double depletion |
| RDEV03 | One source-specific POS adapter | R04/R05/R07/R11 pass on source-shaped fixtures; actual customer access validated |
| RDEV04 | Location labor visibility | R09/R10 pass; authoritative time source and wage access defined |
| RDEV05 | Daily exception/reconciliation page | R12 passes; staff can drill from variance to sources and close an assigned investigation |

Only broaden location count or menu coverage after the first location's selected ingredients reconcile. Unmapped sales and receipts remain visible in both reports and assistant answers. New locations use their own units, recipes and business-day settings where required.

Phases 3 and 4 may proceed in parallel once shared contracts are stable and staffing supports distinct ownership. This is not a recommendation to build both complete businesses at once. Prioritize the pilot with an available operator, accessible source records and a clear pain point.

## Phase 5: Assistant actions, diagnosis and controlled automation

| ID | Feature | Exit evidence |
|---|---|---|
| A01 | Provider adapter contract | Capability negotiation, typed calls/results, timeout/cancellation and declared data routes |
| A02 | Scoped tool catalog | The same person receives the same effective permissions through UI and model calls |
| A03 | Diagnostic runner | Deterministic facts plus evidence-backed explanations, alternatives and explicit missing-data findings |
| A04 | Exact action proposals | Preview effect, revalidate relevant versions, apply authorized policy and return an auditable receipt |
| A05 | Diagnostic scheduling | Read-only bounded runs with identity, scope, deduplication, failure state, quiet unchanged results and stop control |
| A06 | Model portability evaluation | At least two supported adapters pass the same business contract suite before advertising interchangeable model support |

Assistant reads and evidence-backed explanations can begin earlier in assessment mode. This phase adds operational actions and ongoing diagnosis after records are trustworthy. A server may execute a directly authorized worker's routine entry without a second manager approval; higher-impact corrections, releases and orders use the configured business approval rules. Model-generated suggestions never count as their own approval.

Do not silently route customer data to a different provider after a failure. Choose allowed routes per customer and capability, and record the route used. Keep credentials outside plugin descriptors and prompts. An adapter failing required scope/tool tests remains read-only or unavailable for that capability.

## Phase 6: Offline capture, release operations and expansion

| ID | Feature | Exit evidence |
|---|---|---|
| O01 | Durable pending operation queue | Foreground replay, idempotency, identity binding, version conflicts, visible unsent items and tested recovery on actual iPads |
| O02 | Offline access policy | Bounded cached records, logout/revocation handling, retention rules and clear stale-stock answers |
| O03 | Plugin upgrade lifecycle | Compatibility check, migration rehearsal, configuration diff, new-capability approval and verified restore |
| O04 | Monitoring and support | Source lag, failed jobs, reconciliation gaps, storage/backup failures, request IDs and a named support owner |
| O05 | Business exports and offboarding | Export operational records with identities/revisions/units and revoke devices/connectors without losing required history |
| O06 | Additional workflows | Reordering proposals, more materials/menu items, pooled nests, finish tracking, installation sequencing and extra locations only after measured need |

Development builds may continue refreshing the developer's stable Diomedes executable. Customer installations need a separate controlled release channel. An active restaurant or cutting operation must not receive an unreviewed development build or an incompatible schema update. Show the applied host/plugin versions and provide an update window appropriate to that business.

## Shared failure and acceptance matrix

These are proposed tests, not tests run during this writeup.

| ID | Required proof |
|---|---|
| STEST01 | Parallel reservations never commit claims exceeding eligible stock. |
| STEST02 | Replayed commands/import events have one effect; changed payload with reused key is rejected. |
| STEST03 | A crash before commit leaves no partial stock/time/approval mutation; after commit a lost response is recoverable. |
| STEST04 | A changed quantity, recipe/drawing version or relevant policy invalidates a stale action approval. |
| STEST05 | Location/job restrictions hold across API, attachments, search, summaries, tools, exports and background jobs. |
| STEST06 | Shared-device identity switching cannot submit one person's draft hours as another person's work. |
| STEST07 | Unit conversions, decimal rounding and incompatible substitutions are tested at boundaries. |
| STEST08 | Late events produce a new report revision with evidence; previous published conclusions remain identifiable. |
| STEST09 | Offline availability is stale-labeled and reservations remain unconfirmed until acknowledged. |
| STEST10 | Reconnect/retry recovers pending capture without claiming guaranteed background delivery. |
| STEST11 | Unauthorized prompt instructions in a supplier file cannot access other records or call forbidden actions. |
| STEST12 | A model/provider failure leaves direct operational forms usable and never invents successful tool execution. |
| STEST13 | Missing counts, mappings or time are explicit exclusions; unknown does not become zero. |
| STEST14 | A connector timeout after possible vendor acceptance becomes unknown/pending reconciliation, not an automatic duplicate action. |
| STEST15 | Disabled plugins stop scheduled work and lose tool visibility while retained records remain exportable. |
| STEST16 | Dependency/name/version errors prevent activation with a useful explanation. |
| STEST17 | Upgrade rehearsal and restore preserve balances, decisions, attachments and source identifiers. |
| STEST18 | A stopped desktop does not stop the shared host; a host outage is visible to clients. |
| STEST19 | Sensitive fields are absent from unauthorized tool payloads, logs and generated summaries. |
| STEST20 | Timezone transitions, overnight shifts and count cutoffs produce the defined business period. |

Use unit tests for formulas, database integration tests for transactions/authorization, source contract fixtures for connectors and end-to-end tests for operator flows. Test on the intended iPad/browser fleet before claiming tablet/offline readiness. Evaluate source coverage and arithmetic mechanically; evaluate explanation quality with reviewed expected findings rather than exact phrasing alone.

## Pilot measurements and operational handover

Collect a baseline before claiming improvement. Proposed measures include time to locate/check an item, time to record a normal movement, proportion of relevant movements captured, approved labor allocation coverage, unmapped source lines, age of last count/synchronization, reconciliation time and unresolved variance with known coverage.

Example initial performance targets for validation, not promises: an ordinary server-backed stock query within two seconds at the chosen pilot load; a frequent movement entry within ten seconds after selecting/scanning the job and material. Measure model answer latency separately. Set realistic availability, backup recovery point and restoration time with the customer; then test them. No workload, SLA or staff-count requirement has been measured yet.

Do not call reduced recorded variance an improvement if recording coverage changed. Compare like periods/materials/jobs and show missing data. Staff adoption, correction burden and supervisor review time matter as much as numerical accuracy.

Before handing over the operational pilot, name the person responsible for receipts/counts, catalog changes, time review, source mapping, daily discrepancies, backups and incident response. Provide a short manual fallback for host/network failure. Practice restoring one business database and attachments. A backup file's existence is not restoration proof.

## Implementation entry point in the current repository

The first bounded implementation should add a static plugin registry, typed assessment/evidence contracts, synthetic Restaurant/Cabinetry fixtures and a read-only assessment surface. It should exercise two industries without introducing live inventory writes.

Likely integration areas, subject to a fresh code review:

- [shared types](/F:/Achilles/diomedes/shared/types.ts) for minimal shared references; new business types should live in focused modules.
- [server application](/F:/Achilles/diomedes/server/app.ts) for mounting routes through small module entry points rather than expanding the monolith.
- [team MCP implementation](/F:/Achilles/diomedes/server/team/mcp.ts) as a pattern for typed tools, not a place to append every business function.
- [integration adapter](/F:/Achilles/diomedes/server/integrations.ts) for later provider-contract extraction, after the assessment flow exists.
- [desktop lifecycle](/F:/Achilles/diomedes/desktop/main.mjs) only when shared-host connection mode is introduced.

Do not mix that first slice with migration of existing personal projects, replacement of the native adapter, a full POS connector or iPad offline support. Subsequent phases have explicit contracts and evidence gates so each change can be reviewed on its own merits.
