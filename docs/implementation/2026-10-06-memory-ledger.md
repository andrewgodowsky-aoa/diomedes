# W01 memory ledger: authored, execution deferred

W01 / DIO-228 introduces a versioned, source-backed memory ledger and a local
transactional persistence candidate. Status on 2026-10-06: implementation and
regression cases authored; all execution deferred by the owner. This is not
local acceptance, a qualified adapter, or a completed roadmap item.

## Candidate and prerequisite

- Worktree: `F:/Diomedes/diomedes-wt/memory-ledger`.
- Branch: `feature/memory-ledger`.
- Current main inspected at start: `710a8c1f3b86cb6cbf82996ba9ad46869c03a1fb`.
- Reviewed W00 dependency: `b9ffd6eebaf6ebd552f488be2dffc893f73ead24`,
  [draft PR241](https://github.com/andrewgodowsky-aoa/diomedes/pull/241).
- Local prerequisite merge: `063035ed9feee446352dbf445208577d021c71d4`.
  This combines current main's canonical-document changes with W00. It contains
  no W01 implementation. W00 remains unmerged upstream.
- W01 code, tests and evidence remain uncommitted and unpublished. The worktree
  is locked to preserve this untested candidate.

At handoff inspection, main had advanced to
`6a0ec1cedc66d1163f4dc5e21974971c3ae19c2b` through PR243's Work view changes.
The inspected diff has no W01 candidate path overlap. Those changes are not
integrated or tested here; reconcile them before executable validation.

The owner explicitly asked to begin W01 while deferring tests because other
heavy testing is running or expected. That authorizes source work, not a passing
gate. No heavy-test slot was requested. The dependency on DIO-227 is retained;
starting this candidate does not mark W00 DONE or authorize W02.

Repository Pillars, Roadmap and Project Memory versions read `2026-10-06.1`.
Current main records Pillars cloud synchronization. Remaining cloud/repository
canonical divergence stays with DIO-222, separately from memory implementation.

## Authored boundaries

`shared/memory-ledger.ts` supplements the frozen W00 memory shapes. It defines
strict scoped entries, expected revisions, commands, receipts, change events,
entities, conflicts, epochs and readable versioned backups. Lifecycle and
epistemic status remain separate. No dependency was added.

`server/memory/service.ts` accepts a host-resolved tenant/workspace/scope and a
required current-epoch callback outside the ledger's backup boundary. Runtime
and Trust retain authentication, source-access and effect authority. Stored
memory cannot establish grants. The service performs no model, network or
effect calls, and no lock spans those operations.

`server/memory/store.ts` is the internal persistence port. Its raw history and
backup APIs are privileged evidence surfaces, not authorized user retrieval.
The SQLite candidate in `local-store.ts` and `schema.ts` opens only through an
explicit factory and explicit path. It is not connected to production startup,
active profiles, existing Store, RunStore, Task or Run state. Its dedicated
migration-family declaration registers ownership without migrating those stores.

## Contract decisions

1. Writes use expected-revision CAS, a stable command ID and a canonical payload
   fingerprint. The revision, outbox event and command receipt commit together.
   Exact retries return the original receipt; changed retries refuse.
2. Valid time and recorded time are independent. `replace` corrects the entire
   earlier claim; `effective-from` requires an existing claim and a known start.
   Before that start the earlier revision applies. After the new interval ends,
   the older revision does not return. Unknown bounds remain explicitly unknown.
3. Historical reads hide bodies recorded after the requested knowledge time.
   Their recorded end can still identify a later correction within the frozen
   sequence watermark. Current reads suppress old-generation bodies before
   returning them and report omission counts.
4. Dependencies pin scoped, active, operative revisions. A derivative cannot
   extend beyond known source bounds or an already-known successor's start.
   Future source changes and transitive invalidation belong to later slices.
5. Same-name entities retain separate scoped IDs. Alias lookup may be ambiguous.
   Conflicts retain both claims. Preference requires a temporal query and host
   policy order over eligible, current, source-supported claims with known
   bounds. Inference, recency, repeated mentions and ties do not create authority.
6. Identity, access and deletion generations never move backward. Empty-target
   restore requires independent current floors, preserves componentwise maxima,
   and retains current scopes absent from an older backup. Old retained evidence
   does not regain authorization. Full forgetting/purge remains W02.

## Local persistence candidate

The candidate uses built-in `node:sqlite`, scoped primary/foreign keys, immutable
history, short synchronous transactions, durable outbox positions and bounded
snapshots. Transaction handles expire on callback exit and asynchronous callbacks
refuse. Both exception rollback and abrupt-process interruption have distinct
authored tests; neither has been executed.

Default ceilings are 64 MiB database, 80 MiB WAL, 4 MiB logical transaction,
32 MiB backup, 10,000 snapshot entries and 1,000 events per outbox page. Capacity
refuses instead of pruning history. Atomic restore must fit both transaction
and backup ceilings. Larger restores require compatible explicit limits.

Only an empty version-zero store can initialize schema version one. Existing
foreign, unversioned nonempty and unknown/newer schemas refuse. Actual SQLite
definitions are compared with a fresh reference schema on explicit open;
metadata alone is insufficient. There is no fabricated legacy upgrade path.

The candidate requires SQLite 3.51.3 or newer. Driver loading, schema creation,
WAL limits, restart/crash recovery, restore, packaged Windows and macOS remain
unqualified. Historical W00 capability probes do not qualify this implementation.
See [storage design](../../evidence/memory-ledger-w01/storage-design.md).

## Evidence and review

Static inventory: 85 authored cases, 53 ledger and 32 recovery. These are source
counts, not test discovery output. Executed: **0 passed, 0 failed, 0 skipped;
85 authored cases unrun**. Typecheck, unit suites, build, browser, package,
database opens and migrations, runtime probes and provider checks: DID_NOT_RUN.
There is no executed RED or GREEN evidence for W01.

Independent source review identified stale-body exposure, revision fallback,
policy preference, stale references, recorded-time end, operative dependencies,
schema-definition validation, restore limits and successor-bound defects.
They were repaired in source with authored regression cases. The final bounded
implementation re-review found no remaining concrete finding for its targeted
fixes. Source inspection does not establish executable correctness or acceptance.
Exact reviewed files and limitations are recorded in the
[source review](../../evidence/memory-ledger-w01/source-review.md).

The [test plan](../../evidence/memory-ledger-w01/test-plan.md) maps M03-M06,
M08-M09, M28-M30 and M41-M42 to assertions and defines deferred RED/GREEN capture.
Before acceptance, freeze candidate hashes and runtime versions, obtain the
shared test slot, run the focused suites, demonstrate behavioral RED controls,
repair and rerun GREEN, complete required gates and independent review, and
record platform qualification separately. Any candidate drift invalidates
affected earlier evidence.

## Product and publication status

Pillar impact: the draft preserves Runtime/Trust and existing durable authorities;
memory is evidence rather than permission. That boundary is authored and
source-reviewed, not runtime-proven.

Roadmap impact: DIO-228 is In Progress with an untested local candidate. DIO-227
remains its upstream dependency. DIO-239 remains the separately reproduced
compaction investigation; W01 does not repair context compaction. DIO-222 remains
the canonical-divergence owner. No completion ledger or original package status
was advanced, and W02/W04 were not started.

Build/publication/deployment: none for W01. No W01 implementation commit, push,
PR, merge, installation, live migration or deployment. The earlier local
prerequisite merge is explicitly distinguished above. Native Codex Astra workers
performed bounded authoring and source reviews under the parent architect; no
outside-model route was used.

Proposed commit after validation: `feat(memory): add versioned local memory ledger`.
